import forestMap from "@gameish/content/forest-map";

/**
 * The identity of the forest logical map: the single place that names the
 * map and the named entrance a player arrives at when traveling in from the
 * village. Mirrors the documented style of `slices/village.ts`.
 *
 * Only the client-safe map artifact is imported here, so importing this
 * slice never drags server collision, navigation, or portal geometry onto a
 * client-reachable path (ADR-0006, ADR-0008).
 */
export const forestSlice = Object.freeze({
  contentVersion: forestMap.contentVersion,
  mapId: forestMap.id,
  entranceId: "forest_edge",
} as const);

export type ForestSliceDefinition = typeof forestSlice;
