import forestMap from "@gameish/content/forest-map-server";
import villageMap from "@gameish/content/village-map-server";
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

export function destinationRoomName(mapId: string): string | undefined {
  return ROOM_NAME_BY_MAP_ID[mapId];
}
