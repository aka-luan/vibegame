# ADR-0002: One modular-monolith deployable

- Status: Accepted
- Date: 2026-07-14

## Context

The initial slice needs HTTP sessions, room admission, placement, real-time simulation, and durable transactions. It does not yet need independent scaling teams, heterogeneous runtimes, or multiple server processes. Operational complexity directly competes with gameplay delivery.

## Decision

Run Fastify HTTP and Colyseus WebSockets on one Node HTTP server in one deployable. Keep authentication, placement, rooms, simulation, persistence coordination, security, and observability as explicit internal modules with narrow interfaces.

Use pnpm workspace packages only for stable boundaries that genuinely need independent imports: protocol, content, pure world logic, and database access.

## Consequences

- Local and initial production deployment stay small and debuggable.
- Durable operations can be coordinated without distributed transactions or messaging.
- Module boundaries must be enforced in code and tests rather than by network separation.
- A later multi-process shape will require distributed presence and reservations, but only after measurement proves the need.

## Alternatives considered

### Microservices

Rejected because they add service discovery, deployment coordination, distributed failure, tracing, message/version management, and broader security surface without a demonstrated scaling boundary.

### Separate HTTP and game-server deployables

Rejected initially because the same-origin session shape and one-process room placement are simpler. Modules remain separable later if measured load requires it.

### Workers, queues, or an event bus

Rejected because no approved slice behavior requires asynchronous distributed work. Durable transactions and explicit in-process calls are sufficient.
