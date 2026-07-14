# Gameish

Gameish is an original browser-first cooperative action RPG. This repository is
currently at the technical-foundation milestone: it intentionally contains a
non-game browser shell, one server compatibility room, content validation, and
local PostgreSQL wiring—no gameplay or durable game tables.

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
pnpm dev
```

Open `http://127.0.0.1:5173`. The server listens on
`http://127.0.0.1:2567` by default:

- `GET /health` reports whether the process is serving requests.
- `GET /ready` reports whether PostgreSQL answers a query and returns HTTP 503
  with `DATABASE_UNAVAILABLE` when it does not.

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

- Phaser owns the responsive world canvas and renders a small Tiled JSON map
  with the approved layer vocabulary; a sprite is depth-layered within it.
- React owns the semantic, keyboard-focusable DOM overlay.
- Fastify and Colyseus share one Node HTTP server in one process.
- Colyseus `StateView` synchronization exposes each player's private sample
  field only to that client while public display fields reach both clients.
- Canonical content is validated by Zod and invalid fixtures report stable paths.
- PostgreSQL readiness is separate from process health.

See [foundation compatibility evidence](docs/foundation-compatibility.md) for
the exact pins, spike results, and upgrade notes.
