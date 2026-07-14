# ADR-0008: Explicit public, private, client-safe, and server-only state

- Status: Accepted
- Date: 2026-07-14

## Context

Map rooms synchronize public presence while each character also owns inventory, quests, currency, loot, errors, and hidden identifiers. A broad shared state model could leak private player information or hidden game rules.

## Decision

Define explicit state and content visibility classes:

- Public room state: ephemeral entity identity, display name, position, facing, animation/combat state, public appearance, and appropriate health/resource fractions.
- Private character results: inventory, currency, quests, loot, exact identity, cooldown/resource corrections, eligibility failures, and transaction responses.
- Client-safe content: presentation and interaction hints required to render the game.
- Server-only content/state: rewards, drop rolls, eligibility, threat, behavior internals, secrets, and infrastructure identifiers.

Prove Colyseus per-client filtering in the foundation and cover public/private boundaries with contract and multiplayer tests. Expected rejections use stable safe codes; unknown errors return generic responses with server-side correlation context.

## Consequences

- Data exposure is minimized by design rather than UI convention.
- Protocol changes require an explicit audience and tests.
- Some player-specific results travel as targeted messages instead of shared room state.
- Debug overlays and logs require independent production gates and privacy review.

## Alternatives considered

### One synchronized room schema containing everything

Rejected because filtering by client convention is fragile and a schema mistake could expose inventory, quests, rewards, identity, or hidden rules.

### Client filtering after receipt

Rejected because data already delivered to an untrusted browser is not private.

### Separate microservice for private state

Rejected because visibility is a protocol/module concern, not evidence for another deployable.

### Exposing room IDs for troubleshooting

Rejected in normal payloads because it breaks the world abstraction. Gated development overlays and structured logs are sufficient.
