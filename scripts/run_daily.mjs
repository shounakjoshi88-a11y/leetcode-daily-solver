#!/usr/bin/env node
/**
 * LeetCode Daily Solver — GitHub Actions runner (Node 20, zero deps).
 *
 * Daily flow (see docs/superpowers/specs/2026-11-02-leetcode-daily-solver-design.md):
 *   1. gate: stop after 2026-12-31; skip if today's run already recorded (unless forced)
 *   2. load problem pool from state/problems.json (refresh weekly; seeds solved-set from AC statuses)
 *   3. pick a random unsolved problem weighted ~30% Easy / 45% Medium / 25% Hard
 *   4. solve with GitHub Models LLM (feedback loop, max 5 attempts)
 *   5. submit to leetcode.com with session cookie, poll the judge
 *   6. persist state/*.json + regenerate index.html and DASHBOARD.md (workflow commits them)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const LC = "https://leetcode.com";
const END_DATE = "2026-12-31";
const MAX_ATTEMPTS = 5;
const POLLS = 10;
const POLL_MS = 5000;
const WEEK_MS = 7 * 86400e3;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DIFF_NAMES = { 1: "Easy", 2: "Medium", 3: "Hard" };
const STATE_DIR = "state";

const env = {
  LEETCODE_SESSION: process.env.LEETCODE_SESSION || "",
  CSRFTOKEN: process.env.CSRFTOKEN || "",
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
};
const FORCE = process.env.FORCE === "1";

/* ---------------- helpers ---------------- */

function istDate(ts = Date.now()) {
  return new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lcHeaders(slug) {
  return {
    cookie: `LEETCODE_SESSION=${env.LEETCODE_SESSION}; csrftoken=${env.CSRFTOKEN}`,
    "x-csrftoken": env.CSRFTOKEN,
    "x-requested-with": "XMLHttpRequest",
    "user-agent": UA,
    referer: slug ? `${LC}/problems/${slug}/` : `${LC}/`,
    origin: LC,
    accept: "application/json, text/plain, */*",
  };
}

async function gql(query, variables) {
  const r = await fetch(`${LC}/graphql/`, {
    method: "POST",
    headers: { ...lcHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`graphql ${r.status}: ${body.slice(0, 150)}`);
  }
  const j = await r.json();
  if (j.errors) throw new Error("graphql: " + JSON.stringify(j.errors).slice(0, 200));
  return j;
}

function loadJSON(name, fallback) {
  try {
    return JSON.parse(readFileSync(`${STATE_DIR}/${name}`, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJSON(name, data) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(`${STATE_DIR}/${name}`, JSON.stringify(data));
  console.log(`[state] saved ${name}`);
}

/* ---------------- problem pool ---------------- */

/** Compact pool, refreshed weekly. When fetched with auth it also carries per-problem AC status. */
async function getProblemPool() {
  const cached = loadJSON("problems.json", null);
  if (cached?.problems?.length && Date.now() - cached.fetchedAt < WEEK_MS) {
    return cached;
  }
  let problems = null;
  for (const withAuth of [true, false]) {
    const r = await fetch(`${LC}/api/problems/all/`, {
      headers: withAuth ? lcHeaders() : { "user-agent": UA, accept: "application/json" },
    });
    console.log(`[pool] /api/problems/all/ (auth=${withAuth}) -> ${r.status}`);
    if (!r.ok) continue;
    const data = await r.json();
    problems = (data.stat_status_pairs || []).map((p) => ({
      q: p.stat.question_id,
      f: p.stat.frontend_question_id,
      s: p.stat.question__title_slug,
      d: p.difficulty.level,
      p: !!p.paid_only,
      ac: p.status === "ac",
    }));
    break;
  }
  if (!problems?.length) {
    if (cached?.problems?.length) {
      console.log("[pool] fetch failed, using stale cache");
      return cached;
    }
    throw new Error("could not fetch problem list");
  }
  const out = { fetchedAt: Date.now(), problems };
  saveJSON("problems.json", out);
  return out;
}

async function getQuestion(slug) {
  const j = await gql(
    `query q($s: String!) { question(titleSlug: $s) {
      questionId questionFrontendId title difficulty content
      codeSnippets(langSlug: "python3") { lang langSlug code }
    } }`,
    { s: slug }
  );
  const q = j.data?.question;
  if (!q) throw new Error(`question ${slug} not found or premium`);
  return q;
}

/* ---------------- submit + judge ---------------- */

async function submitSolution(slug, questionId, code) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${LC}/problems/${slug}/submit/`, {
      method: "POST",
      headers: { ...lcHeaders(slug), "content-type": "application/json" },
      body: JSON.stringify({ lang: "python3", question_id: parseInt(questionId, 10), typed_code: code }),
    });
    console.log(`[submit] ${slug} -> ${r.status}`);
    if (r.status === 429) {
      await sleep(8000);
      continue;
    }
    if (!r.ok) throw new Error(`submit ${r.status}`);
    const j = await r.json();
    if (j.submission_id) return j.submission_id;
    await sleep(5000);
  }
  throw new Error("submit: no submission id (rate limited?)");
}

async function pollVerdict(sid) {
  for (let i = 0; i < POLLS; i++) {
    await sleep(POLL_MS);
    try {
      const r = await fetch(`${LC}/submissions/detail/${sid}/check/`, { headers: lcHeaders() });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.state === "FINISHED") return j;
    } catch {
      /* transient */
    }
  }
  return null;
}

/* ---------------- AI ---------------- */

function htmlToText(html) {
  return html
    .replace(/<pre>[\s\S]*?<\/pre>/gi, (m) => "\n\n" + m.replace(/<[^>]+>/g, "") + "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function buildPrompt(statement, starter, feedback, prevCode) {
  let p =
    `Solve the following competitive programming problem in Python 3.\n\n` +
    `PROBLEM:\n${statement.slice(0, 8000)}\n\n` +
    `CODE TEMPLATE (must keep the same class and method names):\n${starter}\n\n` +
    `RULES:\n` +
    `- Output ONLY the complete Python 3 code, no markdown fences, no prose.\n` +
    `- No imports unless absolutely necessary.\n` +
    `- Add a short comment above each nontrivial line explaining what it does.\n` +
    `- Must be efficient enough to satisfy the constraints.\n`;
  if (feedback) {
    p +=
      `\nYour previous attempt FAILED the judge with this feedback:\n${feedback.slice(0, 1200)}\n\n` +
      `PREVIOUS CODE:\n${prevCode}\n\n` +
      `Return a corrected, complete solution only.\n`;
  }
  return p;
}

async function askAI(prompt) {
  const models = ["openai/gpt-4.1-mini", "deepseek/DeepSeek-V3-0324", "openai/gpt-4o-mini"];
  let lastErr = "";
  for (const model of models) {
    try {
      const r = await fetch("https://models.github.ai/inference/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "content-type": "application/json",
          "user-agent": "lc-daily-bot",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 3000,
        }),
      });
      if (!r.ok) {
        lastErr = `${model} -> ${r.status}`;
        console.log(`[ai] ${lastErr}`);
        continue;
      }
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content;
      if (text?.trim()) {
        console.log(`[ai] used ${model}`);
        return text;
      }
      lastErr = `${model} -> empty`;
    } catch (e) {
      lastErr = `${model} -> ${String(e).slice(0, 120)}`;
    }
  }
  throw new Error("all models failed: " + lastErr);
}

function extractCode(text) {
  const fence = text.match(/```(?:python|py)?\s*([\s\S]*?)```/);
  let code = fence ? fence[1] : text;
  const idx = code.indexOf("class Solution");
  if (idx > 0) code = code.slice(idx);
  if (idx === -1 && code.trim().length < 10) throw new Error("AI produced no code");
  return code.trim() + "\n";
}

function describeFailure(v) {
  if (!v) return "The judge took too long; treat this as an unknown failure and return a more robust/faster solution.";
  const parts = [];
  if (v.compile_error) parts.push("Compile error:\n" + String(v.compile_error).slice(0, 500));
  if (v.runtime_error) parts.push("Runtime error:\n" + String(v.runtime_error).slice(0, 500));
  if (v.last_testcase) parts.push("Failed input:\n" + String(v.last_testcase).slice(0, 300));
  if (v.expected_output !== undefined && v.expected_output !== null)
    parts.push("Expected output: " + String(v.expected_output).slice(0, 300));
  if (v.code_output)
    parts.push(
      "Your output: " +
        String(Array.isArray(v.code_output) ? v.code_output.join(" | ") : v.code_output).slice(0, 300)
    );
  parts.push(`Status: ${v.status_msg} (${v.total_correct}/${v.total_testcases} tests passed)`);
  return parts.join("\n");
}

/* ---------------- pick + solve ---------------- */

function pickProblem(pool, botSolved, attempted) {
  const cutoff = Date.now() - WEEK_MS;
  const byDiff = { 1: [], 2: [], 3: [] };
  for (const p of pool.problems) {
    if (p.p) continue;
    if (p.ac) continue; // already solved on the account (per latest pool fetch)
    if (botSolved.includes(p.s)) continue; // bot solved it (belt & braces)
    if (attempted[p.s] && attempted[p.s] > cutoff) continue;
    (byDiff[p.d] || byDiff[2]).push(p);
  }
  const weights = { 1: 0.3, 2: 0.45, 3: 0.25 };
  const present = [1, 2, 3].filter((d) => byDiff[d].length);
  if (!present.length) return null;
  const total = present.reduce((a, d) => a + weights[d], 0);
  let r = Math.random() * total;
  let chosen = present[0];
  for (const d of present) {
    r -= weights[d];
    if (r <= 0) {
      chosen = d;
      break;
    }
  }
  const arr = byDiff[chosen];
  return arr[Math.floor(Math.random() * arr.length)];
}

async function solveProblem(slug) {
  const q = await getQuestion(slug);
  const statement = htmlToText(q.content || "");
  const starter = (q.codeSnippets || []).find((c) => c.langSlug === "python3")?.code || "";
  console.log(`[solve] #${q.questionFrontendId} ${q.title} — statement ${statement.length} chars`);
  const logs = [];
  let feedback = null;
  let prevCode = null;
  let lastCode = null;
  let lastSid = null;
  let lastVerdict = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let aiText;
    try {
      aiText = await askAI(buildPrompt(statement, starter, feedback, prevCode));
    } catch (e) {
      logs.push({ attempt, status: "ai_error", error: String(e).slice(0, 200) });
      break;
    }
    let code;
    try {
      code = extractCode(aiText);
    } catch (e) {
      logs.push({ attempt, status: "parse_error", error: String(e).slice(0, 200) });
      feedback = "Your reply could not be parsed as code. Reply with ONLY the Python code.";
      continue;
    }
    lastCode = code;

    let sid;
    try {
      sid = await submitSolution(slug, q.questionId, code);
    } catch (e) {
      logs.push({ attempt, status: "submit_error", error: String(e).slice(0, 200) });
      break;
    }
    lastSid = sid;

    let verdict = await pollVerdict(sid);
    if (!verdict && attempt === MAX_ATTEMPTS) verdict = await pollVerdict(sid, 4);
    const accepted = verdict?.status_msg === "Accepted";
    lastVerdict = verdict;
    logs.push({
      attempt,
      status: verdict?.status_msg || "judge_timeout",
      correct: verdict?.total_correct ?? null,
      total: verdict?.total_testcases ?? null,
    });
    console.log(`[judge] attempt ${attempt}: ${verdict?.status_msg || "timeout"} (${verdict?.total_correct}/${verdict?.total_testcases})`);
    if (accepted) return { accepted: true, question: q, code, sid, verdict, logs };
    feedback = describeFailure(verdict);
    prevCode = code;
  }
  return { accepted: false, question: q, code: lastCode, sid: lastSid, verdict: lastVerdict, logs };
}

/* ---------------- dashboards ---------------- */

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function computeStreak(history) {
  const accepted = new Set(history.filter((h) => h.accepted).map((h) => h.date));
  let ts = Date.now() + 5.5 * 3600e3;
  if (!accepted.has(new Date(ts).toISOString().slice(0, 10))) ts -= 86400e3;
  let streak = 0;
  while (accepted.has(new Date(ts).toISOString().slice(0, 10))) {
    streak++;
    ts -= 86400e3;
  }
  return streak;
}

function renderHtml({ today, history, accountSolved, poolSize }) {
  const date = istDate();
  const daysLeft = Math.max(
    0,
    Math.round((new Date(END_DATE + "T00:00:00Z") - new Date(date + "T00:00:00Z")) / 86400e3)
  );
  const acceptedCount = history.filter((h) => h.accepted).length;
  const rate = history.length ? Math.round((acceptedCount / history.length) * 100) : 0;
  const streak = computeStreak(history);
  const badge = (d) =>
    d === "Easy"
      ? `<span class="b easy">Easy</span>`
      : d === "Medium"
        ? `<span class="b med">Medium</span>`
        : `<span class="b hard">Hard</span>`;

  let todayHtml;
  if (date > END_DATE) {
    todayHtml = `<div class="card"><div class="big">Season complete 🏁</div><p>The bot ran every day through ${END_DATE} and is now dormant.</p></div>`;
  } else if (today) {
    const log = (today.log || [])
      .map(
        (l) =>
          `<li>attempt ${l.attempt}: ${esc(l.status)}${l.correct != null ? ` (${l.correct}/${l.total})` : ""}${l.error ? ` — ${esc(l.error)}` : ""}</li>`
      )
      .join("");
    todayHtml = `
      <div class="card">
        <div class="k">Today · ${esc(today.date)}</div>
        <div class="big">#${esc(today.frontendId)} — ${esc(today.title)} ${badge(today.difficulty)}</div>
        <div class="verdict ${today.accepted ? "ok" : "bad"}">${today.accepted ? "✅ Accepted" : "❌ Not accepted"}${today.runtime ? ` · ${esc(today.runtime)}` : ""}${today.attempts ? ` · ${today.attempts} attempt${today.attempts > 1 ? "s" : ""}` : ""}</div>
        ${log ? `<ul class="log">${log}</ul>` : ""}
        ${today.error ? `<div class="err">${esc(today.error)}</div>` : ""}
        <div class="links">
          <a href="https://leetcode.com/problems/${esc(today.slug)}/" target="_blank" rel="noopener">problem ↗</a>
          ${today.submissionId ? ` <a href="https://leetcode.com/submissions/detail/${esc(today.submissionId)}/" target="_blank" rel="noopener">submission ↗</a>` : ""}
        </div>
        ${today.code ? `<details><summary>solution</summary><pre>${esc(today.code)}</pre></details>` : ""}
      </div>`;
  } else {
    todayHtml = `<div class="card"><div class="k">Today · ${esc(date)}</div><div class="big">No run recorded yet ⏳</div></div>`;
  }

  const rows = history
    .slice()
    .reverse()
    .slice(0, 30)
    .map(
      (h) => `<tr>
        <td>${esc(h.date)}</td>
        <td><a href="https://leetcode.com/problems/${esc(h.slug)}/" target="_blank" rel="noopener">#${esc(h.frontendId)} ${esc(h.title)}</a></td>
        <td>${badge(h.difficulty)}</td>
        <td>${h.accepted ? `<span class="ok">✅</span>` : `<span class="bad">❌</span>`}${h.attempts ? ` <span class="dim">${h.attempts}×</span>` : ""}</td>
        <td>${esc(h.runtime || "—")}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LeetCode Daily Solver</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #d7dce3; font: 15px/1.55 "Segoe UI", system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 22px; margin: 0; color: #f0f3f8; letter-spacing: .2px; }
  h1 .dot { color: #58a6ff; }
  .sub { color: #7d8590; font-size: 13.5px; margin: 4px 0 22px; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
  .chip { background: #161b22; border: 1px solid #262c36; border-radius: 10px; padding: 10px 16px; }
  .chip .n { font-size: 21px; font-weight: 700; color: #f0f3f8; }
  .chip .l { font-size: 11.5px; color: #7d8590; text-transform: uppercase; letter-spacing: .8px; }
  .card { background: #161b22; border: 1px solid #262c36; border-radius: 12px; padding: 18px 20px; margin-bottom: 22px; }
  .card .big { font-size: 19px; font-weight: 650; color: #f0f3f8; margin: 6px 0; }
  .k { font-size: 11.5px; text-transform: uppercase; letter-spacing: 1px; color: #58a6ff; }
  .verdict { margin: 8px 0 4px; }
  .ok { color: #3fb950; } .bad { color: #f85149; }
  .log { margin: 8px 0 4px; padding-left: 20px; color: #9aa4b2; font-size: 13.5px; }
  .err { color: #f85149; font-size: 13px; margin-top: 6px; overflow-wrap: anywhere; }
  .b { display: inline-block; font-size: 11.5px; border-radius: 999px; padding: 1px 10px; vertical-align: middle; }
  .easy { background: #12351f; color: #3fb950; } .med { background: #3a2b10; color: #d29922; } .hard { background: #3d1518; color: #f85149; }
  a { color: #58a6ff; text-decoration: none; } a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; color: #7d8590; font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .8px; padding: 6px 10px; border-bottom: 1px solid #262c36; }
  td { padding: 7px 10px; border-bottom: 1px solid #1c2129; }
  .dim { color: #6e7681; font-size: 12px; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: #58a6ff; font-size: 13.5px; }
  pre { background: #0d1117; border: 1px solid #262c36; border-radius: 8px; padding: 12px; overflow: auto; font: 12.5px/1.5 Consolas, monospace; color: #cdd5e0; }
  footer { color: #6e7681; font-size: 12.5px; margin-top: 30px; }
</style>
</head><body><main>
  <h1>LeetCode Daily Solver<span class="dot">_</span></h1>
  <div class="sub">One random unsolved problem every day at 9:00 AM IST, solved by AI and submitted to leetcode.com — through Dec 31, 2026. No repeats.</div>
  <div class="chips">
    <div class="chip"><div class="n">${acceptedCount}</div><div class="l">solved by bot</div></div>
    <div class="chip"><div class="n">${streak}🔥</div><div class="l">streak</div></div>
    <div class="chip"><div class="n">${rate}%</div><div class="l">success rate</div></div>
    <div class="chip"><div class="n">${accountSolved ?? "—"}</div><div class="l">total account AC</div></div>
    <div class="chip"><div class="n">${daysLeft}</div><div class="l">days remaining</div></div>
    <div class="chip"><div class="n">${poolSize ?? "—"}</div><div class="l">problem pool</div></div>
  </div>
  ${todayHtml}
  <div class="card">
    <div class="k" style="margin-bottom:8px">History</div>
    ${rows ? `<table><tr><th>Date</th><th>Problem</th><th>Diff</th><th>Result</th><th>Runtime</th></tr>${rows}</table>` : `<div class="dim">No runs yet.</div>`}
  </div>
  <footer>GitHub Actions cron 30 3 * * * UTC · GitHub Models LLM · state committed to repo</footer>
</main></body></html>`;
}

function renderMarkdown({ today, history, accountSolved, poolSize }) {
  const acceptedCount = history.filter((h) => h.accepted).length;
  const rate = history.length ? Math.round((acceptedCount / history.length) * 100) : 0;
  const streak = computeStreak(history);
  const em = { Easy: "🟢", Medium: "🟡", Hard: "🔴" };
  const line = (h) =>
    `| ${h.date} | [#${h.frontendId} ${h.title.replace(/\|/g, "\\|")}](https://leetcode.com/problems/${h.slug}/) | ${em[h.difficulty] || ""} ${h.difficulty} | ${h.accepted ? "✅" : "❌"} (${h.attempts}×) | ${h.runtime || "—"} |`;
  let md =
    `# 🤖 LeetCode Daily Solver\n\n` +
    `One random unsolved LeetCode problem a day (9:00 AM IST), solved by an LLM and submitted to the account — through Dec 31, 2026. No repeats.\n\n` +
    `| Solved by bot | Streak | Success rate | Account AC | Pool |\n|---|---|---|---|---|\n` +
    `| ${acceptedCount} | ${streak}🔥 | ${rate}% | ${accountSolved ?? "—"} | ${poolSize ?? "—"} |\n\n`;
  if (today) {
    md +=
      `## Today — ${today.date}\n\n` +
      `**#${today.frontendId} — ${today.title}** (${today.difficulty}) — ${today.accepted ? "✅ Accepted" : "❌ not accepted"}${today.runtime ? ` · ${today.runtime}` : ""} · ${today.attempts} attempt(s)\n\n` +
      `[problem](https://leetcode.com/problems/${today.slug}/)${today.submissionId ? ` · [submission](https://leetcode.com/submissions/detail/${today.submissionId}/)` : ""}\n\n`;
  }
  md += `## History\n\n| Date | Problem | Diff | Result | Runtime |\n|---|---|---|---|---|\n`;
  const last = history.slice(-20).reverse();
  md += last.length ? last.map(line).join("\n") + "\n" : "| — | no runs yet | | | |\n";
  return md;
}

/* ---------------- main ---------------- */

async function main() {
  const date = istDate();
  console.log(`[run] IST date: ${date}, force: ${FORCE}`);
  if (date > END_DATE) {
    console.log(`[run] season over (>${END_DATE}); exiting without action`);
    return;
  }

  const existing = loadJSON("today.json", null);
  if (existing?.date === date && !FORCE) {
    console.log("[run] already ran today; skipping (use force to rerun)");
    return;
  }

  const pool = await getProblemPool();
  const botSolved = loadJSON("solved.json", []);
  const attempted = loadJSON("attempted.json", {});
  const pick = pickProblem(pool, botSolved, attempted);
  if (!pick) {
    console.log("[run] no eligible problems left — pool exhausted");
    return;
  }
  console.log(`[run] picked #${pick.f} ${pick.s} (${DIFF_NAMES[pick.d]})`);

  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await solveProblem(pick.s);
  } catch (e) {
    result = { accepted: false, logs: [], error: String(e).slice(0, 300) };
  }

  const record = {
    date,
    slug: pick.s,
    frontendId: result.question?.questionFrontendId || pick.f,
    title: result.question?.title || pick.s,
    difficulty: DIFF_NAMES[pick.d],
    accepted: !!result.accepted,
    attempts: result.logs?.length || 0,
    log: result.logs || [],
    runtime: result.verdict?.runtime_display || null,
    submissionId: result.sid || null,
    code: result.code || null,
    error: result.error || null,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  console.log(`[run] RESULT ${date} ${pick.s}: ${record.accepted ? "ACCEPTED" : "FAILED"} (${record.attempts} attempts)`);

  saveJSON("today.json", record);
  const history = [...loadJSON("history.json", []), record].slice(-120);
  saveJSON("history.json", history);
  if (record.accepted && !botSolved.includes(pick.s)) botSolved.push(pick.s);
  saveJSON("solved.json", botSolved);
  if (record.attempts > 0) attempted[pick.s] = Date.now();
  saveJSON("attempted.json", attempted);

  const acCount = pool.problems.filter((p) => p.ac).length;
  writeFileSync("index.html", renderHtml({ today: record, history, accountSolved: acCount, poolSize: pool.problems.length }));
  writeFileSync("DASHBOARD.md", renderMarkdown({ today: record, history, accountSolved: acCount, poolSize: pool.problems.length }));
  console.log("[run] dashboards regenerated");
}

main().catch((e) => {
  console.error("[run] FATAL", e);
  process.exit(1);
});
