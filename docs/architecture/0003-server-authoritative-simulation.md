# ADR-0003: Server-authoritative simulation

- Status: Accepted
- Date: 2026-07-14

## Context

A multiplayer RPG must keep movement, combat, rewards, quests, and inventory consistent between untrusted browsers. Trusting client outcomes would make cheating and divergent state structural problems.

## Decision

Clients send intentions. The server owns fixed-step movement, collision, targeting range, cooldowns, resources, combat outcomes, monster AI, participation, rewards, quest transitions, purchases, and inventory mutation.

Allow local movement prediction using the same pure world rules, followed by authoritative reconciliation. Interpolate remote entities. Use server time for cooldowns and telegraphs and inject clocks and seeded RNG for tests. Target validation is range-based in the vertical slice; line-of-sight raycasting is deferred.

## Consequences

- Client manipulation cannot directly forge durable or public outcomes.
- The game remains playable under latency through bounded prediction and interpolation.
- Server tick performance and reconciliation behavior require measurement and multiplayer tests.
- Shared pure geometry/movement must remain deterministic and free of browser or server runtime dependencies.

## Alternatives considered

### Client-authoritative movement or combat

Rejected because speed, damage, cooldown, drop, and position forgery would be unavoidable and difficult to repair later.

### Lockstep deterministic simulation on every client

Rejected because browser timing, late joins, hidden/private state, persistent transactions, and variable network conditions make it a poor fit for this RPG.

### No prediction

Rejected because round-trip input latency would make movement feel sluggish. Prediction is deliberately limited to local movement to constrain complexity.
