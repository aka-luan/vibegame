# ADR-0011: Side-view perspective with a walkable ground region

- Status: Accepted
- Date: 2026-07-17
- Amends: ADR-0009 (facing set)

## Context

The plan originally approved a top-down perspective. The repository owner
redirected the product on 2026-07-17 to a 2D side-view presentation: maps are
horizontally composed side-view spaces, and movement is horizontal traversal
plus shallow vertical positioning for depth. The game is explicitly not
top-down, isometric, or platforming — there is no gravity, jumping, or
tile-locked movement.

## Decision

Adopt a side-view world presentation with limited planar movement:

- Every map defines a walkable ground region. Server-authoritative movement and
  client prediction constrain positions to it; the region compiles from the
  existing collision/navigation Tiled layers into the server geometry artifact.
- Movement stays continuous 2D integration in `packages/world`. The vertical
  axis remains a real simulation axis, bounded by the ground region rather than
  by full-map collision freedom.
- Characters render from a side or three-quarter-side perspective. The slice
  ships left and right facings; west may mirror east. Vertical movement keeps
  the current horizontal facing. This amends ADR-0009's four-facing manifest
  requirement; the manifest schema still declares its facing set, now
  east/west for the slice.
- Depth ordering continues to sort by declared foot origin: entities lower in
  the walkable band draw in front, which is what produces the visual depth of
  the shallow vertical axis.

## Consequences

- Existing authoritative-movement, prediction, and reconciliation code is
  unaffected in shape; only map geometry and facing derivation change.
- Village and forest maps must be authored (or re-authored) as horizontal
  compositions with an explicit ground band.
- Placeholder and production character art needs only two facings, reducing
  asset burden relative to four.
- Camera work follows horizontal traversal; vertical camera range is small.

## Alternatives considered

### Platformer physics (gravity, jumping)

Rejected: changes the combat and traversal fantasy, invalidates the approved
target-based hotbar combat pacing, and adds physics scope.

### Pure single-axis side-scroller (no vertical movement)

Rejected: removes positioning depth for cooperative combat and crowds all
entities onto one line, hurting readability with 20–30 players.

### Keeping four rendered facings

Rejected: north/south sprites contradict a side-view presentation; vertical
movement reads naturally with a retained horizontal facing.
