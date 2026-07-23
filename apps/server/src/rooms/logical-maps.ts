import forestMap from "@gameish/content/forest-map-server";
import villageMap from "@gameish/content/village-map-server";
import { forestSlice } from "@gameish/content/slices/forest";
import { villageSlice } from "@gameish/content/slices/village";
import type { ServerMapArtifact } from "@gameish/content";
import { ROOM_NAMES } from "@gameish/protocol";

/**
 * The registry of every logical map's server artifact and the logical room
 * name a player joins to reach it. Placement may create multiple ephemeral
 * map instances behind each room name; this registry intentionally exposes
 * only logical-map vocabulary to the rest of the application.
 */
export const LOGICAL_MAPS: Readonly<Record<string, ServerMapArtifact>> = {
  [villageMap.id]: villageMap,
  [forestMap.id]: forestMap,
};

const ROOM_NAME_BY_MAP_ID: Readonly<Record<string, string>> = {
  [villageMap.id]: ROOM_NAMES.village,
  [forestMap.id]: ROOM_NAMES.forest,
};

const DEFAULT_ENTRANCE_BY_MAP_ID: Readonly<Record<string, string>> = {
  [villageMap.id]: villageSlice.entranceId,
  [forestMap.id]: forestSlice.entranceId,
};

export function destinationRoomName(mapId: string): string | undefined {
  return ROOM_NAME_BY_MAP_ID[mapId];
}

export function defaultEntranceId(mapId: string): string | undefined {
  return DEFAULT_ENTRANCE_BY_MAP_ID[mapId];
}

/**
 * Current slice access policy. A destination must be a compiled logical map
 * with at least one unlocked inbound portal; unknown or wholly locked maps
 * fail closed. Character-specific unlocks can replace this policy at the
 * server boundary when such progression exists.
 */
export function isLogicalMapAccessible(mapId: string): boolean {
  if (!LOGICAL_MAPS[mapId]) return false;
  return Object.values(LOGICAL_MAPS).some((sourceMap) =>
    sourceMap.portals.some(
      (portal) => portal.destinationMapId === mapId && !portal.locked,
    ),
  );
}
