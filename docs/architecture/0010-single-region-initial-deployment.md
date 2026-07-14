# ADR-0010: One North American deployment without distributed infrastructure

- Status: Accepted
- Date: 2026-07-14

## Context

Local development must cost $0, while reliable external testing eventually needs TLS, durable storage, observability, backups, and predictable availability. Capacity is unknown until representative load tests exist.

## Decision

Develop locally with Vite, one Node server, PostgreSQL in Docker Compose, and local structured logs. For reliable external testing, deploy one North American Node container behind a TLS reverse proxy with PostgreSQL and a separate encrypted backup destination.

Serve browser and API through the same origin or approved same-site subdomains. Begin without Redis, Kubernetes, a load balancer, or multiple regions. Choose machine size from M9 load/soak evidence; do not claim CCU capacity before measurement.

Free remote services may be used only for temporary controlled demos with explicit uptime and durability caveats.

## Consequences

- Deployment and recovery remain operable by one maintainer.
- One process is a known availability and scale boundary.
- Backups, restore drills, metrics, graceful room draining, and rollback are required before external release.
- Scaling decisions are driven by tick duration, event-loop lag, join/transition latency, CPU/memory, message volume, and database evidence.

## Alternatives considered

### Split-origin free static and API hosts

Rejected as the primary shape because unrelated origins break the approved cookie session model and free services may sleep or lose durable data.

### Kubernetes and horizontal scaling initially

Rejected because they require distributed presence, room placement, party reservations, reconnection coordination, and greater operational burden before measured need.

### Multiple regions

Rejected because cross-region identity, placement, parties, database consistency, and operational cost are outside the slice.

### Managed PostgreSQL from day one

Deferred rather than rejected permanently. It becomes preferable when backup/recovery risk, contention, query latency, or maintainer burden justifies the cost.
