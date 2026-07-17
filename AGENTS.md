# Repository Guide for Agents

## Read before changing the repository

Read `PLAN.md` before proposing or making work. It is the product and delivery authority. Read every relevant record under `docs/architecture/` before changing a boundary or technology decision.

The repository owner approved the planning documents and authorized application implementation on 2026-07-14. Work only from an approved `ready-for-agent` issue whose blockers are complete.

Codex must not expand scope without first documenting:

1. The exact proposed change.
2. Why the approved outcome cannot be achieved without it.
3. Alternatives considered.
4. New risks, dependencies, costs, and deferred work.
5. Changes to milestones, acceptance criteria, and definition of done.

The expansion requires explicit repository-owner approval before implementation. Convenience, anticipated future use, or a more general abstraction is not sufficient justification.

## Project mission

Build an original browser-first, 2D side-view multiplayer action RPG with approachable cooperative play. Maps are horizontally composed side-view spaces with a defined walkable ground region; movement is horizontal traversal plus shallow vertical positioning for depth. It is not a top-down, isometric, or platforming game; characters render from a side or three-quarter-side perspective. Never copy protected games' names, characters, classes, maps, stories, distinctive UI, animations, or assets. Generic genre inspiration is permitted; substantially similar expression is not.

## Repository conventions

- Use pnpm workspaces and TypeScript for runtime code, shared contracts, tools, and tests.
- Keep changes small, independently reviewable, and tied to one approved issue.
- Prefer deep domain modules with narrow interfaces over generic helper layers.
- Do not create generic `shared`, `utils`, or `services` dumping grounds.
- Use stable domain vocabulary from `PLAN.md` and `CONTEXT.md` when present.
- Keep stable namespaced string IDs for content; never use display names as durable identifiers.
- Keep development-only behavior behind explicit environment gates that fail closed.
- Do not commit generated dependencies, secrets, credentials, local databases, or unlicensed assets.
- Preserve user changes in a dirty worktree and avoid unrelated formatting or refactors.

The intended top-level boundaries are:

- `apps/web`: browser renderer, UI, input, networking, prediction, interpolation, and development overlays.
- `apps/server`: HTTP, auth, placement, rooms, simulation, persistence coordination, security, and observability.
- `packages/protocol`: genuinely network-shared identifiers, payloads, public state, and error codes.
- `packages/content`: schemas, definitions, validation, maps, and compiled client/server catalogs.
- `packages/world`: pure deterministic movement, collision, and geometry.
- `packages/database`: schema, migrations, repositories, transactions, and seeds.
- `tests`: cross-application multiplayer, browser, load, restart, and security tests.
- `tools`: content, map, and asset validation/compilation.

These directories are prospective and may be created only as required by the currently approved implementation issue.

## Approved technology stack

- TypeScript and Node.js, pinned in the foundation issue.
- Phaser 4 for the world renderer after its required compatibility spike.
- React DOM and Vite for accessible interface and browser delivery.
- Colyseus WebSockets and rooms after required per-client filtering validation.
- Fastify on the same Node HTTP server and in the same deployable.
- PostgreSQL with Drizzle and reviewed SQL migrations.
- Zod for untrusted inputs, configuration, and content contracts.
- Tiled JSON for authored maps.
- Vitest, Playwright, headless multiplayer clients, Docker Compose, and real PostgreSQL integration tests.

Do not introduce Redis, queues, workers, microservices, Kubernetes, an event bus, Prisma, a second application language, or a skeletal-animation runtime without an approved plan amendment and ADR.

## Architectural boundaries

### Server authority

- Clients send intentions, never authoritative coordinates or outcomes.
- The server owns movement integration, collision, range, cooldowns, resources, damage, healing, statuses, AI, eligibility, quest progress, loot, purchases, and inventory mutation.
- Client prediction is limited to local movement and must reconcile to server state.
- Server time drives cooldowns and telegraphs; tests inject deterministic clocks and RNG.
- Durable success is reported only after its transaction commits.

### State privacy

- Public room state contains only data another nearby player must render or understand.
- Never broadcast user IDs, session credentials, internal room IDs, full inventory, full quest state, private loot, transaction data, hidden eligibility, threat tables, or debug state.
- Public/private filtering behavior requires automated regression coverage.

### HTTP, rooms, and persistence

- HTTP owns sessions, character selection, one-time play tickets, health/readiness, and safe version metadata.
- Colyseus rooms own live fixed-step map simulation and ephemeral room state.
- PostgreSQL owns durable state and never acts as the live per-tick simulation store.
- Placement hides instance selection and preserves party capacity atomically in one process.
- Cross-module access goes through explicit domain interfaces; do not reach into another module's storage or internals.

### Client boundaries

- Phaser owns the world canvas; React owns semantic panels and accessibility behavior.
- Define deliberate coordination interfaces rather than sharing mutable stores implicitly.
- Browser code must never import server or database packages.
- `packages/protocol` must not become a path for sharing server-only business rules.

## Validation commands

Once the foundation issue defines them, these commands are required repository interfaces:

```text
pnpm validate
pnpm lint
pnpm format:check
pnpm test
pnpm test:integration
pnpm test:multiplayer
pnpm test:e2e
pnpm build
```

Run the narrowest relevant command while iterating and every applicable command before handoff. Do not claim validation that was not run. If a required command cannot run, report the exact blocker and what was run instead.

Documentation-only changes require at least Markdown/link checks when available, an internal-reference search, and review of the rendered structure. Before the foundation exists, inspect diffs and repository status manually.

## Testing expectations

- Pure movement, collision, combat, quest, placement, and validation logic requires deterministic unit tests.
- Network payload, content, map, asset, configuration, and environment boundaries require contract tests.
- Database behavior requires a real PostgreSQL instance, migration-from-empty coverage, constraints, idempotency, and concurrency tests.
- Multiplayer behavior requires headless multi-client tests under latency and disconnection.
- User journeys, focus, keyboard operation, and multiple browser contexts require Playwright.
- Every fixed security defect requires a hostile-input or regression test.
- Production gates require load, soak, restart, migration, backup/restore, and rollback evidence.
- Manual checks listed in an issue are mandatory but do not replace automatable criteria.
- Test externally meaningful behavior and invariants; avoid assertions coupled only to private implementation.

## Security and privacy rules

- Treat every client, HTTP payload, WebSocket message, content file, map, configuration value, and environment variable as untrusted until validated.
- Guest credentials use `HttpOnly`, `Secure`, `SameSite` cookies and hashed server-side secrets.
- Play tickets are short-lived, single-use, nonce-bound, character-bound, destination-bound, and content-version-bound.
- Enforce same-origin or explicitly approved same-site deployment for guest sessions.
- Enforce action rates, message sizes, normalized movement, proximity, eligibility, cooldowns, and violation scoring server-side.
- Use stable safe error codes; never expose stack traces, secrets, SQL, or infrastructure details to clients.
- Do not log session credentials, ticket secrets, unnecessary personal data, or full private game state.
- Reward, quest-completion, equipment, purchase, and currency mutations must be atomic and idempotent.
- Database failure must reject durable mutations rather than simulate success.
- Development login, debug endpoints, internal instance inspection, and chat must fail closed in production.
- No real-money system is permitted.

## Content conventions

- Canonical definitions live in version-controlled files, not mutable live database rows.
- Each definition has a stable namespaced ID, schema version, tags, display data, and explicit client-visible/server-only fields.
- References resolve at build and startup; duplicate or missing IDs are fatal.
- Reject circular quest prerequisites, invalid portal destinations, unreachable required spawns, incompatible assets, and stale content versions.
- Compile immutable versioned client and server catalogs. Never ship hidden rewards, loot rules, eligibility, or behavior state to the client.
- Keep the initial vocabulary bounded to the objective, effect, item, encounter, and map types approved in `PLAN.md`.
- New content must stay within the approved counts unless the scope-control rule is followed.

## Map conventions

Maps are authored as horizontally composed side-view spaces with a defined walkable ground region that bounds vertical positioning. Tiled sources must distinguish client render data from authoritative server geometry and metadata. Required logical layers/groups are:

- `background`, `ground`, `below_entities`, `entities`, `foreground`, `effects`
- `collision`, `navigation`, `interactives`, `spawns`, `portals`

Render layers go only to the client artifact as needed. Collision, navigation, spawn, portal, and interaction metadata compile into a minimal server artifact. Entities sort by declared foot origin rather than image bounds. Portal destinations use stable logical map and named entrance IDs, never client coordinates.

## Asset conventions

- Use one manifest-defined canonical rig for the slice.
- Manifests declare canvas, scale, foot origin, collision separately from pixels, facings, animations, frame timing, attachments, layer depth, and fallbacks.
- Required character states are `idle`, `walk`, `attack_basic`, `ability_1` through `ability_4`, `hit`, and `defeated`.
- The slice renders left and right side-view facings; west may mirror east. Vertical movement keeps the current horizontal facing.
- Compatible equipment layers share frame timing, canvas, origin, and direction with the base rig.
- Gameplay talks to a narrow renderer interface; never hardcode item-specific art paths or pixel positions in combat/equipment rules.
- Every asset records license, provenance, source, export tool/version, rig version, dimensions, frame arrangement, and replacement compatibility.
- Do not trace maps or use protected-game screenshots, names, or assets as production or prompt references.

## Database and migration rules

- Generate migrations, then review the SQL before applying or committing it.
- Never rewrite a migration already used outside an expendable local environment; add a new forward migration.
- Enforce ownership, slot uniqueness, nonnegative currency/quantity, revision, and idempotency invariants in the database where possible.
- Character creation, rewards, quest completion, purchases, equipment changes, and progression unlocks are explicit transactions.
- Seeds are deterministic and safe to run repeatedly in development.
- Tests must prove migration from empty and the relevant upgrade path.
- Never use destructive database commands against an environment not explicitly identified as disposable.

## Errors, logging, and observability

- Use stable typed domain codes such as `OUT_OF_RANGE`, `ABILITY_ON_COOLDOWN`, `MAP_LOCKED`, `INSTANCE_UNAVAILABLE`, `STALE_CONTENT_VERSION`, and `STALE_CHARACTER_REVISION`.
- Expected domain rejection is not an exception leak.
- Carry a correlation or action ID through each request/action.
- Log structured operational context without credentials or unnecessary private data.
- Measure tick duration, event-loop lag, message volume, joins, transitions, disconnect/reconnect, rejected intentions, transaction latency/failures, client load/FPS, and errors by stable code.
- Do not claim concurrency capacity without representative load and soak evidence.

## Git and handoff discipline

- Do not initialize, change remotes, commit, push, close issues, or open pull requests unless the user asks.
- Never use destructive commands such as `git reset --hard` or discard user changes without explicit approval.
- Keep each implementation issue independently reviewable and leave validation green.
- Update an ADR when a major decision changes; supersede rather than silently rewrite decision history after implementation begins.
- Handoff with outcome, changed files, validation performed, remaining risks, and explicit non-goals.

## Definition of done

Use the ticket and vertical-slice definitions in `PLAN.md`. At minimum, an implementation ticket is not done until its end-to-end outcome works, acceptance criteria and manual checks pass, applicable automated validations pass, boundaries remain intact, content/assets validate, and the repository remains runnable for the next ticket.

## Agent skills

### Issue tracker

Issues live in `aka-luan/vibegame` on GitHub. External pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels, including `ready-for-agent` for fully specified work. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Consult `CONTEXT.md` when present and relevant ADRs under `docs/architecture/`. See `docs/agents/domain.md`.
