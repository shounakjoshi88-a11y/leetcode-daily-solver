# One A Day ⚡

An autonomous bot with one small promise: **every single day it solves one random unsolved
coding problem with AI and submits it to my account** on a coding-judge site. Every morning
at **9:00 AM IST**, through **Dec 31, 2026**. No repeats, no manual steps.

- picks a random never-solved problem from the full problem pool (weighted ~30% Easy / 45% Medium / 25% Hard)
- asks an LLM for a Python 3 solution and submits it to the judge
- polls the verdict; failures get fed back to the model for another attempt (max 3)
- every run is logged publicly on the dashboard below

## Live dashboard

**<https://one-a-day.shounak.workers.dev/>** — always-true live view, rendered straight from
state on every visit. Solved chip, streak, success rate, per-day history with problem links,
verdicts and runtimes.

Static mirror (regenerated only on manual backup runs):
<https://shounakjoshi88-a11y.github.io/one-a-day/>

## How it runs

Runs on **Cloudflare Workers** (free plan) with **KV** for state and **Workers AI**
(`qwen2.5-coder-32b-instruct`) for solving.

- a cron wakes the worker **every minute**; the first tick after 03:31 UTC (09:01 IST)
  that finds no record for the day starts the run
- the free plan caps CPU time at **10 ms per invocation**, so the bot is a **step state
  machine**: each wake performs exactly one small step — pick → generate → submit → poll →
  record — saves progress to KV and exits; the next tick continues from there
- crash-safe: a failed or stalled step is force-recorded as a visible failed day, never
  silently lost; a run stuck for over an hour is force-finished
- **no repeats ever**: solved list + a 7-day attempt cooldown + a recent-solved guard
  cross-checked at pick time so stale pool data can't cause a re-pick

## In this repo

| Path | What it is |
|---|---|
| `src/worker.js` | the bot: step state machine + live dashboard |
| `wrangler.jsonc` | Worker config (KV binding, every-minute cron) |
| `state/` | problem pool + recent history mirror (the pool is fetched weekly by the backup runner) |
| `scripts/run_daily.mjs` | manual backup runner for GH Actions (zero deps) + `--render` mode that rebuilds the static dashboards from state files |
| `.github/workflows/daily.yml` | backup workflow — schedule disabled; trigger manually from the Actions tab |
| `docs/superpowers/specs/2026-11-02-one-a-day-design.md` | original design doc |

## Manual controls

- Force a run remotely: `POST /run?secret=…&force=1`
- Raw JSON state: `GET /api/state`
- Worker secrets: `LEETCODE_SESSION`, `CSRFTOKEN`, `TRIGGER_SECRET`
- Deploying changes: `wrangler login` once, then `npx wrangler deploy`
