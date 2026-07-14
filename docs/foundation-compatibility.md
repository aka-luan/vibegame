# Foundation compatibility evidence

Checked on 2026-07-14 for issue #1. All runtime and tool dependencies use exact
versions in workspace manifests and `pnpm-lock.yaml`.

| Boundary                                 | Pin                                  | Evidence and decision                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js                                  | 24.18.0                              | Local typecheck, tests, builds, and server runtime.                                                                                                                                                                |
| pnpm                                     | 11.10.0                              | Exact `packageManager`; lockfile enforces a 24-hour minimum release age and explicit dependency build-script decisions.                                                                                            |
| TypeScript                               | 6.0.3                                | TypeScript 7.0.2 was rejected because the mature `typescript-eslint` 8.63.0 peer range ends below 6.1.                                                                                                             |
| Phaser                                   | 4.2.1                                | Production build and Chromium smoke render a Tiled JSON map, six render layers, a depth-layered sprite, and resize behavior behind `WorldRenderer`.                                                                |
| React / React DOM                        | 19.2.7                               | Semantic overlay renders above Phaser and retains keyboard focus in Chromium.                                                                                                                                      |
| Vite                                     | 8.1.4                                | Development server and production build pass on pinned Node. The foundation bundle is intentionally unoptimized and produces a large-chunk warning; gameplay optimization is not part of issue #1.                 |
| Fastify                                  | 5.10.0                               | `/health` and `/ready` are contract-tested through Fastify injection; Fastify remains the only HTTP application router.                                                                                            |
| Colyseus core / WebSocket / schema / SDK | 0.17.42 / 0.17.13 / 4.0.27 / 0.17.43 | Two real headless clients prove `StateView` sends public names to both clients and each private value only to its owner. The spike found that schema 4 requires attaching a state object before `StateView.add()`. |
| PostgreSQL                               | 18.4 (`postgres:18.4-alpine3.24`)    | Compose health check and a real-client integration test cover ready/unavailable responses.                                                                                                                         |
| Drizzle ORM / Kit                        | 0.45.2 / 0.31.10                     | Typed PostgreSQL connection and forward-migration configuration compile. Durable game tables remain a later issue.                                                                                                 |
| Zod                                      | 4.4.3                                | Content, configuration, and join options reject untrusted input at their boundaries.                                                                                                                               |
| Vitest / Playwright                      | 4.1.10 / 1.61.1                      | Unit, integration, multiplayer, and Chromium lanes are separate commands.                                                                                                                                          |

## Colyseus packaging note

The `colyseus` convenience meta-package was evaluated and rejected for this
workspace because it installs Redis and uWebSockets transports that the approved
architecture explicitly excludes. The application instead pins official
`@colyseus/core` plus `@colyseus/ws-transport`.

The WebSocket transport has a mandatory Express peer import. Express 5.2.1 is
therefore present only as a compatibility peer; application HTTP routes and
lifecycle remain Fastify-owned. Remove the peer when a future compatible
transport release no longer imports it, after rerunning the same multiplayer and
single-server tests.

## Upgrade and fallback notes

- Keep Phaser behind `WorldRenderer`. Before any Phaser upgrade, rerun the Tiled
  layer, sprite depth, resize, focus, and production-build checks. If Phaser 4
  regresses, hold 4.2.1 while evaluating a newer compatible Phaser release; a
  renderer replacement requires an approved architecture change.
- Upgrade Colyseus core, transport, schema, and SDK as a compatible set. Rerun
  the two-client privacy regression before accepting any version. Do not fall
  back to client-side filtering or add Redis/uWebSockets to work around an
  upgrade.
- PostgreSQL minor releases may advance only with the real readiness and future
  migration-from-empty lanes green. Never rewrite an applied migration.
