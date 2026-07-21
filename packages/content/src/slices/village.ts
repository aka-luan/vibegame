import villageCharacter from "@gameish/content/village-character";
import villageMap from "@gameish/content/village-map";

/**
 * The identity of the village vertical slice: the single place that names the
 * slice's map, entrance, quest, starter loadout, and content version.
 *
 * `contentVersion`, `mapId` and `rigId` are read from the compiled artifacts
 * that already carry them. The remaining ids are named here because no artifact
 * carries "the slice's one quest/entrance/class/starter item" — the catalogs
 * hold lists.
 *
 * These ids are checked against their catalogs at **runtime**, by
 * `village.test.ts`. They are not checked at compile time: every id field in
 * the compiled artifacts and zod catalogs is typed `string` (the schemas use
 * `z.string().regex(...)`), so there is no literal-union or branded id type to
 * type against. Narrowing catalog ids would mean changing the artifact format,
 * which this slice deliberately does not do.
 *
 * Only the client-safe map artifact is imported here, so importing the slice
 * never drags server collision, navigation, or portal geometry onto a
 * client-reachable path (ADR-0006, ADR-0008).
 */
export const villageSlice = Object.freeze({
  contentVersion: villageMap.contentVersion,
  mapId: villageMap.id,
  entranceId: "village_square",
  questId: "quest:forest_mossbacks",
  /**
   * Runtime entity id of the slice's single starter monster instance. This is
   * an instance id, not a content id: the catalog monster it instantiates is
   * `monster:mossback`.
   */
  monsterEntityId: "monster:village_mossback:1",
  rigId: villageCharacter.id,
  classId: "class:trailwarden",
  starterItemId: "item:trailwarden_tunic",
} as const);

export type VillageSliceDefinition = typeof villageSlice;
