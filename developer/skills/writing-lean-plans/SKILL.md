---
name: writing-lean-plans
description: Write a short, scannable implementation plan a human can read in under a minute. Use when the user wants a quick plan, a sketch, or an outline — not a full TDD walkthrough. Prefer this for small tasks, refactors, bug fixes, or when the user says "quick plan", "rough plan", "outline", or "just sketch it".
---

# Writing Lean Plans

A fast plan is a punch list, not a tutorial. The reader is a competent engineer who needs to know **what** and **where**, not **how** to write code.

## Same rigor, crisper output

**"Fast" describes the reader's experience, not yours.** Do the full investigation. Read the files, trace the call sites, check the schema, verify the symbol names exist. The plan is short because you cut filler words — not because you cut thinking.

- Spend the same time reading code as you would for a long plan
- Verify every file path and symbol you name (a wrong path is worse than no path)
- Check edge cases, migrations, and side effects before writing the steps
- If you'd grep five files for a long plan, grep five files for a fast plan
- If something is uncertain, say so in one line — don't paper over it with confident-sounding bullets

A crisp plan with wrong details is worse than a verbose plan with right ones. Brevity is the last step, not the first.

## When to use

- Task fits in one PR
- Reader knows the codebase and the language
- User asked for a "quick plan", "outline", "sketch", or similar
- You'd otherwise pad a small task into a 200-line document

## When NOT to use

- Multi-day project, multiple subsystems
- Reader is a fresh agent with no context
- User explicitly asked for full TDD steps with code blocks

## Format

```markdown
# <Feature>

**Goal:** <one sentence>

**Files:**
- `path/to/file.ext` — <what changes, one line>
- `path/to/other.ext` — <what changes, one line>

**Steps:**
1. <verb-first action with file/symbol>
2. <verb-first action with file/symbol>
3. <verb-first action with file/symbol>

**Verify:** <command or check>

**Risks:** <only if non-obvious; otherwise omit>
```

That's the whole template. No headers you don't need.

## Rules

- **Bullets over prose.** If a sentence can be a bullet, make it one.
- **One line per step.** If a step needs three sentences, it's two steps.
- **Verb-first.** "Add `parseDate` to `utils/date.ts`" — not "We should consider adding…".
- **Name files and symbols.** `utils/date.ts:42`, not "the date utility".
- **Skip code.** No code blocks unless a literal string/regex/SQL is the point.
- **Skip rationale.** The reader trusts the goal. Only justify non-obvious choices.
- **Omit empty sections.** No "Risks: none". Just leave it out.

## Words to cut

| Cut | Use |
|---|---|
| "We should add…" | "Add…" |
| "Make sure to…" | (omit; engineer knows) |
| "Consider whether…" | (decide, then state the decision) |
| "It might be a good idea to…" | (omit or state as step) |
| "In order to…" | "To…" |
| "There is a need to…" | (omit) |

## Example

```markdown
# Add document_date to skipped state

**Goal:** Surface document_date on skipped rows so the UI can sort by it.

**Files:**
- `state/schema.ts` — add `document_date: string \| null` to `Skipped`
- `state/migrations/0014_skipped_doc_date.sql` — new column, nullable
- `ui/skipped-list.tsx` — render new column, default sort desc

**Steps:**
1. Add column in migration `0014_skipped_doc_date.sql`
2. Add field to `Skipped` type in `schema.ts`
3. Backfill via `scripts/backfill-skipped-doc-date.ts`
4. Render column in `skipped-list.tsx`, sort desc by default

**Verify:** `pnpm test state/` and load `/skipped` in dev — newest first.
```

A reader scans this in 20 seconds and starts work.

## Anti-patterns

- Restating the goal three times in different words
- "Step 1: open the file. Step 2: read it. Step 3: think about the change."
- Code blocks reproducing the file you're editing
- "Testing" sections that just say "add tests"
- Numbered lists where every item starts with "Make sure that…"
- Skipping the file/symbol verification step because "it's just a fast plan"
