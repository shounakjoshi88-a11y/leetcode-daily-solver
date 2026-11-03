/**
 * One A Day — autonomous daily coding-problem bot (Cloudflare Workers, free plan).
 *
 * Free-plan limits force a step-machine design: 10 ms CPU per invocation and
 * ~30 s of waitUntil after an HTTP response make a monolithic solve loop
 * impossible. So an every-minute cron drives a tiny state machine in KV:
 *
 *   idle -> pick -> ai -> submit -> poll --(Accepted)--> record -> idle
 *                                   ^                  |
 *                                   +----(failed)------+   (up to MAX_ATTEMPTS)
 *
 * Each invocation executes EXACTLY ONE small step (~1-2 ms CPU), persists
 * progress, and exits. The next cron tick (60 s later) continues. Steps are
 * idempotent and resumable, so any crash just delays the run to the next tick.
 *
 * Daily gate: first tick at/after 03:31 UTC (09:01 IST) that finds no record
 * for today's IST date starts the run. One problem per day, never repeated.
 * The problem pool comes from the GitHub repo's state/problems.json (compact,
 * already carries per-problem account-AC flags); refreshed weekly. Recent-AC
 * slugs from LeetCode are cross-checked at pick time so manually-solved
 * problems are never re-picked even when the pool file is days old.
 *
 * Bindings: STATE (KV), AI (Workers AI). Secrets: LEETCODE_SESSION, CSRFTOKEN,
 * TRIGGER_SECRET. Stops after 2026-12-31.
 */

const LC = "https://leetcode.com";
const END_DATE = "2026-12-31"; // IST date after which the bot goes dormant
const START_UTC_MIN = 3 * 60 + 31; // earliest UTC minute the daily run may start (03:31)
const MAX_ATTEMPTS = 3; // AI solve attempts per problem (Workers AI free-tier neuron budget)
const MAX_POLLS = 10; // per-minute judge polls per submission before treating it as a timeout
const WEEK_MS = 7 * 86400e3; // pool cache TTL + re-attempt cooldown
const RUN_STALE_MS = 60 * 60e3; // a run older than this is force-finished as failed
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DIFF_NAMES = { 1: "Easy", 2: "Medium", 3: "Hard" };
const POOL_REPO_URL =
  "https://raw.githubusercontent.com/shounakjoshi88-a11y/one-a-day/main/state/problems.json";

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
    "user-agent": UA,
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

/** Compact problem pool, refreshed weekly from the repo's committed pool file. */
async function getProblemPool(env) {
  const cached = await env.STATE.get("problems:list", "json");
  // 30-day TTL: the pool is a candidate list; "already solved" freshness comes
  // from the per-problem ac flags plus the recent-AC guard at pick time, so a
  // slightly stale pool is safe and a weekly refetch would just repeat work.
  if (cached?.problems?.length && Date.now() - cached.fetchedAt < 30 * 86400e3) return cached;

  let pool = null;
  try {
    const r = await fetch(POOL_REPO_URL, { headers: { "user-agent": UA }, cf: { cacheTtl: 600 } });
    if (r.ok) {
      const j = await r.json();
      // respect the repo file's own fetch date so the TTL tracks GH's refresh
      if (j?.problems?.length) pool = { fetchedAt: j.fetchedAt || Date.now(), problems: j.problems };
    }
  } catch {
    /* repo unavailable — fall through to stale KV */
  }
  if (!pool && cached?.problems?.length) {
    console.log("[pool] repo fetch failed; using stale KV pool");
    return cached;
  }
  if (!pool) throw new Error("no problem pool available");
  await env.STATE.put("problems:list", JSON.stringify(pool));
  return pool;
}

/** Slugs of the account's most recent Accepted submissions (freshness guard). */
async function getRecentAcSlugs(env) {
  try {
    const j = await gql(
      env,
      `query { matchedUser { recentAcSubmissionList(limit: 50) { titleSlug } } }`,
      {}
    );
    return (j.data?.matchedUser?.recentAcSubmissionList || []).map((s) => s.titleSlug);
  } catch {
    return []; // guard is best-effort only
  }
}

/** Question detail: statement + python3 starter code. */
async function getQuestion(env, slug) {
  const j = await gql(
    env,
    `query q($s: String!) { question(titleSlug: $s) {
      questionId questionFrontendId title difficulty content
      codeSnippets { lang langSlug code }
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

/** One judge poll. Returns the verdict object when judging reached a terminal state. */
async function checkOnce(env, sid) {
  const r = await fetch(`${LC}/submissions/detail/${sid}/check/`, { headers: lcHeaders(env) });
  if (!r.ok) return null;
  const j = await r.json();
  // LeetCode marks completed judging with state "SUCCESS" (older "FINISHED" kept for safety)
  if (j.state === "SUCCESS" || j.state === "FINISHED") return j;
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
    `- Output ONLY the complete Python 3 code, no markdown fences, no prose.\n` +
    `- No imports unless absolutely necessary.\n` +
    `- At most 5 very short comments at the trickiest lines (brevity matters — long answers get truncated).\n` +
    `- Must be efficient enough to satisfy the constraints.\n`;
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
  parts.push(`Status: ${v.status_msg} (${v.total_correct}/${v.total_testcases} tests passed)`);
  return parts.join("\n");
}

/* ---------------- pick ---------------- */

/**
 * Random pick among free + not-solved problems, weighted by difficulty
 * (~30% Easy / 45% Medium / 25% Hard). Skips problems attempted in the
 * last 7 days so a failure doesn't hog tomorrow's slot.
 */
function pickProblem(pool, solved, attempted, recentAc) {
  const cutoff = Date.now() - WEEK_MS;
  const byDiff = { 1: [], 2: [], 3: [] };
  const solvedSet = new Set([...solved, ...recentAc]);
  for (const p of pool.problems) {
    if (p.p || p.ac || solvedSet.has(p.s)) continue;
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

/* ---------------- state machine ---------------- */

async function saveRun(env, s) {
  await env.STATE.put("run:state", JSON.stringify(s));
}

/** Terminal step: persist the day's record everywhere and go idle. */
async function finishRun(env, s, extra) {
  const record = {
    date: s.date,
    slug: s.slug || null,
    frontendId: s.f || null,
    title: s.title || s.slug || null,
    difficulty: s.d ? DIFF_NAMES[s.d] : null,
    accepted: !!s.accepted,
    attempts: (s.logs || []).length,
    log: s.logs || [],
    runtime: s.runtime || null,
    submissionId: s.sid || null,
    code: s.code || null,
    error: s.error || null,
    startedAt: s.startedAt,
    finishedAt: new Date().toISOString(),
    ...extra,
  };

  const solved = (await env.STATE.get("solved:list", "json")) || [];
  const attempted = (await env.STATE.get("attempted:map", "json")) || {};
  if (record.attempts > 0 && record.slug) attempted[record.slug] = Date.now();
  if (record.accepted && record.slug && !solved.includes(record.slug)) solved.push(record.slug);

  const ops = [env.STATE.put(`today:${s.date}`, JSON.stringify(record))];
  ops.push(env.STATE.put("attempted:map", JSON.stringify(attempted)));
  ops.push(env.STATE.put("solved:list", JSON.stringify(solved)));
  ops.push(
    env.STATE.get("history:list", "json").then((h) =>
      env.STATE.put("history:list", JSON.stringify([...(h || []), record].slice(-120)))
    )
  );
  ops.push(env.STATE.delete("run:state"));
  await Promise.all(ops);
  console.log(`[run] ${s.date} ${s.slug} -> ${record.accepted ? "ACCEPTED" : "failed"} (${record.attempts} attempts)`);
}

/** Execute exactly one machine step. `s` is the persisted run-state. */
async function step(env, s) {
  // stale-run guard: a run stuck for over an hour is force-finished
  if (Date.now() - new Date(s.startedAt).getTime() > RUN_STALE_MS && s.phase !== "record") {
    s.error = `run stalled in phase ${s.phase}; force-finished`;
    console.log(`[run] stale: ${s.error}`);
    await finishRun(env, s, {});
    return;
  }

  switch (s.phase) {
    case "pick": {
      const pool = await getProblemPool(env);
      const solved = (await env.STATE.get("solved:list", "json")) || [];
      const attempted = (await env.STATE.get("attempted:map", "json")) || {};
      const recentAc = await getRecentAcSlugs(env);
      const pick = pickProblem(pool, solved, attempted, recentAc);
      if (!pick) {
        s.error = "no eligible problems left — pool exhausted";
        s.phase = "record";
        await saveRun(env, s);
        return;
      }
      const q = await getQuestion(env, pick.s);
      s.slug = pick.s;
      s.f = q.questionFrontendId ?? pick.f;
      s.title = q.title;
      s.d = pick.d;
      s.qid = q.questionId;
      s.statement = htmlToText(q.content || "").slice(0, 9000);
      s.starter = (q.codeSnippets || []).find((c) => c.langSlug === "python3")?.code || "";
      s.logs = [];
      s.attempt = 1;
      s.phase = "ai";
      console.log(`[run] ${s.date} picked #${s.f} ${s.slug} (${DIFF_NAMES[s.d]})`);
      await saveRun(env, s);
      return;
    }

    case "ai": {
      let text;
      try {
        text = await askAI(env, buildPrompt(s.statement, s.starter, s.feedback, s.prevCode));
        s.code = extractCode(text);
      } catch (e) {
        const msg = String(e).slice(0, 250);
        s.logs.push({ attempt: s.attempt, status: /no code|parse/i.test(msg) ? "parse_error" : "ai_error", error: msg });
        console.log(`[run] ai error on attempt ${s.attempt}: ${msg}`);
        s.phase = s.attempt >= MAX_ATTEMPTS ? "record" : "ai";
        s.attempt = s.attempt >= MAX_ATTEMPTS ? s.attempt : s.attempt + 1;
        await saveRun(env, s);
        return;
      }
      s.phase = "submit";
      await saveRun(env, s);
      return;
    }

    case "submit": {
      try {
        s.sid = await submitSolution(env, s.slug, s.qid, s.code);
      } catch (e) {
        const msg = String(e).slice(0, 250);
        s.logs.push({ attempt: s.attempt, status: "submit_error", error: msg });
        console.log(`[run] submit error: ${msg}`);
        s.phase = "record";
        await saveRun(env, s);
        return;
      }
      s.prevCode = s.code;
      s.polls = 0;
      s.phase = "poll";
      console.log(`[run] submitted attempt ${s.attempt} sid=${s.sid}`);
      await saveRun(env, s);
      return;
    }

    case "poll": {
      let verdict = null;
      try {
        verdict = await checkOnce(env, s.sid);
      } catch {
        verdict = null;
      }
      if (!verdict) {
        s.polls = (s.polls || 0) + 1;
        if (s.polls < MAX_POLLS) {
          await saveRun(env, s); // stay in poll; next tick re-checks
          return;
        }
        s.logs.push({ attempt: s.attempt, status: "judge_timeout" });
        s.feedback = describeFailure(null);
        s.accepted = false;
        if (s.attempt >= MAX_ATTEMPTS) {
          s.phase = "record";
        } else {
          s.attempt++;
          s.phase = "ai";
        }
        await saveRun(env, s);
        return;
      }
      const accepted = verdict?.status_msg === "Accepted";
      s.runtime = verdict?.runtime_display || null;
      s.logs.push({
        attempt: s.attempt,
        status: verdict?.status_msg || "unknown",
        correct: verdict?.total_correct ?? null,
        total: verdict?.total_testcases ?? null,
      });
      console.log(`[run] judge attempt ${s.attempt}: ${verdict?.status_msg} (${verdict?.total_correct}/${verdict?.total_testcases})`);
      if (accepted) {
        s.accepted = true;
        s.phase = "record";
      } else {
        s.feedback = describeFailure(verdict);
        s.accepted = false;
        if (s.attempt >= MAX_ATTEMPTS) s.phase = "record";
        else {
          s.attempt++;
          s.phase = "ai";
        }
      }
      await saveRun(env, s);
      return;
    }

    case "record": {
      await finishRun(env, s, {});
      return;
    }

    default: {
      s.error = `unknown phase ${s.phase}; force-finished`;
      console.log(`[run] ${s.error}`);
      await finishRun(env, s, {});
      return;
    }
  }
}

/** Called by the cron and by /run. Starts a run when the day's gate allows. */
async function tick(env, force = false) {
  const date = istDate();
  if (date > END_DATE) return { skipped: "season-over", date };

  const existing = await env.STATE.get("run:state", "json");
  if (existing) {
    await step(env, existing);
    return { stepped: existing.phase, date };
  }

  const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const todayRecord = await env.STATE.get(`today:${date}`, "json");
  if (todayRecord && !force) return { skipped: "already-ran-today", date };
  if (nowMin < START_UTC_MIN && !force) return { skipped: "before-03:31-utc", date };

  const s = {
    date,
    phase: "pick",
    startedAt: new Date().toISOString(),
    logs: [],
  };
  await env.STATE.put("run:state", JSON.stringify(s));
  console.log(`[run] ${date} run started (force=${force})`);
  return { started: true, date };
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
<title>One A Day</title>
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
  <h1>One A Day<span class="dot">_</span></h1>
  <div class="sub">One random unsolved coding problem every day at 9:00 AM IST, solved by AI and submitted to my online-judge account — through Dec 31, 2026. No repeats.</div>

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

  <footer>Cloudflare Workers · Workers AI · KV state machine · cron every minute (daily gate 03:31 UTC)</footer>
</main></body></html>`;
}

/* ---------------- handlers ---------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async scheduled(event, env, ctx) {
    // every minute: one small step; never let an exception kill the tick
    try {
      await tick(env, false);
    } catch (e) {
      console.error("[tick] failed:", String(e).slice(0, 300));
      // if a step blew up, mark the run so the next tick force-finishes it
      try {
        const s = await env.STATE.get("run:state", "json");
        if (s && !s.error) {
          s.error = `step error in ${s.phase}: ${String(e).slice(0, 200)}`;
          s.phase = s.phase === "record" ? "record" : "record";
          await env.STATE.put("run:state", JSON.stringify(s));
        }
      } catch {
        /* nothing more we can do this tick */
      }
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      if (request.method !== "POST") return json({ error: "use POST" }, 405);
      const secret = url.searchParams.get("secret") || request.headers.get("x-trigger-secret");
      if (!env.TRIGGER_SECRET || secret !== env.TRIGGER_SECRET) return json({ error: "forbidden" }, 403);
      const force = url.searchParams.get("force") === "1";
      // queue the run; the next cron tick executes steps (free-plan safe)
      const res = await tick(env, force).catch((e) => ({ error: String(e).slice(0, 200) }));
      return json(res);
    }

    if (url.pathname === "/api/state") {
      const date = istDate();
      try {
        const [today, history, solved, problems, run] = await Promise.all([
          env.STATE.get(`today:${date}`, "json"),
          env.STATE.get("history:list", "json"),
          env.STATE.get("solved:list", "json"),
          env.STATE.get("problems:list", "json"),
          env.STATE.get("run:state", "json"),
        ]);
        return json({
          date,
          endDate: END_DATE,
          today,
          history: history || [],
          accountSolved: (solved || []).length,
          poolSize: problems?.problems?.length ?? null,
          run: run ? { phase: run.phase, slug: run.slug, attempt: run.attempt } : null,
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
