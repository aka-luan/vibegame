# ADR-0001: Browser-first TypeScript stack

- Status: Accepted
- Date: 2026-07-14

## Context

The product must start quickly in a desktop browser, combine a 2D authored world with accessible DOM interfaces, and remain maintainable by a solo creator using AI-assisted development. Sharing contracts and deterministic world logic between browser and server reduces translation errors.

## Decision

Use TypeScript end to end. Use Phaser 4 for the world canvas, React DOM for interface panels, and Vite for browser development/builds. Pin the exact versions only after the foundation issue proves Tiled rendering, layered sprites, focus handoff, production build behavior, and the required Phaser APIs.

Keep Phaser behind world-rendering interfaces and React behind UI interfaces. Neither framework owns authoritative game rules.

## Consequences

- Network contracts and pure movement logic can share one language and toolchain.
- DOM UI provides better semantic structure, focus control, and text scaling than a canvas-only interface.
- Phaser 4 maturity is a known risk; the compatibility spike and version pin are mandatory.
- React/Phaser coordination needs an explicit seam rather than implicit shared mutable state.

## Alternatives considered

### Godot 4 web client

Rejected for the slice because it adds a GDScript/TypeScript boundary, a larger WebAssembly/WebGL delivery shape, browser-export constraints, and less natural DOM account/accessibility integration. Reconsider only if its editor and animation workflow become a decisive approved requirement.

### PixiJS plus a custom game framework

Rejected because PixiJS is primarily a renderer. The project would need to own cameras, map integration, collision, animation state, interactions, and debugging before proving the game loop.

### Canvas-only Phaser UI

Rejected because semantic controls, keyboard focus, text scaling, dialogue, inventory, and accessibility would require avoidable custom work.
