---
name: remove-ai-slop
description: Remove AI-generated code slop and clean up C# code style. Use when cleaning up code, reviewing for style issues, removing unnecessary comments, removing unnecessary null checks, simplifying over-engineered abstractions, or when the user says the code looks AI-generated or needs a cleanup pass. ALWAYS apply this skill after writing or editing C# code — treat it as the final step of every code change before presenting the result to the user.
---

# Remove AI Slop & Clean Up Code Style

Ruthlessly remove AI padding and enforce the actual style of this codebase. The goal is code that a senior engineer wrote — not code that an AI generated to look thorough.

## The Slop Checklist

Work through these categories. Check every item in the diff/file before declaring done.

### 1. Comments — delete almost all of them

Delete any comment that:
- Narrates what the code does (`// Get the user`, `// Return the result`, `// Check if null`)
- Restates the method/variable name (`// Helper method`, `// Repository field`)
- Was added "just in case" (`// TODO: consider...`, `// Note: this might...`)
- Is a section divider without real content (`// ----`, `// Fields`, `// Methods`)

Keep only comments that explain **non-obvious intent, a trade-off, or a constraint** that cannot be expressed in code. When in doubt, delete.

### 2. Null checks — remove the unnecessary ones

Remove null checks on:
- Constructor-injected dependencies (services, repositories, loggers) — never null by DI contract
- Values just assigned via `new` or a literal
- Return values from methods that are already documented/known to never return null

Keep null checks that guard against actual runtime nulls (e.g. results from a repository, external API responses, user input).

Do not add `ArgumentNullException.ThrowIfNull` unless the original code already uses that pattern.

### 3. Abstractions — collapse single-use ones

Remove:
- Interfaces used in exactly one place with one implementation (especially if trivially thin wrappers)
- Base classes that only exist to share one or two private methods
- Wrapper classes that add no logic (`UserDto` that is a 1:1 copy of `User` with no transformation)
- Single-method interfaces extracted only to make a class "testable" but never mocked in tests

Keep interfaces that express a genuine contract, enable polymorphism, or are used in multiple places.

### 4. Naming — rename the generic

Rename variables/parameters named `result`, `data`, `value`, `item`, `obj`, `helper`, `manager`, `info`, `response` to something that names the domain concept. Examples:
- `result` → `payoutReview` (or whatever it holds)
- `data` → `memberDetails`
- `response` → `aiAuditResponse`

### 5. Verbose code — simplify

Replace verbose patterns with idiomatic equivalents:

| Slop | Clean |
|---|---|
| `if (x == null) return null;` on a collection | `x?.Select(...) ?? []` |
| `var list = new List<T>(); foreach (...) list.Add(...); return list;` | `.Select(...).ToList()` |
| `if (x != null) { return x.Value; } else { return default; }` | `x?.Value ?? default` |
| `.Count() > 0` | `.Any()` |
| `.Where(...).First()` | `.First(...)` |
| `new List<T> { item1, item2 }` when array is fine | `new[] { item1, item2 }` or collection expression `[item1, item2]` |
| Explicit type on `var` assignment: `List<string> things = new List<string>()` | `var things = new List<string>()` |

### 6. Error handling — remove defensive hedging

Remove:
- `try/catch` blocks that catch `Exception` and just rethrow or log then rethrow with no recovery logic
- Empty catch blocks
- Guard clauses that throw a generic `Exception("Something went wrong")` — use `InvalidOperationException` with a useful message, or `UnrecoverableException` for NServiceBus handlers where retries must not happen

### 7. Over-engineering — kill it

- Single-line methods that are called once and just delegate: inline them
- Private methods named `ExecuteAsync` / `RunAsync` / `ProcessAsync` that just call one other method
- `bool` flags passed into methods to change behavior: split into two methods
- `object` or `dynamic` used where a concrete type is obvious

## Style Anchors (this codebase specifically)

- `var` everywhere for locals — never write the explicit type on the left side of `=`
- `_camelCase` for private fields
- `ct` for `CancellationToken` parameters
- `DateTime.Now` — not UTC
- No `is null` / `is not null` in older files — use `== null` / `!= null` to match the surrounding file's style
- File-scoped namespaces: `namespace Foo.Bar;`
- No block-scoped `namespace { }`
- No AutoMapper — static `Map`/`MapToContract` methods
- Interface + implementation in the same file (for repositories)
- No null guards on DI-injected constructor parameters

## Process

1. Read the full file (or diff) before making any changes
2. Work through the checklist above in order
3. Make all changes in one pass — don't go back and forth
4. Run `dotnet build .` to confirm no compile errors
5. Run `dotnet test --filter 'FullyQualifiedName!~IntegrationTests'` to confirm no regressions
6. Do not reformat what isn't slop — leave code you didn't touch alone
