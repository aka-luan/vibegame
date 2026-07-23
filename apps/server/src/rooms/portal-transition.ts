import type { ServerMapArtifact } from "@gameish/content";
import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";
import { z } from "zod";

import { destinationRoomName, LOGICAL_MAPS } from "./logical-maps.js";

export const portalTransitionSchema = z
  .object({
    actionId: z.string().trim().min(1).max(64),
    portalId: z.string().trim().min(1).max(80),
    travelMode: z.literal("alone").optional(),
  })
  .strict();

export const PORTAL_TRANSITION_COOLDOWN_MS = 2_000;
export const PORTAL_PROXIMITY_RADIUS = 48;

export type PortalTransitionEvaluation =
  | {
      ok: true;
      destinationMapId: string;
      destinationEntranceId: string;
      destinationRoomName: string;
    }
  | { ok: false; code: ErrorCode };

/**
 * Server-authoritative evaluation of a portal transition request. Pure and
 * deterministic (all inputs are explicit, including "now") so it is unit
 * testable without a running Colyseus room. Both the village and forest
 * rooms call this identically — the only thing that differs between them is
 * which `sourceMap` they pass in.
 */
export function evaluatePortalTransition(input: {
  sourceMap: ServerMapArtifact;
  portalId: string;
  now: number;
  lastTransitionAtMs: number | undefined;
  playerFoot: { x: number; y: number };
}): PortalTransitionEvaluation {
  const portal = input.sourceMap.portals.find(
    (candidate) => candidate.id === input.portalId,
  );
  if (!portal) {
    return { ok: false, code: ERROR_CODES.portalNotFound };
  }
  if (
    input.lastTransitionAtMs !== undefined &&
    input.now < input.lastTransitionAtMs + PORTAL_TRANSITION_COOLDOWN_MS
  ) {
    return { ok: false, code: ERROR_CODES.portalOnCooldown };
  }
  const expanded = {
    x: portal.x - PORTAL_PROXIMITY_RADIUS,
    y: portal.y - PORTAL_PROXIMITY_RADIUS,
    width: portal.width + PORTAL_PROXIMITY_RADIUS * 2,
    height: portal.height + PORTAL_PROXIMITY_RADIUS * 2,
  };
  const inRange =
    input.playerFoot.x >= expanded.x &&
    input.playerFoot.x <= expanded.x + expanded.width &&
    input.playerFoot.y >= expanded.y &&
    input.playerFoot.y <= expanded.y + expanded.height;
  if (!inRange) {
    return { ok: false, code: ERROR_CODES.portalOutOfRange };
  }
  if (portal.locked) {
    return { ok: false, code: ERROR_CODES.mapLocked };
  }
  const destinationMap = LOGICAL_MAPS[portal.destinationMapId];
  if (!destinationMap) {
    return { ok: false, code: ERROR_CODES.destinationNotAllowed };
  }
  const destinationRoom = destinationRoomName(portal.destinationMapId);
  if (!destinationRoom) {
    return { ok: false, code: ERROR_CODES.destinationNotAllowed };
  }
  const destinationEntranceExists = destinationMap.spawns.some(
    (spawn) => spawn.entranceId === portal.destinationEntranceId,
  );
  if (!destinationEntranceExists) {
    return { ok: false, code: ERROR_CODES.entranceNotFound };
  }
  if (destinationMap.contentVersion !== input.sourceMap.contentVersion) {
    return { ok: false, code: ERROR_CODES.staleContentVersion };
  }
  return {
    ok: true,
    destinationMapId: portal.destinationMapId,
    destinationEntranceId: portal.destinationEntranceId,
    destinationRoomName: destinationRoom,
  };
}
