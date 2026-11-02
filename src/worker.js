/**
 * LeetCode Daily Solver — autonomous "1 problem a day" bot.
 *
 * Every morning (09:00 IST cron) it:
 *   1. loads the full LeetCode problem list (cached in KV, refreshed weekly),
 *   2. filters to free, unsolved problems and picks one at random
 *      (weighted ~30% Easy / 45% Medium / 25% Hard),
 *   3. asks Workers AI to solve it in Python 3,
 *   4. submits to leetcode.com with the user's session and polls the judge,
 *   5. feeds judge failures back to the model and retries (max 5 attempts),
 *   6. records everything in KV; a public dashboard shows the results.
 *
 * Never repeats a solved problem. Stops after 2026-12-31.
 *
 * Bindings: STATE (KV), AI (Workers AI), secrets LEETCODE_SESSION, CSRFTOKEN, TRIGGER_SECRET.
 */

const LC = "https://leetcode.com";
const END_DATE = "2026-12-31"; // IST date after which the bot goes dormant
const MAX_ATTEMPTS = 5; // AI solve attempts per problem
const POLLS = 7; // judge polls per submission (POLL_MS apart)
const POLL_MS = 5000;
const WEEK_MS = 7 * 86400e3; // problem-list cache TTL + re-attempt cooldown
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DIFF_NAMES = { 1: "Easy", 2: "Medium", 3: "Hard" };

/* ---------------- time helpers ---------------- */

/** Current date in IST as "YYYY-MM-DD". */
function istDate(ts = Date.now()) {
  return new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- leetcode API ---------------- */

function lcHeaders(env, slug) {
  return {
    cookie: `LEETCODE_SESSION=${env.LEETCODE_SESSION}; csrftoken=${env.CSRFTOKEN}`,
    "x-csrftoken": env.CSRFTOKEN,
    "x-requested-with": "XMLHttpRequest",
    "user-agent": USER_AGENT,
    referer: slug ? `${LC}/problems/${slug}/` : `${LC}/`,
    origin: LC,
    accept: "application/json, text/plain, */*",
  };
}

async function gql(env, query, variables) {
  const r = await fetch(`${LC}/graphql/`, {
    method: "POST",
    headers: { ...lcHeaders(env), "content-type": "application/json" },
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

/** Full problem list, cached in KV for a week. Compact tuples to keep KV small. */
async function getProblemList(env) {
  const cached = await env.STATE.get("problems:list", "json");
  if (cached && cached.problems?.length && Date.now() - cached.fetchedAt < WEEK_MS) {
    return cached.problems;
  }
  let problems = null;
  for (const withAuth of [true, false]) {
    const r = await fetch(`${LC}/api/problems/all/`, {
      headers: withAuth ? lcHeaders(env) : { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!r.ok) continue;
    const data = await r.json();
    problems = (data.stat_status_pairs || []).map((p) => ({
      q: p.stat.question_id, // internal id (used by the submit endpoint)
      f: p.stat.frontend_question_id, // the #N users see
      s: p.stat.question__title_slug,
      d: p.difficulty.level, // 1 Easy, 2 Medium, 3 Hard
      p: !!p.paid_only, // premium problems are skipped
    }));
    break;
  }
  if (!problems || !problems.length) {
    if (cached?.problems?.length) return cached.problems;
    throw new Error("could not fetch problem list");
  }
  await env.STATE.put("problems:list", JSON.stringify({ fetchedAt: Date.now(), problems }));
  return problems;
}

/** Question detail: statement + python3 starter code. */
async function getQuestion(env, slug) {
  const j = await gql(
    env,
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

/** Submit python3 code; returns submission id. Retries briefly on 429. */
async function submitSolution(env, slug, questionId, code) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${LC}/problems/${slug}/submit/`, {
      method: "POST",
      headers: { ...lcHeaders(env, slug), "content-type": "application/json" },
      body: JSON.stringify({ lang: "python3", question_id: parseInt(questionId, 10), typed_code: code }),
    });
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

/** Poll the judge until FINISHED or we run out of patience. */
async function pollVerdict(env, sid, polls = POLLS) {
  for (let i = 0; i < polls; i++) {
    await sleep(POLL_MS);
    try {
      const r = await fetch(`${LC}/submissions/detail/${sid}/check/`, { headers: lcHeaders(env) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.state === "FINISHED") return j;
    } catch {
      /* transient; keep polling */
    }
  }
  return null;
}

/* ---------------- AI solving ---------------- */

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
    `- Output ONLY the complete Python 3 code, with no markdown fences and no explanations outside code.\n` +
    `- No imports unless absolutely necessary.\n` +
    `- Add a short comment above each nontrivial line explaining what it does.\n` +
    `- The solution must be efficient enough to satisfy the constraints (avoid naive O(n^2) when n is large).\n`;
  if (feedback) {
    p +=
      `\nYour previous attempt FAILED the judge with this feedback:\n${feedback.slice(0, 1200)}\n\n` +
      `PREVIOUS CODE:\n${prevCode}\n\n` +
      `Return a corrected, complete solution only.\n`;
  }
  return p;
}

async function askAI(env, prompt) {
  const models = ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
  let lastErr = null;
  for (const model of models) {
    try {
      const res = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 3000,
      });
      const text = res.response || res.result?.response || "";
      if (text && text.trim()) return text;
      lastErr = new Error("empty AI response");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("AI failed");
}

function extractCode(text) {
  const fence = text.match(/```(?:python|py)?\s*([\s\S]*?)```/);
  let code = fence ? fence[1] : text;
  const idx = code.indexOf("class Solution");
  if (idx > 0) code = code.slice(idx);
  if (idx === -1 && code.trim().length < 10) throw new Error("AI produced no code");
  return code.trim() + "\n";
}

/** Human-readable failure summary to feed back to the model. */
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
  parts.push(
    `Status: ${v.status_msg} (${v.total_correct}/${v.total_testcases} tests passed)`
  );
  return parts.join("\n");
}

/* ---------------- pick + solve ---------------- */

/**
 * Random pick among free + unsolved problems, weighted by difficulty
 * (~30% Easy / 45% Medium / 25% Hard). Skips problems attempted in the
 * last 7 days so a failure doesn't hog tomorrow's slot.
 */
function pickProblem(problems, solved, attempted) {
  const cutoff = Date.now() - WEEK_MS;
  const byDiff = { 1: [], 2: [], 3: [] };
  const solvedSet = new Set(solved);
  for (const p of problems) {
    if (p.p || solvedSet.has(p.s)) continue;
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
  return byDiff[chosen][Math.floor(Math.random() * byDiff[chosen].length)];
}

/**
 * The solve loop: up to MAX_ATTEMPTS, feeding judge feedback between tries.
 * Returns { accepted, question, code, sid, verdict, logs }.
 */
async function solveProblem(env, slug) {
  const q = await getQuestion(env, slug);
  const statement = htmlToText(q.content || "");
  const starter = (q.codeSnippets || []).find((c) => c.langSlug === "python3")?.code || "";
  const logs = [];
  let feedback = null;
  let prevCode = null;
  let lastCode = null;
  let lastSid = null;
  let lastVerdict = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let aiText;
    try {
      aiText = await askAI(env, buildPrompt(statement, starter, feedback, prevCode));
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
      sid = await submitSolution(env, slug, q.questionId, code);
    } catch (e) {
      logs.push({ attempt, status: "submit_error", error: String(e).slice(0, 200) });
      break; // submit endpoint is failing; don't burn more attempts
    }
    lastSid = sid;

    let verdict = await pollVerdict(env, sid);
    if (!verdict && attempt === MAX_ATTEMPTS) {
      verdict = await pollVerdict(env, sid, 3); // one last patient check
    }
    const accepted = verdict?.status_msg === "Accepted";
    lastVerdict = verdict;
    logs.push({
      attempt,
      status: verdict?.status_msg || "judge_timeout",
      correct: verdict?.total_correct ?? null,
      total: verdict?.total_testcases ?? null,
    });
    if (accepted) {
      return { accepted: true, question: q, code, sid, verdict, logs };
    }
    feedback = describeFailure(verdict);
    prevCode = code;
  }
  return { accepted: false, question: q, code: lastCode, sid: lastSid, verdict: lastVerdict, logs };
}

/* ---------------- daily orchestration ---------------- */

/**
 * One day's full run. Idempotent per IST date unless force=true.
 */
async function runDaily(env, force = false) {
  const date = istDate();
  if (date > END_DATE) return { skipped: "season-over", date };

  if (!force) {
    const existing = await env.STATE.get(`today:${date}`, "json");
    if (existing) return { skipped: "already-ran-today", today: existing };
  }

  const startedAt = new Date().toISOString();
  const problems = await getProblemList(env);
  const solved = (await env.STATE.get("solved:list", "json")) || [];
  const attempted = (await env.STATE.get("attempted:map", "json")) || {};
  const pick = pickProblem(problems, solved, attempted);
  if (!pick) return { skipped: "pool-exhausted", date };

  console.log(`[lc-daily] ${date} picked ${pick.s} (${DIFF_NAMES[pick.d]}, #${pick.f})`);

  let result;
  try {
    result = await solveProblem(env, pick.s);
  } catch (e) {
    result = { accepted: false, logs: [], error: String(e).slice(0, 300) };
  }
  console.log(`[lc-daily] ${date} ${pick.s} -> ${result.accepted ? "ACCEPTED" : "failed"}`);

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

  // persist state
  const ops = [env.STATE.put(`today:${date}`, JSON.stringify(record))];
  // only count a problem as "attempted" if we actually submitted at least once
  if (record.attempts > 0) attempted[pick.s] = Date.now();
  if (result.accepted && !solved.includes(pick.s)) solved.push(pick.s);
  ops.push(env.STATE.put("attempted:map", JSON.stringify(attempted)));
  ops.push(env.STATE.put("solved:list", JSON.stringify(solved)));
  ops.push(
    env.STATE.get("history:list", "json").then((h) =>
      env.STATE.put(
        "history:list",
        JSON.stringify([...(h || []), record].slice(-120))
      )
    )
  );
  await Promise.all(ops);

  return record;
}

/* ---------------- dashboard ---------------- */

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

function renderDashboard({ today, history, solvedCount, problemsCount }) {
  const now = new Date();
  const date = istDate(now.getTime());
  const daysLeft = Math.max(
    0,
    Math.round((new Date(END_DATE + "T00:00:00Z") - new Date(date + "T00:00:00Z")) / 86400e3)
  );
  const acceptedCount = history.filter((h) => h.accepted).length;
  const rate = history.length ? Math.round((acceptedCount / history.length) * 100) : 0;
  const streak = computeStreak(history);
  const seasonOver = date > END_DATE;

  const badge = (d) =>
    d === "Easy"
      ? `<span class="b easy">Easy</span>`
      : d === "Medium"
        ? `<span class="b med">Medium</span>`
        : `<span class="b hard">Hard</span>`;

  let todayHtml;
  if (seasonOver) {
    todayHtml = `<div class="card today"><div class="big">Season complete 🏁</div><p>The bot ran every day through ${END_DATE} and is now dormant.</p></div>`;
  } else if (today) {
    const log = (today.log || [])
      .map(
        (l) =>
          `<li>attempt ${l.attempt}: ${esc(l.status)}${
            l.correct != null ? ` (${l.correct}/${l.total})` : ""
          }${l.error ? ` — ${esc(l.error)}` : ""}</li>`
      )
      .join("");
    todayHtml = `
      <div class="card today">
        <div class="k">Today · ${esc(today.date)}</div>
        <div class="big">#${esc(today.frontendId)} — ${esc(today.title)} ${badge(today.difficulty)}</div>
        <div class="verdict ${today.accepted ? "ok" : "bad"}">${today.accepted ? "✅ Accepted" : "❌ Not accepted"}${
          today.runtime ? ` · ${esc(today.runtime)}` : ""
        }${today.attempts ? ` · ${today.attempts} attempt${today.attempts > 1 ? "s" : ""}` : ""}</div>
        ${log ? `<ul class="log">${log}</ul>` : ""}
        ${today.error ? `<div class="err">${esc(today.error)}</div>` : ""}
        <div class="links">
          <a href="https://leetcode.com/problems/${esc(today.slug)}/" target="_blank" rel="noopener">problem ↗</a>
          ${
            today.submissionId
              ? ` <a href="https://leetcode.com/submissions/detail/${esc(today.submissionId)}/" target="_blank" rel="noopener">submission ↗</a>`
              : ""
          }
        </div>
        ${
          today.code
            ? `<details><summary>solution</summary><pre>${esc(today.code)}</pre></details>`
            : ""
        }
      </div>`;
  } else {
    todayHtml = `<div class="card today"><div class="k">Today · ${esc(date)}</div><div class="big">Waiting for the 9:00 AM IST run ⏳</div></div>`;
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
<meta http-equiv="refresh" content="600">
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
  .today .big { font-size: 19px; font-weight: 650; color: #f0f3f8; margin: 6px 0; }
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
    <div class="chip"><div class="n">${solvedCount}</div><div class="l">total account AC</div></div>
    <div class="chip"><div class="n">${daysLeft}</div><div class="l">days remaining</div></div>
    <div class="chip"><div class="n">${problemsCount ?? "—"}</div><div class="l">problem pool</div></div>
  </div>

  ${todayHtml}

  <div class="card">
    <div class="k" style="margin-bottom:8px">History</div>
    ${
      rows
        ? `<table><tr><th>Date</th><th>Problem</th><th>Diff</th><th>Result</th><th>Runtime</th></tr>${rows}</table>`
        : `<div class="dim">No runs yet — first run fires at 9:00 AM IST (or via POST /run).</div>`
    }
  </div>

  <footer>Cloudflare Workers · Workers AI · KV state · cron 30 3 * * * UTC</footer>
</main></body></html>`;
}

/* ---------------- fetch handler ---------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runDaily(env).catch((e) => console.error("[lc-daily] cron failed:", String(e)))
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      if (request.method !== "POST") return json({ error: "use POST" }, 405);
      const secret = url.searchParams.get("secret") || request.headers.get("x-trigger-secret");
      if (!env.TRIGGER_SECRET || secret !== env.TRIGGER_SECRET) return json({ error: "forbidden" }, 403);
      const force = url.searchParams.get("force") === "1";
      ctx.waitUntil(
        runDaily(env, force).catch((e) => console.error("[lc-daily] manual run failed:", String(e)))
      );
      return json({ started: true, date: istDate(), forced: force });
    }

    if (url.pathname === "/api/state") {
      const date = istDate();
      try {
        const [today, history, solved, problems] = await Promise.all([
          env.STATE.get(`today:${date}`, "json"),
          env.STATE.get("history:list", "json"),
          env.STATE.get("solved:list", "json"),
          env.STATE.get("problems:list", "json"),
        ]);
        return json({
          date,
          endDate: END_DATE,
          today,
          history: history || [],
          accountSolved: (solved || []).length,
          poolSize: problems?.problems?.length ?? null,
        });
      } catch (e) {
        return json({ error: String(e).slice(0, 200) }, 500);
      }
    }

    // dashboard
    try {
      const date = istDate();
      const [today, history, solved, problems] = await Promise.all([
        env.STATE.get(`today:${date}`, "json"),
        env.STATE.get("history:list", "json"),
        env.STATE.get("solved:list", "json"),
        env.STATE.get("problems:list", "json"),
      ]);
      const html = renderDashboard({
        today,
        history: history || [],
        solvedCount: (solved || []).length,
        problemsCount: problems?.problems?.length ?? null,
      });
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      return new Response("dashboard error: " + String(e), { status: 500 });
    }
  },
};
