import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectDatabase,
  DurableStateRepository,
  GuestAccountRepository,
  migrateDatabase,
  sql,
} from "@gameish/database";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://gameish:gameish@localhost:5432/gameish";
const database = connectDatabase(databaseUrl);
const accountRepository = new GuestAccountRepository(database.db);
const durableState = new DurableStateRepository(database.db);
const userId = `user:equipment-${randomUUID()}`;
const characterId = `character:equipment-${randomUUID()}`;
const now = new Date("2026-07-19T14:00:00.000Z");

beforeAll(async () => {
  await migrateDatabase(
    database.db,
    join(process.cwd(), "packages/database/migrations"),
  );
  await accountRepository.createGuestSession({
    id: `session:${userId}`,
    userId,
    secretHash: `secret:${userId}`,
    now,
    expiresAt: new Date("2026-08-19T14:00:00.000Z"),
    rotatedAt: now,
  });
  await accountRepository.createCharacter({
    id: characterId,
    userId,
    name: "Equipment Ranger",
    normalizedName: "equipment ranger",
    creationRequestId: `create:${characterId}`,
    now,
    contentVersion: "content:village_m1_v2",
    classId: "class:trailwarden",
    basicAttackId: "attack:trailward_strike",
    abilityIds: [
      "ability:thorn_arc",
      "ability:binding_briar",
      "ability:warding_breath",
      "ability:disrupting_roar",
    ],
    starterEquipmentItemId: "item:trailwarden_tunic",
    rigId: "rig:village_placeholder",
    baseLayerId: "base",
    armorLayerId: "tunic",
    logicalMapId: "map:village",
    entranceId: "village_square",
  });
});

describe("durable equipment mutations", () => {
  it("requires ownership and persists a compatible replacement atomically", async () => {
    const initial = await durableState.loadEquipment(characterId);
    expect(initial).toMatchObject({
      characterRevision: 0,
      appearance: { armorLayerId: "tunic" },
      equipment: [{ slot: "body", itemId: "item:trailwarden_tunic" }],
    });

    await expect(
      durableState.equipItem({
        characterId,
        item: {
          itemId: "item:unowned_armor",
          slot: "body",
          rigId: "rig:village_placeholder",
          layerId: "tunic",
          requirements: { minimumLevel: 1, classId: "class:trailwarden" },
        },
        expectedCharacterRevision: initial.characterRevision,
        now,
      }),
    ).resolves.toMatchObject({ applied: false, reason: "item_not_owned" });

    await durableState.grantReward(
      {
        grantId: `grant:${characterId}:replacement`,
        characterId,
        sourceId: "monster:test",
        defeatSequence: 1,
        itemId: "item:canopy_vest",
        quantity: 1,
      },
      now,
    );
    const afterReward = await durableState.loadEquipment(characterId);
    const replaced = await durableState.equipItem({
      characterId,
      item: {
        itemId: "item:canopy_vest",
        slot: "body",
        rigId: "rig:village_placeholder",
        layerId: "tunic",
        requirements: { minimumLevel: 1, classId: "class:trailwarden" },
      },
      expectedCharacterRevision: afterReward.characterRevision,
      now,
    });
    expect(replaced).toMatchObject({
      applied: true,
      snapshot: {
        characterRevision: afterReward.characterRevision + 1,
        appearance: { armorLayerId: "tunic" },
        equipment: [{ slot: "body", itemId: "item:canopy_vest" }],
      },
    });
  });

  it("allows only one concurrent mutation for a character revision", async () => {
    const current = await durableState.loadEquipment(characterId);
    const results = await Promise.all([
      durableState.unequipItem({
        characterId,
        slot: "body",
        expectedCharacterRevision: current.characterRevision,
        now,
      }),
      durableState.unequipItem({
        characterId,
        slot: "body",
        expectedCharacterRevision: current.characterRevision,
        now,
      }),
    ]);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.applied && result.reason === "stale_revision",
      ),
    ).toHaveLength(1);

    const afterReload = await durableState.loadEquipment(characterId);
    expect(afterReload.appearance.armorLayerId).toBe("");
    expect(afterReload.equipment).toEqual([]);
  });

  it("rejects incompatible equipment without changing the durable appearance", async () => {
    await durableState.grantReward(
      {
        grantId: `grant:${characterId}:wrong-rig`,
        characterId,
        sourceId: "monster:test",
        defeatSequence: 2,
        itemId: "item:wrong_rig",
        quantity: 1,
      },
      now,
    );
    const before = await durableState.loadEquipment(characterId);
    const result = await durableState.equipItem({
      characterId,
      item: {
        itemId: "item:wrong_rig",
        slot: "body",
        rigId: "rig:other",
        layerId: "tunic",
        requirements: { minimumLevel: 1, classId: "class:trailwarden" },
      },
      expectedCharacterRevision: before.characterRevision,
      now,
    });
    expect(result).toMatchObject({
      applied: false,
      reason: "incompatible_item",
    });
    expect(await durableState.loadEquipment(characterId)).toMatchObject({
      characterRevision: before.characterRevision,
      appearance: before.appearance,
      equipment: before.equipment,
    });
  });

  it("rejects an owned item when its level or class requirements are not met", async () => {
    await durableState.grantReward(
      {
        grantId: `grant:${characterId}:requirements`,
        characterId,
        sourceId: "monster:test",
        defeatSequence: 3,
        itemId: "item:level_locked_armor",
        quantity: 1,
      },
      now,
    );
    const before = await durableState.loadEquipment(characterId);
    await expect(
      durableState.equipItem({
        characterId,
        item: {
          itemId: "item:level_locked_armor",
          slot: "body",
          rigId: "rig:village_placeholder",
          layerId: "tunic",
          requirements: { minimumLevel: 99 },
        },
        expectedCharacterRevision: before.characterRevision,
        now,
      }),
    ).resolves.toMatchObject({
      applied: false,
      reason: "requirements_not_met",
      snapshot: { characterRevision: before.characterRevision },
    });
    await expect(
      durableState.loadEquipment(characterId),
    ).resolves.toMatchObject({
      characterRevision: before.characterRevision,
      appearance: before.appearance,
      equipment: before.equipment,
    });
  });

  it("rolls back equipment and appearance when the appearance write fails", async () => {
    const before = await durableState.loadEquipment(characterId);
    await database.db.execute(
      sql.raw(
        "CREATE FUNCTION gameish_test_fail_equipment_appearance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced equipment failure'; END; $$",
      ),
    );
    await database.db.execute(
      sql.raw(
        "CREATE TRIGGER gameish_test_fail_equipment_appearance BEFORE UPDATE ON character_appearance FOR EACH ROW EXECUTE FUNCTION gameish_test_fail_equipment_appearance()",
      ),
    );
    try {
      await expect(
        durableState.equipItem({
          characterId,
          item: {
            itemId: "item:trailwarden_tunic",
            slot: "body",
            rigId: "rig:village_placeholder",
            layerId: "tunic",
            requirements: {
              minimumLevel: 1,
              classId: "class:trailwarden",
            },
          },
          expectedCharacterRevision: before.characterRevision,
          now,
        }),
      ).rejects.toThrow();
    } finally {
      await database.db.execute(
        sql.raw(
          "DROP TRIGGER gameish_test_fail_equipment_appearance ON character_appearance",
        ),
      );
      await database.db.execute(
        sql.raw("DROP FUNCTION gameish_test_fail_equipment_appearance()"),
      );
    }
    await expect(durableState.loadEquipment(characterId)).resolves.toEqual(
      before,
    );
  });
});

afterAll(async () => {
  await database.close();
});
