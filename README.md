# LeetCode Daily Solver

Autonomous "1 LeetCode problem a day" bot on **Cloudflare Workers** (free tier).

- **Cron** 09:00 IST daily (`30 3 * * *` UTC) → picks a **random unsolved problem from all of LeetCode** (no repeats, premium skipped), weighted ~30% Easy / 45% Medium / 25% Hard.
- **Workers AI** (`qwen2.5-coder-32b`, fallback `llama-3.3-70b`) solves it in Python 3.
- Submits via LeetCode's web API with the user's session, polls the judge, and **feeds failures back to the model** (max 5 attempts).
- State in **KV**: solved-slug set, attempt map (7-day retry cooldown), history.
- Public **dashboard** at the worker URL; `GET /api/state` for JSON; `POST /run?secret=…` for manual runs.
- Goes dormant after **2026-12-31**.

## Layout

- `src/worker.js` — everything: cron, solve loop, dashboard.
- `wrangler.jsonc` — bindings (KV `STATE`, AI, cron).

## Setup / runbook

```powershell
wrangler login
wrangler kv namespace create STATE      # paste the id into wrangler.jsonc
wrangler deploy
wrangler secret put LEETCODE_SESSION    # value from browser cookies
wrangler secret put CSRFTOKEN
wrangler secret put TRIGGER_SECRET      # random hex, guards /run
```

Manual run: `POST https://leetcode-daily-solver.<subdomain>.workers.dev/run?secret=<TRIGGER_SECRET>`

Design doc: `docs/superpowers/specs/2026-11-02-leetcode-daily-solver-design.md`
