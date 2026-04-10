---
name: parallel-code-review
description: Run 5 parallel code review agents, each with a specific focus area. Use when the user asks to review code, review changes, run a parallel review, review a branch, review staged changes, review the last N commits, or says "review my code".
---

# Parallel Code Review

## Step 1: Determine the diff scope

Infer scope from the user's request:

| User says | Git command |
|-----------|-------------|
| (nothing / "my branch" / default) | `git diff $(git merge-base HEAD origin/main)...HEAD` |
| "staged" | `git diff --cached` |
| "last commit" | `git diff HEAD~1 HEAD` |
| "last N commits" | `git diff HEAD~N HEAD` |
| specific files mentioned | scope the diff to those files |

Run `git log --oneline -10` first to orient yourself on what's in scope. Then run the appropriate `git diff --stat` followed by the full diff to collect changed files and content.

If the diff is large, read the most relevant changed files directly with the Read tool to supplement the diff output.

## Step 2: Launch 5 parallel reviewers

Use the `Task` tool to launch all 5 subagents **in a single message** (parallel). Set `readonly: true` and `subagent_type: "generalPurpose"` for each.

Pass each reviewer:
- The full diff
- The list of changed files
- Their specific focus (prompt below)
- Instruction to report findings as a numbered list with severity: **Critical** / **Warning** / **Suggestion**, or "No findings." if clean

---

### Reviewer 1: Parity Reviewer

> Your role is Parity Reviewer. You verify that the implementation matches its stated intent.
>
> If this is a migration or rewrite, check that all behaviors from the original are replicated exactly. Look for semantic traps between languages/frameworks (e.g. `undefined` vs `null`, default values, type coercions, fallback chains, array vs empty handling). If there is no prior implementation to compare against, focus on whether the code does what its name, comments, and surrounding context imply it should do.
>
> Report findings as a numbered list with severity **Critical** / **Warning** / **Suggestion**. If nothing to report, say "No findings."

---

### Reviewer 2: Error Flow Tracer

> Your role is Error Flow Tracer. You trace all error paths end-to-end.
>
> For every operation in the changed code, ask: what happens on non-success, missing input, invalid types, null/empty responses, timeouts, exceptions? Verify errors propagate correctly and are not swallowed. Check that middleware, exception handlers, and error responses behave correctly.
>
> Report findings as a numbered list with severity **Critical** / **Warning** / **Suggestion**. If nothing to report, say "No findings."

---

### Reviewer 3: Code Quality Reviewer

> Your role is Code Quality Reviewer. You verify the code matches the existing codebase's conventions and patterns.
>
> Check: naming conventions, DI patterns (constructor vs property injection), async/await usage, cancellation token propagation, dictionary/collection construction patterns, consistency with neighboring code doing similar things. Do not enforce generic style opinions -- only flag deviations from what the codebase itself does.
>
> Report findings as a numbered list with severity **Critical** / **Warning** / **Suggestion**. If nothing to report, say "No findings."

---

### Reviewer 4: Bug Hunter

> Your role is Bug Hunter. You look for concrete bugs and runtime hazards.
>
> Check for: wrong HTTP methods or routes, missing required parameters, off-by-one errors, null reference risks (`.Value` on a nullable without a null check, dereferencing without guard), incorrect URL encoding, wrong property names, `bool.ToString()` casing issues (returns "True"/"False", not "true"/"false"), swapped arguments, mismatched types, incorrect comparisons.
>
> Report findings as a numbered list with severity **Critical** / **Warning** / **Suggestion**. If nothing to report, say "No findings."

---

### Reviewer 5: Test Coverage Reviewer

> Your role is Test Coverage Reviewer. You identify untested code paths.
>
> Read both the changed implementation files and the corresponding test files. Check that tests cover: all major code paths, parameter combinations, empty/missing/null inputs, edge cases, and error responses. Identify any paths that exist in the implementation but have no test asserting their behavior.
>
> Report findings as a numbered list with severity **Critical** / **Warning** / **Suggestion**. If nothing to report, say "No findings."

---

## Step 3: Aggregate and present results

Wait for all 5 subagents to complete, then present results grouped by reviewer in a single response:

```
## Code Review Results

### 1. Parity Reviewer
[findings or "No findings."]

### 2. Error Flow Tracer
[findings or "No findings."]

### 3. Code Quality Reviewer
[findings or "No findings."]

### 4. Bug Hunter
[findings or "No findings."]

### 5. Test Coverage Reviewer
[findings or "No findings."]

---
**Summary**: X critical, Y warnings, Z suggestions across 5 reviewers.
```

If all 5 return "No findings.", report: "All 5 reviewers returned clean. No issues found."

## Acceptance criteria mode

If the user asks to "review until clean" or "keep going until 0 comments", re-run all 5 reviewers after each round of fixes until the summary shows 0 critical and 0 warnings (suggestions can remain). Report the round number each time.
