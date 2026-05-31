# AI CFO — Architecture

The CFO layer turns the existing accounting commands into a recurring "finance heartbeat"
with a permanent user-gated boundary. It **composes** the working pieces — it does not
replace them. Full design history: `~/.claude/plans/project-ai-cfo-agent-velvet-bee.md`.

## Where each concern lives

| Concern | Home |
|---|---|
| Reusable domain logic (classify/extract/match) | `swedish-invoice-tools/skills/*` (the engine, unchanged) |
| Accounting **facts** (classified/paid/sent/closed) | Drive `state.md` per month (authoritative) |
| Run **orchestration** (last-run, todo dedup, export status) | `cfo-state.json` (tiny; local + Drive mirror) |
| Standing **policy** (urgency, cadence, autonomy flag, anomalies) | `nilsark/skills/cfo-policy/` |
| Bookkeeper handoff (attachments + filename list) | `nilsark/skills/bookkeeping/` |
| Judgment + delegation + gate | `nilsark/agents/cfo.md` + `nilsark/commands/cfo-run.md` |
| Secrets / addresses / paths | `~/.nilsark-config.md` |

**Anti-divergence rule:** `sent / paid / closed` is read from `state.md`; `cfo-state.json`
holds only `last_run`, `todo_last_emitted`, `export_status`. Never duplicate facts into JSON.

## The heartbeat (`/cfo-run`)

1. Load config + `cfo-policy` + `cfo-state.json`.
2. **Collect + classify + match** → `/fetch-classify` (autonomous).
3. **Refresh payments** → `/payments-due` logic (overdue detection).
4. **Anomaly scan** → `cfo-policy` rules on docs classified this run → `flags[]`.
5. **Prepare bookkeeper draft** → only near month-end **and** export reconciled **and** not
   closed → delegate to `/month-close` (the single draft producer).
6. **APPROVE status** → drafts created but still in Gmail Drafts = awaiting the user's send.
7. **Todo** (PAY / EXPORT / APPROVE, urgency-sorted) → stdout + Drive `.nilsark/todo-DATE.md` + **sent to `MY_EMAIL`**.
8. Persist `cfo-state.json` (local + Drive mirror).

## The email & action rules

Governed by **instruction** (`cfo-policy` `autonomy_level: instruction-gated`), not a
capability lock:

- **Fortnox / bookkeeper emails → always a DRAFT** (`gws gmail +send --draft`). Never sent;
  the user spot-checks and sends.
- **Self-notifications → SENT, only to `MY_EMAIL`** (`gws gmail +send`): the todo.
  Sender = receiver.
- **Never send to any other recipient; never PAY; never do BankID** — those are user-only,
  surfaced in the todo.

The one place to change this (e.g. allow auto-send of the handoff) is `cfo-policy`.

## Cadence

- **Heartbeat** (weekly/biweekly): `/cfo-run` — collect + PAY todo (+ EXPORT near close), emailed to you.
- **Monthly close**: `/month-close` — one draft per document type (attachments + filename list), marks closed.

The user runs `/cfo-run` manually; a wrapper script can mail its output if scheduled.

## Roadmap

Tracked in the repo's GitHub issues (label `cfo-roadmap`), not here.
