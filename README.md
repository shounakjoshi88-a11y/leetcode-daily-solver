# LeetCode Daily Solver

Autonomous "1 LeetCode problem a day" bot. Every morning at **9:00 AM IST** it picks a **random
unsolved problem from all of LeetCode** (no repeats, premium skipped; weighted ~30% Easy /
45% Medium / 25% Hard), has an LLM solve it in Python 3, submits to leetcode.com with the user's
session, polls the judge, and **feeds failures back to the model** (max 5 attempts). Goes dormant
after **2026-12-31**.

## Two interchangeable runtimes

| | GitHub Actions (live) | Cloudflare Workers (ready) |
|---|---|---|
| Cron | `30 3 * * *` UTC workflow | `30 3 * * *` trigger |
| LLM | pollinations.ai keyless (`gpt-oss-20b` via `openai-fast`, ~45 s/IP free-tier pacing) | Workers AI (`qwen2.5-coder-32b` → `llama-3.3-70b`) |
| State | `state/*.json` committed back to the repo | KV namespace `STATE` |
| Dashboard | GitHub Pages (`index.html` + `DASHBOARD.md`) | served by the worker |
| Manual run | Actions → "Run workflow" (force checkbox) | `POST /run?secret=…` |

- **GitHub path (deployed)**: `.github/workflows/daily.yml` + `scripts/run_daily.mjs` (zero deps).
  Secrets: `LEETCODE_SESSION`, `CSRFTOKEN` (repo actions secrets).
- **Cloudflare path**: `src/worker.js` + `wrangler.jsonc` — `wrangler deploy` once logged in.

Design doc: `docs/superpowers/specs/2026-11-02-leetcode-daily-solver-design.md`
