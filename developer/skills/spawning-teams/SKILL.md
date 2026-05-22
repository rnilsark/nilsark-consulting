---
name: spawning-teams
description: Use when planning a multi-file change that splits along clean seams into 2-4 independently-implementable slices and you want one PR (not many), OR when about to execute an existing plan that has a `## Slices` section. The skill spans the plan-mode boundary — it shapes the plan during planning, then dispatches parallel subagents to execute it after ExitPlanMode. Especially relevant inside an orchestrator session (e.g. Conductor) where the main session integrates and the workers run in parallel isolated worktrees.
---

# Spawning teams

## Overview

A skill in two halves separated by `ExitPlanMode`:

- **Planning half (plan mode, read-only):** help cut the work into file-disjoint slices, write a *team-aware plan* with an explicit `## Slices` section, allocate collision-prone identifiers, get user approval, exit plan mode.
- **Execution half (after ExitPlanMode):** read the team-aware plan, dispatch one subagent per declared slice in parallel (each in its own worktree), run a closed loop inside each slice (build + tests + cubic's `run-review`), then cherry-pick the resulting commits onto a single integration branch for one PR.

The main session is the orchestrator across both halves. The plan is the durable handoff — a team-aware plan executes the same way in a fresh session tomorrow.

**Core principle:** the slice cut belongs in the plan, not in execution. The plan is reviewed and approved like any other plan; execution then just follows what's written.

## How this fits with other skills

`/spawn-team` extends planning rather than replacing it. Typical flow:

1. **Discuss / brainstorm** — freehand, or via `superpowers:brainstorming` for fuzzier work.
2. **`/spawn-team`** (in plan mode) — produces a team-aware plan (extension of what `developer:plan-lean` or `superpowers:writing-plans` would produce).
3. **ExitPlanMode** — user approves.
4. **`/spawn-team`** (continues, now executing) — dispatches workers, integrates, hands back the integration branch.
5. **Ship** — push, PR, deploy. Optional: `team-review` (Slack), `check-pr-comments` (CI feedback).

Related skills (lean on them, don't duplicate):
- `superpowers:dispatching-parallel-agents` — general parallel subagent patterns.
- `superpowers:using-git-worktrees` — worktree isolation mechanics.
- `cubic-loop` — iterate-until-clean review pattern used inside each slice.
- `run-review` (cubic) — single AI review pass on uncommitted changes.

## When to use

- A multi-file change that clusters along seams (contracts/domain, DB layer, handlers, config refactor).
- Slices share little state — most touched files belong to one slice.
- Deploys are expensive or manual; multiple PRs would be painful.
- The work is concrete enough that a subagent can finish a slice without checking back mid-flight.

## When NOT to use

- Whole change fits in one focused session — overhead isn't worth it.
- Slices have heavy cross-dependencies — sequential is faster than juggling.
- One person can finish in under an hour.
- The design is still fuzzy — brainstorm first, come back when there's a candidate shape.

## Planning half (in plan mode)

While the user is still discussing the change, propose the team-aware plan structure. The plan goes to `.context/plans/<ticket>.md` (or equivalent). It must contain a `## Slices` section in the format below — that's what the execution half reads.

### Plan template additions

Beyond whatever the normal plan would contain, add:

```markdown
## Slices

Allocated identifiers (collision-prone resources picked up front):
- Migration numbers: 0341, 0342, 0343
- Sproc versions: PayoutAttemptTypeV4
- (anything else cross-slice)

**Integration branch:** <branch-name>

**Scaffold:** yes | no
If yes, list the type/interface/property/signature additions that go on the integration base in one atomic commit *before* workers are dispatched. No behavior, no tests, no DB — just the seams the slices will fill in. Example:
- `IPayoutAttemptCompleted.FundingAccount` added
- `PayoutAttempt.FundingAccount` property declared
- `NewPayoutAttempt(...)` signature takes `string fundingAccount`
- `PayoutFundingAccount` constants file
- (call sites that break get TODO stubs inside future-worker scopes)

### Slice A — <short-name>
- **Branch:** <branch-name> (off scaffold commit if declared, else off main)
- **Depends on:** none | A
- **Scope:** which files/areas, what's in, what's out.
- **Acceptance:** bulleted assertions — what's true when this slice is done.
- **Tests:** specific files to extend or add.

### Slice B — <short-name>
- **Branch:** <branch-name>
- **Depends on:** none (parallel with A if scaffold declared) | A
- ...
```

### Slice-cut rules

- **File-disjoint by default.** Two slices should rarely edit the same file. Shared test infrastructure (fakes, builders) is the usual exception — flag it explicitly.
- **2–4 slices.** Fewer than 2 means no parallelism benefit; more than 4 means coordination cost dominates.
- **Allocate collision-prone identifiers up front.** Migration numbers, sproc version suffixes, port numbers — all in the "Allocated identifiers" block, not picked by workers.
- **Linear dependency order.** A → B → C is fine. A diamond (B and C both depend on A, D depends on B and C) is fine. Cycles are not — refactor the cut.
- **Scaffold seams to unlock parallelism.** If slices would otherwise have hard compile-time dependencies on each other's types (e.g. Slice B references a property Slice A creates), the default-lazy answer is to chain them sequentially. The better answer is a single **scaffold commit** on the integration base that declares the seams (interfaces, property declarations, signature changes — no behavior). Workers then branch from the scaffold and run in parallel because every type they reference already exists on their base. This is the difference between "we can parallelize" and "we have to chain sequentially." Always consider scaffolding before accepting a sequential cut.

### Human approval gate

The slice cut is the highest-leverage decision in the entire flow. Once workers are dispatched, re-cutting wastes their work. Walk the user through the proposed cut explicitly before they ExitPlanMode. Acceptable to push back if the cut seems off.

## Execution half (after ExitPlanMode)

### 1. Read the plan

The team-aware plan is the contract. Read the `## Slices` section to derive worker prompts. No additional spec extraction needed — the plan already has acceptance criteria and test lists per slice.

### 2. Apply scaffold (if declared)

If the plan declares **Scaffold: yes**, do this *before* dispatching any worker:

- Create the integration branch off `main` (e.g. `rnilsark/<ticket>`).
- Make one atomic commit containing exactly the scaffolded type/interface/property/signature additions listed in the plan — nothing else. Use a `feat:` or `chore:` prefix and a body that names the ticket.
- Verify the project compiles. Call sites that break should get TODO stubs that the relevant worker will replace.
- Push the integration branch. Workers branch off this commit, not off main.

Skip this step if no scaffold was declared.

### 3. Dispatch implementers in parallel

One `Agent` tool call per slice **in a single message** so they run concurrently. Each call uses `isolation: "worktree"` so the subagent gets a fresh worktree on a new branch off the integration base.

Each implementer's prompt is derived directly from the slice section and must include:
- Slice scope (from the plan).
- Path to the plan file (so worker can read context if needed).
- Acceptance criteria and test list (from the plan).
- Branch name (from the plan).
- The per-slice closed loop instructions (below).
- Commit-style guidance (conventional prefixes, 1–3 commits).

If slices have linear dependencies, dispatch the independent ones first, wait, then dispatch dependents. If they're a flat fan-out, dispatch all in one message.

#### Per-slice closed loop (inside each subagent)

1. Implement against the slice's acceptance criteria.
2. Build + tests green (project-specific commands from `CLAUDE.md`).
3. Run `run-review` (cubic) on the slice's diff. (Equivalent: invoke `cubic-loop` to bundle steps 3–5 with a built-in iteration cap.)
4. Fix what's worth fixing. Re-run tests + review.
5. **Cap at 3 review iterations.** If issues remain after the cap, commit what's clean and surface unresolved findings in the final report instead of burning context.
6. Make 1–3 tidy commits with conventional prefixes. Report back: branch name, commit SHAs, unresolved findings.

### 4. Integrate (orchestrator session)

- `git fetch` slice branches.
- `git cherry-pick` commits onto the integration branch in the plan's dependency order. **Do not squash** — preserve the per-slice commit structure; it documents the seams and makes blame useful later.
- Resolve any cross-slice conflicts here (usually in test infrastructure or shared fakes).
- Run full build + tests across the integrated diff.
- Run `run-review` (cubic) on the full integrated diff. This is the cross-slice safety net.
- Fix cross-slice findings in 1–2 commits authored here.

### 5. Ship

One PR off the integration branch. One deploy. CI's cubic review should be a formality since each slice passed locally.

## Quick reference

| Half | Phase | Mode | Output |
|---|---|---|---|
| Plan | Discuss + cut slices (incl. scaffold decision) | plan mode | Team-aware plan with `## Slices` section |
| Plan | Approval | plan mode | ExitPlanMode |
| Execute | Scaffold (if declared) | normal | Integration branch with one scaffold commit; workers branch from here |
| Execute | Dispatch workers | normal | Branches with clean commits + per-slice `run-review` pass |
| Execute | Integrate | normal | Integration branch with cherry-picked commits + cross-slice `run-review` |
| Execute | Ship | normal | One PR, one deploy |

## Common mistakes

- **Going sequential when scaffold would unlock parallel.** If slices have hard compile-time dependencies on each other's types, the lazy answer is to chain them. The better answer is a scaffold commit on the integration base that declares the seams; both slices then compile independently and run in parallel. Always evaluate scaffolding before accepting a sequential cut.
- **Cutting slices during execution instead of planning.** The cut is the highest-leverage decision — it deserves user review in plan mode, not a snap call once workers are about to fire.
- **Skipping the `## Slices` section in the plan.** Without it, the execution half has no machine-readable input. A team-aware plan that just describes slices in prose isn't a team-aware plan.
- **Racing the same slice with multiple agents.** Diffs end up ~95% identical; merging is pointless. Race only when approach is genuinely ambiguous. Default: file-disjoint slices.
- **Squashing on integration.** Destroys the per-slice commit structure. Use cherry-pick.
- **No iteration cap on the per-slice review loop.** Burns subagent context. Cap at ~3 and surface remaining issues upward.
- **Forgetting collision-prone identifiers.** Allocate them in the plan's "Allocated identifiers" block before dispatch, not during.
- **Dispatching implementers in separate messages.** They run sequentially, not in parallel. Must be one message with multiple `Agent` calls (per dependency-order batch).

## First-run instructions (treat as RED phase)

This skill hasn't been pressure-tested yet. For the first 2–3 runs:
- Use only 2 slices.
- Pick slices that *will* touch overlapping ground (shared fakes, test builders) — the cherry-pick conflict is the lesson.
- After each run, note in a scratch file: which step felt like ceremony, which step got skipped, what bit you that the skill didn't warn about.
- Refactor the skill based on what you observed. Don't add hypothetical guidance — only address what actually went wrong.
