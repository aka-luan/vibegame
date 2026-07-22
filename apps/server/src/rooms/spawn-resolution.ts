import type { ServerMapArtifact } from "@gameish/content";
import type { DurableCharacterState } from "@gameish/database";

export interface CharacterCollisionShape {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/**
 * Resolves where a joining/transitioning character should appear on a
 * logical map. Shared by every room (village, forest, and any future map)
 * so the "resume the checkpointed position at the same named entrance,
 * otherwise spawn at the ticket's entrance" rule (AC3/AC4) is implemented
 * exactly once.
 *
 * Returns `undefined` only when `entranceId` does not name a real spawn on
 * `map` — callers should treat that as `ENTRANCE_NOT_FOUND`, a content
 * defect (a ticket, portal, or checkpoint pointing at an entrance that
 * doesn't exist on this map).
 */
export function resolveSpawnPosition(input: {
  map: ServerMapArtifact;
  entranceId: string;
  savedState: DurableCharacterState | undefined;
  collision: CharacterCollisionShape;
}): { x: number; y: number } | undefined {
  const spawn = input.map.spawns.find(
    (candidate) => candidate.entranceId === input.entranceId,
  );
  if (!spawn) return undefined;
  const saved = validSavedPosition({
    map: input.map,
    entranceId: input.entranceId,
    state: input.savedState,
    collision: input.collision,
  });
  return saved ?? { x: spawn.x, y: spawn.y };
}

/**
 * A saved checkpoint is only honored when it is on this same map, at this
 * same named entrance, and still lands in walkable, in-bounds, obstacle-free
 * space. Otherwise the ticket's entrance is authoritative — this is what
 * stops a stale or tampered checkpoint from spawning a character inside a
 * wall or on a map they don't currently have a ticket for.
 */
function validSavedPosition(input: {
  map: ServerMapArtifact;
  entranceId: string;
  state: DurableCharacterState | undefined;
  collision: CharacterCollisionShape;
}): { x: number; y: number } | undefined {
  const location = input.state?.location;
  if (
    !location ||
    location.logicalMapId !== input.map.id ||
    location.entranceId !== input.entranceId
  ) {
    return undefined;
  }
  const { x, y } = location.position;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const body = {
    x: x + input.collision.offsetX - input.collision.width / 2,
    y: y + input.collision.offsetY - input.collision.height / 2,
    width: input.collision.width,
    height: input.collision.height,
  };
  const insideBounds =
    body.x >= input.map.bounds.x &&
    body.y >= input.map.bounds.y &&
    body.x + body.width <= input.map.bounds.x + input.map.bounds.width &&
    body.y + body.height <= input.map.bounds.y + input.map.bounds.height;
  if (!insideBounds) return undefined;
  if (
    input.map.collision.some(
      (obstacle) =>
        body.x < obstacle.x + obstacle.width &&
        body.x + body.width > obstacle.x &&
        body.y < obstacle.y + obstacle.height &&
        body.y + body.height > obstacle.y,
    )
  ) {
    return undefined;
  }
  return { x, y };
}
