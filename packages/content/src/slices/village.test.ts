import { describe, expect, it } from "vitest";

import villageCombatServer from "@gameish/content/village-combat-server";
import villageMap from "@gameish/content/village-map";
import villageMapServer from "@gameish/content/village-map-server";
import villageQuestsServer from "@gameish/content/village-quests-server";

import canonicalContent from "../../content/foundation.json" with { type: "json" };
import characterManifest from "../../manifests/village-character.json" with { type: "json" };
import tiledVillageMap from "../../maps/village.tiled.json" with { type: "json" };
import { villageSlice } from "./village.js";

const definitionIds = new Set(
  canonicalContent.definitions.map((definition) => definition.id),
);

const tiledSpawns = tiledVillageMap.layers.find(
  (layer) => layer.name === "spawns",
)?.objects;

describe("village slice definition", () => {
  it("names a map id both compiled artifacts agree on", () => {
    // The client and server artifacts are compiled independently from the same
    // Tiled source, so agreeing is a real cross-check rather than a tautology.
    expect(villageSlice.mapId).toBe(villageMapServer.id);
    expect(villageSlice.contentVersion).toBe(villageMapServer.contentVersion);
  });

  it("names an entrance authored as a player spawn in the Tiled source", () => {
    const authored = tiledSpawns?.find(
      (spawn) => spawn.name === villageSlice.entranceId,
    );
    expect(authored?.type).toBe("player");

    const compiled = villageMapServer.spawns.find(
      (spawn) => spawn.entranceId === villageSlice.entranceId,
    );
    expect(compiled?.kind).toBe("player");
  });

  it("names a quest that resolves in the canonical content and quest catalog", () => {
    expect(definitionIds.has(villageSlice.questId)).toBe(true);
    expect(
      villageQuestsServer.quests.some(
        (quest) => quest.id === villageSlice.questId,
      ),
    ).toBe(true);
  });

  it("names the rig id the authored character manifest declares", () => {
    expect(villageSlice.rigId).toBe(characterManifest.id);
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

  it("names a monster instance of the quest's objective target", () => {
    // `monsterEntityId` is a runtime instance id, not a content id, so it does
    // not resolve in the catalog. What must hold is that the slice's quest has
    // a kill objective whose target monster exists to be instantiated.
    const quest = villageQuestsServer.quests.find(
      (candidate) => candidate.id === villageSlice.questId,
    );
    const targetId = quest?.serverOnly.objective.targetId;
    expect(definitionIds.has(targetId ?? "")).toBe(true);
    expect(
      villageCombatServer.monsters.some((monster) => monster.id === targetId),
    ).toBe(true);
    expect(villageSlice.monsterEntityId).toMatch(
      /^monster:[a-z][a-z0-9_]*:\d+$/,
    );
  });

  it("keeps server-only map geometry off the slice's import path", () => {
    // The slice imports the client artifact; server-only geometry must not be
    // reachable through it (ADR-0006, ADR-0008).
    expect(villageMap).not.toHaveProperty("collision");
    expect(villageMap).not.toHaveProperty("navigation");
    expect(villageMap).not.toHaveProperty("portals");
  });
});
