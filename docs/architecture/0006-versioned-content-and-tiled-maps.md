# ADR-0006: Versioned content files and compiled Tiled maps

- Status: Accepted
- Date: 2026-07-14

## Context

The slice needs authored maps, classes, abilities, monsters, loot, NPCs, dialogue, quests, shops, items, encounters, and progression. Content must be reviewable, reproducible, safe to ship separately to client and server, and replaceable without scattering rules through code.

## Decision

Keep canonical content in validated, version-controlled files with stable namespaced IDs and schema versions. Use Zod schemas and build/startup reference validation. Compile immutable server catalogs containing hidden rules and client catalogs containing presentation-safe data.

Author maps in Tiled JSON with explicit rendering, collision, navigation, interactive, spawn, portal, and entity layers. Compile separate client-rendering and server-geometry artifacts. Bind room entry to the deployed content version and reject stale clients.

## Consequences

- Content changes are diffable, reproducible, and testable.
- Missing references, circular quest prerequisites, broken portals, unreachable required spawns, and incompatible assets fail before play.
- Client/server secrecy requires deliberate schema and compiler boundaries.
- An admin authoring tool can be added later only if publishing still emits the same immutable artifacts.

## Alternatives considered

### Canonical live database content

Rejected because arbitrary runtime edits make review, rollback, version matching, cache behavior, and deterministic tests harder.

### Hardcoded TypeScript content

Rejected because authoring and art/content replacement would require gameplay-code changes and weaken validation boundaries.

### Procedural maps

Rejected because the product decision is compact authored areas and procedural generation is outside the slice.

### Shipping raw Tiled files to both sides

Rejected because the browser should not receive hidden server metadata and the server should not load unnecessary rendering payloads.
