# ADR-0009: Manifest-driven raster animation for one canonical rig

- Status: Accepted; facing set amended by ADR-0011
- Date: 2026-07-14

## Context

The slice must visibly change equipment while final art direction, resolution, frame counts, and possible future animation technology remain open. Hardcoded sheet geometry or item-specific rendering would make placeholder art expensive to replace.

## Decision

Use replaceable raster sprite sheets or atlases driven by an appearance manifest. The manifest declares rig version, logical canvas, display scale, foot origin, collision separately from pixels, four facings, animation names/timing, attachments, layer order, facing overrides, and missing-asset fallbacks.

Use one canonical rig. Compatible equipment layers align with the base animation. Gameplay and equipment code call a narrow character-renderer interface such as applying appearance, facing direction, and playing a state.

Every asset records license, provenance, source, export metadata, dimensions, rig version, and replacement compatibility.

## Consequences

- Placeholder bodies, armor, weapons, and effects can be replaced without gameplay changes when they honor the manifest.
- Layer synchronization and texture budgets need validation and targeted visual tests.
- Four-direction assets limit initial production burden; manifests may represent eight directions later.
- The renderer adapter preserves an upgrade path without prebuilding it.

## Alternatives considered

### Skeletal animation initially

Rejected because it adds rigging tools, runtime/licensing choices, attachment behavior, and integration risk before the core slice is proven.

### Hardcoded frame dimensions and paths

Rejected because art replacement would spread changes through rendering and gameplay code.

### Multiple body rigs

Rejected because every animation and equipment layer would multiply, conflicting with the bounded slice.

### Baked full-character sheets for every equipment combination

Rejected because combinations grow rapidly and would undermine visible modular equipment.
