# ADR-0005: PostgreSQL with Drizzle and explicit transactions

- Status: Accepted
- Date: 2026-07-14

## Context

Guest identity, character state, rewards, quests, currency, inventory, equipment, and recovery need durable relational invariants. Reward replay and concurrent equipment or purchase operations must not corrupt or duplicate state.

## Decision

Use PostgreSQL for durable state and Drizzle for TypeScript schema definitions, queries, repositories, and generated SQL migrations. Review generated SQL before applying it.

Use database constraints, explicit transactions, revisions or row locks where appropriate, and idempotency records. Character creation, rewards, quest completion, purchases, equipment changes, and progression unlocks are atomic. Room simulation stays in server memory; position is checkpointed rather than written every tick.

## Consequences

- Relational constraints and transactions protect gameplay invariants.
- Migration SQL remains visible and reviewable.
- Integration tests require real PostgreSQL, including concurrency and migration-from-empty coverage.
- Durable failure must reject mutations rather than report optimistic success.

## Alternatives considered

### Prisma

Rejected for this small TypeScript system because Drizzle keeps schema and queries closer to TypeScript while exposing reviewed SQL migrations with less separate schema machinery.

### Document database

Rejected because ownership, unique slots, balances, transactions, idempotency, and cross-record consistency are central rather than incidental.

### In-memory or file persistence

Rejected beyond early adapters because it cannot prove restart durability, concurrency, constraints, or responsible external testing.

### PostgreSQL as live simulation storage

Rejected because per-tick positions, aggro, cooldowns, and spawn timers are ephemeral room state and would create unnecessary latency and write load.
