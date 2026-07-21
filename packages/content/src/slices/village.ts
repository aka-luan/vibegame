import villageCharacter from "@gameish/content/village-character";
import villageMapServer from "@gameish/content/village-map-server";

import type { CharacterManifest } from "../character-manifest.js";
import type { CombatClassDefinition } from "../combat.js";
import type { ServerMapArtifact } from "../maps.js";
import type { QuestDefinition, QuestReward } from "../quests.js";

/**
 * The identity of the village vertical slice: the single place that names the
 * slice's map, entrance, quest, starter loadout, and content version. Values
 * that a compiled artifact already carries are read from the artifact; the
 * rest are named here and checked against their catalog by `village.test.ts`.
 */
export interface VillageSliceDefinition {
  readonly contentVersion: ServerMapArtifact["contentVersion"];
  readonly mapId: ServerMapArtifact["id"];
  readonly entranceId: ServerMapArtifact["spawns"][number]["entranceId"];
  readonly questId: QuestDefinition["id"];
  /** Runtime entity id of the slice's single starter monster instance. */
  readonly monsterEntityId: string;
  readonly rigId: CharacterManifest["id"];
  readonly classId: CombatClassDefinition["id"];
  readonly starterItemId: QuestReward["itemId"];
}

export const villageSlice: VillageSliceDefinition = Object.freeze({
  contentVersion: villageMapServer.contentVersion,
  mapId: villageMapServer.id,
  entranceId: "village_square",
  questId: "quest:forest_mossbacks",
  monsterEntityId: "monster:village_mossback:1",
  rigId: villageCharacter.id,
  classId: "class:trailwarden",
  starterItemId: "item:trailwarden_tunic",
});
