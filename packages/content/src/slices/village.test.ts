import { describe, expect, it } from "vitest";

import villageCharacter from "@gameish/content/village-character";
import villageCombatServer from "@gameish/content/village-combat-server";
import villageMapServer from "@gameish/content/village-map-server";
import villageQuestsServer from "@gameish/content/village-quests-server";

import canonicalContent from "../../content/foundation.json" with { type: "json" };
import { villageSlice } from "./village.js";

const definitionIds = new Set(
  canonicalContent.definitions.map((definition) => definition.id),
);

describe("village slice definition", () => {
  it("names the compiled map artifact", () => {
    expect(villageSlice.mapId).toBe(villageMapServer.id);
    expect(villageSlice.contentVersion).toBe(villageMapServer.contentVersion);
  });

  it("names an entrance the map artifact spawns players at", () => {
    const spawn = villageMapServer.spawns.find(
      (candidate) => candidate.entranceId === villageSlice.entranceId,
    );
    expect(spawn?.kind).toBe("player");
  });

  it("names a quest that resolves in the quest catalog", () => {
    expect(
      villageQuestsServer.quests.some(
        (quest) => quest.id === villageSlice.questId,
      ),
    ).toBe(true);
    expect(definitionIds.has(villageSlice.questId)).toBe(true);
  });

  it("names the rig the character manifest declares", () => {
    expect(villageSlice.rigId).toBe(villageCharacter.id);
  });

  it("names a class that resolves in the combat catalog", () => {
    expect(
      villageCombatServer.classes.some(
        (combatClass) => combatClass.id === villageSlice.classId,
      ),
    ).toBe(true);
  });

  it("names a starter item that resolves in the canonical content", () => {
    expect(definitionIds.has(villageSlice.starterItemId)).toBe(true);
  });

  it("names the starter monster instance in the monster namespace", () => {
    expect(villageSlice.monsterEntityId).toMatch(
      /^monster:[a-z][a-z0-9_]*:\d+$/,
    );
  });
});
