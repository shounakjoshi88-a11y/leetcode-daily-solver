# One A Day ⚡

A bot with one small promise: every day, it picks one random unsolved coding
problem, solves it with AI, and submits it to my online-judge account.

- Every morning at **9:00 AM IST**, through **Dec 31, 2026**
- Never repeats a problem, never needs me to do anything
- Failed runs are recorded too — the dashboard always shows the truth

**Live dashboard → <https://one-a-day.shounak.workers.dev/>**

## How it works (in one breath)

A Cloudflare Worker wakes up every minute and does one tiny step of the day's
job — pick a problem → solve it with `qwen2.5-coder-32b` → submit → check the
verdict → record the result — saving its progress after each step. The next
minute finishes the rest. One problem a day, everything logged publicly.
