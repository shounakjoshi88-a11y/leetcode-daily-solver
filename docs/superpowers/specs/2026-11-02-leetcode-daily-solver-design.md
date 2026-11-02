# Design — LeetCode Daily Solver

Date: 2026-11-02 · Owner: Shounak (full autonomy delegated; design decisions recorded here)

## Goal

Every day through 2026-12-31, an autonomous bot solves **one random LeetCode problem** from the
**entire problem pool** (~3600) and submits it to the user's account. No repeats of solved problems.
Public dashboard shows progress. Fully serverless.

## Platform decision

**Cloudflare Workers (free plan)** — chosen for native cron triggers, Workers AI (free daily LLM
allocation) and KV state in one deployable unit. Fallbacks considered: GitHub Actions + repo JSON
state, Supabase Edge Function + pg_cron. Not needed unless Cloudflare is blocked.

## Components

| Piece | Choice |
|---|---|
| Runtime | Cloudflare Worker, `src/worker.js` (single file) |
| Cron | `30 3 * * *` UTC = 09:00 IST daily |
| LLM | `@cf/qwen/qwen2.5-coder-32b-instruct`, fallback `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| State | KV namespace `STATE` |
| Auth | Secrets: `LEETCODE_SESSION`, `CSRFTOKEN`, `TRIGGER_SECRET` (guards `/run`) |

## Daily flow (scheduled handler)

1. **Gates**: IST date > 2026-12-31 → dormant. `today:<date>` exists → skip (idempotent).
2. **Pool**: KV `problems:list` (compact tuples, 7-day TTL) else fetch `/api/problems/all/`
   (with cookies, fallback anonymous). Skip premium (`paid_only`).
3. **Pick**: exclude solved slugs + anything attempted in the last 7 days; weighted random
   Easy 30% / Medium 45% / Hard 25%.
4. **Solve loop** (max 5 attempts):
   - Prompt = statement (HTML→text) + python3 starter code + failure feedback from prior attempt.
   - `POST /problems/<slug>/submit/` `{lang:"python3", question_id, typed_code}` with session
     cookie + `x-csrftoken` (endpoint discovered by inspecting LeetCode's own JS bundle; the
     `submitCode` GraphQL mutation does not exist).
   - Poll `/submissions/detail/<sid>/check/` every 5 s (≤7 polls) until `state:"FINISHED"`.
   - `Accepted` → done. Else extract `last_testcase` / `expected_output` / `code_output` /
     `runtime_error` / `compile_error` → feed to next prompt.
   - 429 on submit → back off 8 s, max 3 tries (LeetCode rate-limits back-to-back submits ~6 s apart).
5. **Persist**: `today:<date>` record, append to `history:list` (last 120), update
   `solved:list` (on success) and `attempted:map` (slug → last-attempt ms).
   A problem counts as attempted only if a submission actually went out (hard network errors
   don't consume the 7-day cooldown).

## State schema (KV)

- `problems:list` → `{fetchedAt, problems:[{q,f,s,d,p}]}` (internal id, frontend id, slug, diff 1-3, premium)
- `solved:list` → `[slug…]`
- `attempted:map` → `{slug: ms}`
- `today:<YYYY-MM-DD>` → record `{date, slug, frontendId, title, difficulty, accepted, attempts, log[], runtime, submissionId, code, error, startedAt, finishedAt}`
- `history:list` → `[record…]` (max 120)

## HTTP surface

- `GET /` — dashboard (dark, chips: solved/streak/success rate/account AC/days left/pool; today's card
  with attempt log + solution; 30-row history table).
- `GET /api/state` — JSON state.
- `POST /run?secret=…[&force=1]` — manual trigger (kicks work into `waitUntil`, returns immediately).

## Subrequest budget (free plan: 50/invocation)

Weekly list fetch (1) + GraphQL question (1) + per attempt (AI 1 + submit 1 + polls ≤7) ⇒ worst case
5 attempts ≈ 45 + extra final-burst polls only on the last attempt. KV ops are not HTTP subrequests.
Comfortable; if LeetCode judge is slow the final attempt gets a patient re-poll.

## Known risks

- **Datacenter IP + LeetCode**: submit/check endpoints usually accept session-cookie JSON from
  server IPs; if Cloudflare bot protection blocks, fall back to GitHub Actions runner path.
- **Free CPU limits**: JSON parsing kept minimal (compact cached list); awaits dominate runtime.
- **LLM success rate**: expectation ~70-85% of days Accepted (Easy/Medium weighted); failures are
  visible on the dashboard and the cooldown lets the pool keep moving.

## End of season

Cron keeps firing after 2026-12-31 but the handler no-ops (`season-over`); dashboard shows a
"Season complete" card. KV history is retained.

## Credentials handling

`LEETCODE_SESSION`/`csrftoken` extracted once via Comet + CDP `Storage.getCookies` (script:
`%TEMP%\opencode\get_cookies.py`), stored only in `%TEMP%\opencode\lc_creds.json` locally, piped
into `wrangler secret put` — never printed or committed.
