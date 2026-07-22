---
description: Autonomously implement a GitHub issue end-to-end — worktree, subagent implementation, test loop, independent review, PR.
argument-hint: <issue-number>
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, AskUserQuestion, TaskOutput
---

# /ship — issue $1 to draft PR, autonomously

Run the pipeline below for GitHub issue **#$1**. Work autonomously; do not stop
for approval between stages.

Hard constraints, from `AGENTS.md`:

- **Never push to `main`**, never force-push, never merge.
- **Work only from an approved `ready-for-agent` issue** whose blockers are
  complete. If issue #$1 lacks that label, stop and say so before implementing.
- **No scope expansion.** Convenience, anticipated future use, and "a more
  general abstraction" are explicitly insufficient justification. Expansion
  needs repository-owner approval — that means stopping and asking.
- **Preserve the user's dirty worktree.** Never commit or stash their changes.

## 1. Read the issue

```bash
gh issue view $1 --json title,body,labels,comments,state
```

Write down before touching anything:

- **Acceptance criteria** — verbatim from the issue's own section if present.
  Number them `AC1..ACn`. These are the review contract in stage 6; do not
  paraphrase them away.
- **Non-goals** and **files in scope** — the issue's own scope fence.
- **Manual checks** — mandatory per `AGENTS.md`, and they do not replace
  automated criteria. List them in the PR for the owner to run.
- **Blocked by** — if a blocker is open, stop.

## 2. Isolate

Never work in the user's checkout — it may be dirty, and on an overlapping
branch.

```bash
git fetch origin main
git worktree add .worktrees/issue-$1 -b <type>/issue-$1 origin/main
```

`<type>` matches the issue's conventional-commit type (`feat`, `fix`,
`refactor`, …). Branch from `origin/main`, not from local HEAD — the user's
local branch may carry unrelated work.

If the issue notes an **overlap** with another in-flight branch, say which files
overlap and that the second to land resolves them. Do not try to merge the other
branch in.

## 3. Gather the constraints

Read, in this order:

1. `CONTEXT.md` and `PLAN.md` — the product and delivery authority. Vocabulary
   from these is law.
2. `docs/architecture/` — **every ADR touching the area under change.** Name the
   ones you read. If the directory is missing or empty, say so explicitly rather
   than skipping silently.
3. `AGENTS.md` — the section matching the change: state privacy, HTTP/rooms/
   persistence, client boundaries, content, map, asset, database, errors.
4. `docs/agents/` — repo-specific agent conventions and known traps.

Output a **constraints list**: the specific rules this change must satisfy, not
a summary of the documents. Both subagents get this list verbatim.

## 4. Implement (subagent)

Launch **one** subagent (`general-purpose`, `run_in_background: false`). Brief it
completely the first time — relaunching to re-explain throws away the context it
built. The brief contains:

- issue title + body verbatim
- the numbered acceptance criteria
- the constraints list from stage 3
- the worktree path and branch; commit as you go, never push
- scope discipline: every changed line traces to the issue; no adjacent
  refactors, no drive-by formatting

Do not re-derive or redo its work when it reports back.

## 5. Validation loop (max 5 iterations)

Run every command the acceptance criteria name. For this repo the full gate is:

```bash
pnpm validate          # typecheck + lint + format:check + content:validate
pnpm test
pnpm test:integration  # needs postgres: pnpm db:up
pnpm test:multiplayer
pnpm test:e2e
```

Run the narrowest relevant command while iterating; run every applicable one
before handoff. **Never claim validation that was not run** — if a command
cannot run (no Docker, no browsers), report the exact blocker and what you ran
instead.

On failure: read it, fix it **in the main thread** (do not spawn a subagent per
fix), re-run. Each full re-run is one iteration. After 5, stop and report what
still fails — do not open the PR.

## 6. Independent review (second subagent)

Launch a **fresh** subagent. It must have no context from stage 4. Give it only:

- `git diff origin/main...HEAD`
- the numbered acceptance criteria
- the constraints list

Do **not** pass the implementer's report, rationale, or self-assessment — that
is exactly what makes the review independent.

Ask for a findings list, one line each, severity-tagged:

- **P0** — misses an acceptance criterion, breaks a security/privacy rule, or
  violates a stated non-goal
- **P1** — correctness bug, boundary violation, or vocabulary/ADR breach
- **P2** — nit; record, do not fix

## 7. Fix P0/P1, re-validate

Fix every P0 and P1 in the main thread, then re-run stage 5 with a fresh
5-iteration budget. Leave P2 findings unfixed; list them in the PR.

## 8. Open the draft PR

```bash
git push -u origin <type>/issue-$1
gh pr create --draft --base main --title "<type>(<scope>): <summary>" --body "..."
```

Body must contain:

- `Closes #$1`
- acceptance criteria as a checklist, each marked met/unmet with the evidence
- every gate command run, and its actual result — including anything skipped and
  why
- the issue's manual checks, unrun, for the owner
- reviewer findings: fixed, and P2s left with reasons
- any assumption taken, at the top

## 9. When to interrupt

Interrupt only for:

- a **product decision** the issue does not answer even by implication — use
  `AskUserQuestion` with concrete options
- a change that would require **scope expansion** (see the hard constraints)
- the same failure surviving **more than 2** fix iterations
- credentials or access you cannot grant yourself

If the issue _implies_ an answer (a linked doc, a stated preference, an approved
design section), take it, note the assumption in the PR body, and keep going.
Everything else: decide and move on.
