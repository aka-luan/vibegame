# Gameish

Gameish is an original browser-first cooperative action RPG. The repository
includes an authoritative multiplayer-presence slice plus the production-shaped
guest character/admission flow: a browser can create or restore a guest identity,
create/select a character, and receive a one-time village play ticket.

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

For the durable account flow, run `pnpm db:migrate` first. The web development
proxy forwards `/api`, room, and development-ticket requests to the server. The
server accepts the browser origin configured by `PUBLIC_ORIGIN`; keep it on the
same approved site as the browser delivery origin.

The server refuses to start if development login is enabled with
`NODE_ENV=production`. Internal room identity is shown only inside the separately
gated development inspection panel; normal UI and synchronized state omit it.

### Development latency and short recovery

The development inspection panel includes a 0–500 ms simulated round-trip
latency control plus prediction-error and server-time-offset diagnostics. These
controls are available only when the development-login build gate is enabled;
they cannot activate in a production-mode build.

An unexpected room connection loss reserves the existing live entity for five
seconds. The browser retries after 100 ms with bounded backoff up to 500 ms and
buffers at most 120 fixed-step intentions. A successful retry keeps the same
ephemeral entity and receives a fresh targeted authoritative movement snapshot.
If the grace expires, the server removes the entity and its pending intentions;
cross-room and long logical-location recovery remain later milestones. The
server emits structured `disconnected`, `reconnected`, and `removed` lifecycle
events without room, session, user, or character identifiers.

Run the opt-in ten-minute two-client latency check with
`RUN_LATENCY_SOAK=true pnpm test:multiplayer`. It alternates movement at 200 ms
round-trip latency and fails on growing prediction error, authoritative
divergence, or a stale observer entity. The normal multiplayer lane omits this
wall-clock soak.

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
`pnpm content:validate`, `pnpm db:generate`, `pnpm db:migrate`, and
`pnpm db:seed`. Review every generated SQL migration before applying or
committing it. The deterministic seed is intended for the disposable local
database only; it creates a clearly identified guest sample and initial content
references and is safe to run repeatedly.

To reproduce the clean-runner condition locally, start from a fresh checkout,
install with `pnpm install --frozen-lockfile`, and remove only ignored workspace
build output before invoking each affected validation command:

```bash
find apps packages -type d -name dist -prune -exec rm -rf {} +
pnpm test
find apps packages -type d -name dist -prune -exec rm -rf {} +
pnpm test:integration # requires pnpm db:up
find apps packages -type d -name dist -prune -exec rm -rf {} +
pnpm test:multiplayer
```

Each command rebuilds the runtime workspace exports it consumes. The unit,
integration, and multiplayer CI jobs therefore remain independent of the build
job and of one another.

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
