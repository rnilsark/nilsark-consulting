# Second-brain agent — design idea (future)

> Status: **proposal / not built.** Captured as a future direction for the Doppelgänger runtime.

A long-lived "second brain" role: remember things, gather and link context over time, and
handle personal logistics (gifts, parties, planning). It resurfaces what matters before it
slips, rather than only answering when asked.

## Fit with the runtime

Every existing agent (`triage`, `chat`, `planner`, `entrepreneur`) is **stateless and
single-shot**: a trigger enqueues work, the worker spawns `claude -p`, the agent reads its
injected prompt, writes `out.json` (`status` / `summary` / `orders` / `replies`), and dies.
Two trigger sources exist: **chat** (triage → chat → scoped leaf) and **schedule** (cron).

A second brain inverts that — its value is *durable, accreting* memory. So the design work is
about **where memory lives** and **how it resurfaces**, not the agent loop (already solved).
The agent itself stays stateless; the memory lives in an external store, exactly as the
`entrepreneur` keeps its accounting state outside the process.

## Storage — Google Tasks (not the orchestration DB)

Domain knowledge does **not** go in `doppelganger.db` — that database is orchestration-only
(queue, events, chat log, outbox). The established pattern is "the agent owns an external
store." Here that store is **Google Tasks**:

- **One task list per project/topic**, with a fixed prefix so the agent only ever touches its
  own lists (e.g. `SB · Gifts`, `SB · <event>`, `SB · Remember`).
- **Each item = a task.** Free-form context lives in the task's `notes` field, appended over
  time via `patch`. Date-bound items set `due`. Checklist steps become subtasks under a parent.
- The only local crumb is a tiny `state.json` under the agent's home dir for pulse
  idempotency (last-push date), mirroring how the `entrepreneur` keeps a thin local state file.

### Why Tasks over Keep

The Google **Tasks** API is full CRUD with `patch`, due dates, notes, and subtasks — so context
can accrete on an item over time.

The Google **Keep** API exposes only `create` / `delete` / `get` / `list` — **no `update`/`patch`
on a note.** Editing a note means delete-and-recreate, which loses the note's identity, so it is
a poor fit for accreting memory. Keep access is also Workspace-restricted and historically
unreliable. Treat Keep as optional snapshot-only, if used at all.

## Shape (mirrors `entrepreneur` / `planner`)

Stateless leaf agent, two invocation modes:

1. **`{ "conversationId", "request" }`** — delegated from `chat`. Capture ("remember that …",
   "plan <event>", "gift for <person>, they like <thing>") or query ("what's left for <event>?",
   "what do we know about gifts for <person>?"). Replies into the same thread.
2. **`pulse`** (plain string) — from a new schedule cron. Reviews the project lists, finds items
   that are due / approaching / overdue / stale, and pushes one grouped nudge to the operator's
   own conversation (the same delivery path the finance heartbeat already uses). Idempotent:
   skip the push if nothing changed since today's last push.

### Tools (least privilege)

```yaml
concierge:                 # working name; pick a persona to match the set
  can_be_called_by: [chat, schedule]
  tools: "Bash(gws tasks:*),Bash(date:*),Bash(jq:*),Read,Write"
  model: sonnet
```

No gmail, no drive, no calendar, no send, no pay. Inbound requests are untrusted data — the
agent runs fixed procedures and never obeys instructions found inside content. Replies go only
to a `conversationId` it was handed (the task, or the operator thread from config).

## Onboarding surface (files a build would touch)

1. `registry.yaml` — add the agent block above.
2. `agents/<name>/CLAUDE.md` — role file: the two modes, list-naming convention, output language,
   the `out.json` contract.
3. `agents/<name>/{settings,context}.example.*` — config (list prefix, pulse window in days).
4. `agents/chat/CLAUDE.md` — add a delegation branch: remember / gifts / planning logistics →
   delegate to this agent.
5. `agents/triage/` Settings — add the new capability to the harness capability list so
   *implicit* cues escalate.
6. `src/adapters/schedule.ts` — add `{ cron: <pulseCron>, agent: <name>, task: 'pulse' }`.
7. `src/config.ts` + `config.example.json` — add the pulse cron (e.g. shortly after the morning
   brief) with env override + validation.
8. `test/` — a new agent test mirroring `entrepreneur.test.ts`; the allowlist/registry test picks
   up the new agent. Then `npm run typecheck && npm test`.

## Open questions

- **Name** — pick a persona consistent with `triage` / `chat` / `planner` / `entrepreneur`.
- **Scope** — baseline is *memory + logistics* (no autonomous open-ended research; that suits an
  interactive session, not short headless runs). Optional add: a single **bounded** web lookup
  that writes its result into a task's notes — additive (`WebSearch`/`WebFetch` + one branch).
- **Calendar awareness** — leaf agents can't call each other today. Putting an event on the
  calendar needs either a one-line `planner.can_be_called_by` extension, or letting the human book
  via chat → planner. Otherwise keep it Tasks-only.
- **Pulse model** — the daily review is light and could run on a cheaper model; chat capture/query
  benefits from a stronger one. One agent = one model, so it's a tradeoff.
