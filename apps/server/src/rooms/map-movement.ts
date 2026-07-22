import type { ServerMapArtifact } from "@gameish/content";
import { moveCharacterFoot, PLAYER_MOVEMENT } from "@gameish/world";

import type { CharacterCollisionShape } from "./spawn-resolution.js";

export interface FootMovable {
  x: number;
  y: number;
  facing: "east" | "west";
  animation: "idle" | "walk";
}

/**
 * Applies one fixed-step movement update to a player's foot position.
 * Shared by every room so navigation/collision integration exists exactly
 * once. Movement is skipped (idle animation only) when `intention` is
 * absent or `movementLocked` is set (rooms with combat may lock movement
 * during a control effect; the forest room never sets it).
 */
export function applyFootMovementStep(input: {
  player: FootMovable;
  intention: { x: number; y: number } | undefined;
  movementLocked: boolean;
  map: ServerMapArtifact;
  collision: CharacterCollisionShape;
}): void {
  const isMoving =
    !!input.intention && (input.intention.x !== 0 || input.intention.y !== 0);
  input.player.animation = isMoving && !input.movementLocked ? "walk" : "idle";
  if (!isMoving || input.movementLocked || !input.intention) return;
  if (input.intention.x < 0) input.player.facing = "west";
  else if (input.intention.x > 0) input.player.facing = "east";
  const moved = moveCharacterFoot({
    footPosition: input.player,
    direction: input.intention,
    speed: PLAYER_MOVEMENT.speed,
    elapsedMs: PLAYER_MOVEMENT.fixedStepMs,
    collision: input.collision,
    world: { bounds: input.map.bounds, obstacles: input.map.collision },
  });
  input.player.x = moved.x;
  input.player.y = moved.y;
}
