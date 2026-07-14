# ADR-0004: Colyseus map rooms and hidden placement

- Status: Accepted
- Date: 2026-07-14

## Context

Players should experience logical village and forest locations rather than server browsers or room identifiers. Public maps need capacity, overflow, party cohesion, and reconnection. Building room lifecycle, state patches, matchmaking, and reconnect tokens from raw WebSockets would delay the slice.

## Decision

Use Colyseus with its standard WebSocket transport. One room represents one ephemeral instance of one logical map. A placement module selects rooms by reconnect reservation, party destination/reservation, soft population target, new public instance, then overflow.

Normal payloads and UI expose logical map names only. Internal room IDs may appear solely in gated development overlays and logs. Pin Colyseus only after the foundation issue proves the required per-client filtering and documents the upgrade path.

Party reservations are atomic in memory in the single process. Short disconnects restore the live entity; longer recovery requests a new play ticket and returns to a valid logical map and safe spawn.

## Consequences

- Players never manage infrastructure concepts.
- Full maps can overflow and coordinated parties can remain together.
- Placement and reservation races require explicit matrix and multi-client tests.
- Multi-process deployment would require distributed presence/reservations and a new ADR.

## Alternatives considered

### Raw WebSockets and custom rooms

Rejected because the project would own reconnection, state patching, lifecycle, admission, and matchmaking before proving the game.

### One permanent global room per map

Rejected because it has no capacity/overflow path and makes party/recovery evolution harder.

### Player-selected instances

Rejected because it violates the approachable-world experience and exposes operational topology.

### Redis from the start

Rejected because one server process can keep presence and reservations in memory. Redis becomes relevant only after horizontal scaling is measured and approved.
