import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectDatabase,
  DurableStateRepository,
  GuestAccountRepository,
  migrateDatabase,
  sql,
  type DurableEquipmentItem,
} from "@gameish/database";

import { PostgresEquipmentPersistence } from "../apps/server/src/equipment/persistence.js";
import {
  runEquipmentPersistenceContract,
  type EquipmentPersistenceContractHarness,
} from "../apps/server/src/equipment/persistence-contract.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://gameish:gameish@localhost:5432/gameish";
const database = connectDatabase(databaseUrl);
const accountRepository = new GuestAccountRepository(database.db);
const durableState = new DurableStateRepository(database.db);
const equipmentPersistence = new PostgresEquipmentPersistence(durableState);
const userId = `user:equipment-${randomUUID()}`;
const characterId = `character:equipment-${randomUUID()}`;
const now = new Date("2026-07-19T14:00:00.000Z");

async function createTestCharacter(id: string): Promise<void> {
  await accountRepository.createCharacter({
    id,
    userId,
    name: `Equipment ${randomUUID().slice(0, 8)}`,
    normalizedName: `equipment ${randomUUID()}`,
    creationRequestId: `create:${id}`,
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
}

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
  await createTestCharacter(characterId);
});

describe("durable equipment mutations", () => {
  // Business rules (ownership, rig compatibility, level/class requirements,
  // already-equipped/not-equipped, revision bookkeeping) are covered once
  // for every EquipmentPersistence adapter by the shared contract below.
  // What remains here is SQL-specific: row locking under concurrency and
  // transactional rollback when a later write fails.

  it("allows only one concurrent mutation for a character revision", async () => {
    const current = await equipmentPersistence.load(characterId);
    const results = await Promise.all([
      equipmentPersistence.unequipItem({
        characterId,
        slot: "body",
        expectedCharacterRevision: current.characterRevision,
        now,
      }),
      equipmentPersistence.unequipItem({
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

    const afterReload = await equipmentPersistence.load(characterId);
    expect(afterReload.appearance.armorLayerId).toBe("");
    expect(afterReload.equipment).toEqual([]);
  });

  it("rolls back equipment and appearance when the appearance write fails", async () => {
    await durableState.grantReward(
      {
        grantId: `grant:${characterId}:rollback`,
        characterId,
        sourceId: "monster:test",
        defeatSequence: 1,
        itemId: "item:trailwarden_tunic",
        quantity: 1,
      },
      now,
    );
    const before = await equipmentPersistence.load(characterId);
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
        equipmentPersistence.equipItem({
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
    await expect(equipmentPersistence.load(characterId)).resolves.toEqual(
      before,
    );
  });
});

runEquipmentPersistenceContract("postgres", async ({ level }) => {
  const contractCharacterId = `character:equipment-persistence-contract-${randomUUID()}`;
  await createTestCharacter(contractCharacterId);

  const replacementItemId = "item:equipment_persistence_contract_replacement";
  const wrongRigItemId = "item:equipment_persistence_contract_wrong_rig";
  const levelLockedItemId = "item:equipment_persistence_contract_level_locked";

  await durableState.grantReward(
    {
      grantId: `grant:${contractCharacterId}:replacement`,
      characterId: contractCharacterId,
      sourceId: "monster:test",
      defeatSequence: 1,
      itemId: replacementItemId,
      quantity: 1,
    },
    now,
  );
  await durableState.grantReward(
    {
      grantId: `grant:${contractCharacterId}:wrong-rig`,
      characterId: contractCharacterId,
      sourceId: "monster:test",
      defeatSequence: 2,
      itemId: wrongRigItemId,
      quantity: 1,
    },
    now,
  );
  await durableState.grantReward(
    {
      grantId: `grant:${contractCharacterId}:level-locked`,
      characterId: contractCharacterId,
      sourceId: "monster:test",
      defeatSequence: 3,
      itemId: levelLockedItemId,
      quantity: 1,
    },
    now,
  );
  // Reward grants recompute level from experience, so the level override
  // (a test-only shortcut standing in for real leveling) must come last.
  await database.db.execute(
    sql`update character_progression set level = ${level} where character_id = ${contractCharacterId}`,
  );

  const equippedItem: DurableEquipmentItem = {
    itemId: "item:trailwarden_tunic",
    slot: "body",
    rigId: "rig:village_placeholder",
    layerId: "tunic",
    requirements: { minimumLevel: 1, classId: "class:trailwarden" },
  };
  const replacementItem: DurableEquipmentItem = {
    itemId: replacementItemId,
    slot: "body",
    rigId: "rig:village_placeholder",
    layerId: "vest",
    requirements: {},
  };
  const unownedItem: DurableEquipmentItem = {
    itemId: "item:equipment_persistence_contract_unowned",
    slot: "body",
    rigId: "rig:village_placeholder",
    layerId: "vest",
    requirements: {},
  };
  const wrongRigItem: DurableEquipmentItem = {
    itemId: wrongRigItemId,
    slot: "body",
    rigId: "rig:equipment_persistence_contract_other",
    layerId: "vest",
    requirements: {},
  };
  const levelLockedItem: DurableEquipmentItem = {
    itemId: levelLockedItemId,
    slot: "body",
    rigId: "rig:village_placeholder",
    layerId: "vest",
    requirements: { minimumLevel: 2 },
  };

  const harness: EquipmentPersistenceContractHarness = {
    persistence: new PostgresEquipmentPersistence(durableState),
    characterId: contractCharacterId,
    equippedItem,
    replacementItem,
    unownedItem,
    wrongRigItem,
    levelLockedItem,
  };
  return harness;
});

afterAll(async () => {
  await database.close();
});
