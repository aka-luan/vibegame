# Gameish

Gameish is an original browser-first cooperative action RPG. This repository is
currently includes an authoritative multiplayer-presence slice: two development
browser sessions can enter one validated village, see public placeholder
appearances, and move through server-owned fixed-step collision. Durable guest
identity and game tables remain later milestones.

## Prerequisites

- Node.js `24.18.0` (see `.nvmrc` and `.node-version`)
- Corepack with pnpm `11.10.0`
- Docker Compose for the PostgreSQL integration lane

## Fresh setup

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:up
NODE_ENV=development DEVELOPMENT_LOGIN_ENABLED=true VITE_DEVELOPMENT_LOGIN_ENABLED=true pnpm dev
```

Open `http://127.0.0.1:5173`. The server listens on
`http://127.0.0.1:2567` by default:

- `GET /health` reports whether the process is serving requests.
- `GET /ready` reports whether PostgreSQL answers a query and returns HTTP 503
  with `DATABASE_UNAVAILABLE` when it does not.
- `POST /development/play-ticket` exists only when development login is
  explicitly enabled. Its short-lived ticket admits one village-room join.

The server refuses to start if development login is enabled with
`NODE_ENV=production`. Internal room identity is shown only inside the separately
gated development inspection panel; normal UI and synchronized state omit it.

Stop local PostgreSQL with `pnpm db:down`. The Compose volume is persistent;
`docker compose down -v` is intentionally not scripted because it deletes the
disposable database.

## Stable repository commands

```bash
pnpm validate
pnpm lint
pnpm format:check
pnpm test
pnpm test:integration  # requires pnpm db:up
pnpm test:multiplayer
pnpm test:e2e
pnpm build
```

Focused development commands include `pnpm typecheck`,
`pnpm content:validate`, `pnpm db:generate`, and `pnpm db:migrate`. Review every
generated SQL migration before applying or committing it. The foundation has no
durable schema, so its migrations directory contains instructions rather than a
placeholder game table.

## Boundaries proven here

- Phaser owns the responsive world canvas, bounded camera, layered Tiled map,
  interaction marker, and foot-origin entity ordering.
- React owns the semantic DOM overlay and explicit focus handoff back to the
  world canvas.
- `packages/world` provides pure deterministic movement and collision used by
  the authoritative room at a fixed 20 Hz.
- Canonical Tiled and character-manifest sources validate and compile into
  client-safe rendering/prediction artifacts and separate server geometry.
- Fastify and Colyseus share one Node HTTP server in one process.
- Development play tickets are short-lived and single-use; replay, expiry, and
  invalid room intentions fail with stable safe codes.
- Colyseus `StateView` synchronization exposes each player's private sample
  field only to that client while public display fields reach both clients.
- Canonical content, maps, and asset manifests are validated by Zod and invalid
  inputs report stable paths.
- PostgreSQL readiness is separate from process health.

See [foundation compatibility evidence](docs/foundation-compatibility.md) for
the exact pins, spike results, and upgrade notes.
