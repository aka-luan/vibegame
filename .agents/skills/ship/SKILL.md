---
name: ship
description: Autonomously take one approved GitHub issue from verification through isolated implementation, validation, independent review, and a draft pull request. Use when the user explicitly asks to ship a numbered `ready-for-agent` issue, take it through a draft PR, or invokes `$ship`; examples include "ship issue #42" and "take #42 to a draft PR".
---

# Ship an approved issue

Take exactly one numbered issue to a validated draft pull request. Continue between stages without seeking routine confirmation.

## Enforce hard constraints

- Require an issue number. If none is present, ask for it and do nothing else.
- Work only from an open issue labeled `ready-for-agent` whose blockers are complete. Stop before implementation if either condition fails.
- Never modify, commit, or stash changes in the user's original checkout.
- Never expand scope without the repository owner's explicit approval. Convenience, anticipated future use, and generalization are not sufficient reasons.
- Never push to `main`, force-push, merge, or deploy.
- Never claim a validation or manual check that was not run.
- Treat an explicit `$ship`, "ship," or draft-pull-request request as authorization to commit, push the issue branch, and open a draft pull request. For a request that authorizes implementation but not those Git or GitHub mutations, stop before committing and ask for authorization.

## 1. Verify the issue

Read the issue and its discussion from the tracker configured by the repository. Use an explicit repository argument when local guidance requires one. Fetch at least the title, body, labels, comments, and state.

Before changing files, record:

- The acceptance criteria verbatim, numbered `AC1..ACn`.
- Non-goals and files in scope.
- Mandatory manual checks.
- Human-readable and native blocking relationships when available.

Stop if the issue is closed, lacks `ready-for-agent`, or has an incomplete blocker.

## 2. Create an isolated worktree

Inspect the user's checkout without changing it. Before any fetch, branch, or worktree mutation, read its `PLAN.md` and applicable `AGENTS.md` instructions. Fetch current `origin/main`, then create `.worktrees/issue-<number>` on a new `<type>/issue-<number>` branch based on `origin/main`. Choose `<type>` from the issue's conventional-commit category.

If that worktree or branch already exists, inspect it and continue only when it unambiguously belongs to the same issue. Never delete or reset an existing worktree to resolve a collision.

Perform every subsequent file edit, validation command, commit, and push inside the isolated worktree. If the issue identifies overlap with another in-flight branch, report the overlapping files and let the second branch to land resolve them; do not merge the other branch into this one.

## 3. Gather repository constraints

Read, in order:

1. `CONTEXT.md` when present and `PLAN.md`.
2. Every architecture record relevant to the boundary or technology under change.
3. `AGENTS.md`, including the sections governing the change.
4. Repository-specific agent documentation such as `docs/agents/`.

State explicitly when no architecture record applies. Produce a concrete constraints list for this issue rather than a document summary. Reuse that exact list for implementation and review.

## 4. Implement within scope

When subagents are available, launch one implementation subagent and brief it completely on the first pass with:

- The issue title and body verbatim.
- The numbered acceptance criteria.
- The constraints list.
- The isolated worktree path and branch.
- Instructions to keep every changed line traceable to the issue, avoid adjacent refactors and formatting, commit coherent progress, and never push.

Keep the implementation in that subagent rather than duplicating its work in the parent. If subagents are unavailable, implement in the current agent and disclose that deviation in the pull request.

## 5. Run the validation loop

Run the narrowest relevant checks while iterating. Before handoff, run every command required by the issue and every applicable validation interface named by the repository's current `AGENTS.md` or equivalent guidance. Respect prerequisites such as builds, databases, browsers, or containers.

For each failure, diagnose and fix it in the parent agent, then rerun the affected checks. Treat each complete rerun as one iteration. Stop after five iterations and report the remaining failures instead of opening a pull request.

Record each command and its actual result. If a required command cannot run, record the exact blocker and what ran instead.

## 6. Perform an independent review

Launch a fresh review subagent with no implementation context. Give it only:

- `git diff origin/main...HEAD`.
- The numbered acceptance criteria.
- The constraints list.

Do not provide the implementer's report, rationale, or self-assessment. Ask for one finding per line using:

- `P0`: missed acceptance criterion, security or privacy violation, or stated non-goal violation.
- `P1`: correctness bug, boundary violation, or vocabulary or architecture-decision breach.
- `P2`: non-blocking nit.

If subagents are unavailable, perform the same review in a fresh context when the surface supports it; otherwise disclose that independent review could not run and do not represent a self-review as independent.

## 7. Fix blocking findings and revalidate

Fix every P0 and P1 finding in the parent agent. Leave P2 findings unchanged and list them with reasons in the pull request. Rerun the full applicable validation set with a fresh five-iteration budget.

Do not open the pull request while a P0 or P1 remains or required validation fails.

## 8. Open a draft pull request

Commit the completed issue-scoped changes using the repository's conventions. Push only the issue branch, then open a draft pull request against `main`.

Include in the pull-request body:

- `Closes #<number>`.
- Any assumptions, at the top.
- Every acceptance criterion as a met or unmet checklist item with evidence.
- Every validation command attempted and its actual result, including skipped commands and reasons.
- The issue's manual checks, clearly marked unrun for the owner unless actually completed.
- Review findings, including fixed findings and unchanged P2s with reasons.

Stop after reporting the draft pull-request URL. Never merge or deploy it.

## Interrupt only when necessary

Pause and ask the user only for:

- A product decision the issue and its linked authority do not answer even by implication.
- Approval for a documented scope expansion.
- The same failure surviving more than two fix iterations.
- Credentials or access the agent cannot obtain within the authorized workflow.

When the approved issue or linked authority implies an answer, take it, record the assumption in the pull request, and continue.
