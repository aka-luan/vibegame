# Domain Documentation

This is a single-context repository.

## Before exploring or changing the system

- Read root `CONTEXT.md` when it exists and is relevant.
- Read `PLAN.md` for approved product and architecture vocabulary.
- Read relevant architecture decision records under `docs/architecture/`.

`CONTEXT.md` is created lazily when domain-modeling work resolves vocabulary that needs a dedicated glossary. Its absence is not a setup error.

## Vocabulary

Use defined domain terms in issue titles, tests, modules, logs, and documentation. Do not drift to synonyms when `PLAN.md` or `CONTEXT.md` distinguishes concepts such as logical map, map instance, play ticket, transition ticket, safe spawn, participation, reward grant, or appearance manifest.

If a needed concept has no agreed term, either use existing language more carefully or record the gap for domain-modeling work. Do not silently invent competing terminology.

## Architecture conflicts

If proposed work contradicts an ADR, identify the conflict explicitly. A change may supersede an ADR only after the scope/decision change is documented and approved; never silently rewrite the historical reason for a decision after implementation begins.
