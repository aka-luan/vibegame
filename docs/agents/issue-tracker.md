# Issue Tracker: GitHub

Issues and implementation tickets for this repository live in GitHub repository `aka-luan/vibegame`. Use the `gh` CLI with an explicit `--repo aka-luan/vibegame` or `-R aka-luan/vibegame` argument; the local clone does not need a Git remote.

## Conventions

- Create one issue per independently reviewable ticket.
- Read an issue and its discussion before acting on it.
- Publish tickets in dependency order so blocker references use real issue numbers.
- Apply `ready-for-agent` only when scope, dependencies, acceptance criteria, automated tests, manual checks, and non-goals are complete.
- Do not close or modify a parent/source issue while decomposing it.
- Do not assign, close, comment on, or edit unrelated issues.

## Pull requests as a triage surface

External pull requests are **not** a request or triage surface. Triage skills process GitHub issues only. Collaborator and external pull requests remain outside the issue-triage state machine unless this policy is explicitly changed.

## Blocking relationships

Use GitHub native issue dependencies when the repository supports them. The blocked issue depends on the numeric database ID of each blocker, not its visible issue number. Also retain a human-readable `Blocked by` section in the issue body so the dependency remains understandable and portable.

If native dependencies are unavailable, the `Blocked by` section is authoritative. An issue is ready only when every listed blocker is closed.

## Skill operations

When a skill says to publish to the issue tracker, create a GitHub issue in `aka-luan/vibegame`. When it says to fetch a ticket, read the issue body, labels, and comments from that repository.
