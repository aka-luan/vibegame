import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectDatabase,
  DurableStateRepository,
  GuestAccountRepository,
  migrateDatabase,
} from "@gameish/database";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://gameish:gameish@localhost:5432/gameish";
let database = connectDatabase(databaseUrl);
let accountRepository = new GuestAccountRepository(database.db);
let durableState = new DurableStateRepository(database.db);
const userId = `user:durable-progress-${randomUUID()}`;
const characterId = `character:durable-progress-${randomUUID()}`;
const now = new Date("2026-07-19T12:00:00.000Z");
const questId = "quest:forest_mossbacks";
const objective = { targetId: "monster:mossback", requiredCount: 1 };

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
    expiresAt: new Date("2026-08-19T12:00:00.000Z"),
    rotatedAt: now,
  });
  await accountRepository.createCharacter({
    id: characterId,
    userId,
    name: "Durable Progress Ranger",
    normalizedName: "durable progress ranger",
    creationRequestId: `create:${characterId}`,
    now,
    contentVersion: "content:village_m1_v1",
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

describe("durable progress persistence", () => {
  it("applies quest progress and completion atomically with replay protection", async () => {
    await expect(
      durableState.transitionQuest({
        characterId,
        questId,
        objective,
        transition: { kind: "accept" },
        now,
      }),
    ).resolves.toMatchObject({ applied: true, snapshot: { status: "active" } });

    const progressResults = await Promise.all([
      durableState.transitionQuest({
        characterId,
        questId,
        objective,
        transition: {
          kind: "objective",
          eventId: "defeat:durable:1",
          targetId: objective.targetId,
        },
        now,
      }),
      durableState.transitionQuest({
        characterId,
        questId,
        objective,
        transition: {
          kind: "objective",
          eventId: "defeat:durable:1",
          targetId: objective.targetId,
        },
        now,
      }),
    ]);
    expect(progressResults.filter((result) => result.applied)).toHaveLength(1);
    expect(
      progressResults.filter(
        (result) => !result.applied && result.reason === "already_applied",
      ),
    ).toHaveLength(1);

    const completionInput = {
      characterId,
      questId,
      objective,
      completionId: `quest-completion:${characterId}:${questId}`,
      reward: {
        itemId: "item:mossback_scale",
        quantity: 1,
        experience: 100,
        currency: 10,
      },
      transition: { kind: "complete" as const },
      now,
    };
    const completionResults = await Promise.all([
      durableState.transitionQuest(completionInput),
      durableState.transitionQuest(completionInput),
    ]);
    expect(completionResults.filter((result) => result.applied)).toHaveLength(
      1,
    );
    expect(
      completionResults.filter(
        (result) => !result.applied && result.reason === "already_applied",
      ),
    ).toHaveLength(1);

    const state = await durableState.loadCharacterState(characterId);
    expect(state.characterRevision).toBe(3);
    expect(state.appearanceRevision).toBe(0);
    expect(state.progression).toMatchObject({
      level: 2,
      experience: 100,
      currency: 10,
    });
    expect(state.inventory).toContainEqual({
      itemId: "item:mossback_scale",
      quantity: 1,
    });
    await expect(
      durableState.loadQuest(characterId, questId),
    ).resolves.toMatchObject({
      status: "completed",
      progress: 1,
      revision: 3,
    });
  });

  it("rolls back failed completion and preserves concurrent reward grants", async () => {
    const otherCharacterId = `character:durable-rollback-${randomUUID()}`;
    await accountRepository.createCharacter({
      id: otherCharacterId,
      userId,
      name: `Rollback ${randomUUID().slice(0, 8)}`,
      normalizedName: `rollback ${randomUUID()}`,
      creationRequestId: `create:${otherCharacterId}`,
      now,
      contentVersion: "content:village_m1_v1",
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
    await durableState.transitionQuest({
      characterId: otherCharacterId,
      questId,
      objective,
      transition: { kind: "accept" },
      now,
    });
    await durableState.transitionQuest({
      characterId: otherCharacterId,
      questId,
      objective,
      transition: {
        kind: "objective",
        eventId: "defeat:rollback:1",
        targetId: objective.targetId,
      },
      now,
    });
    const completion = {
      characterId: otherCharacterId,
      questId,
      objective,
      completionId: `quest-completion:${otherCharacterId}:${questId}`,
      transition: { kind: "complete" as const },
      now,
    };
    await expect(
      durableState.transitionQuest({
        ...completion,
        reward: {
          itemId: "item:invalid_reward",
          quantity: -1,
          experience: 100,
          currency: 10,
        },
      }),
    ).rejects.toThrow();
    await expect(
      durableState.transitionQuest({
        ...completion,
        reward: {
          itemId: "item:mossback_scale",
          quantity: 1,
          experience: 100,
          currency: 10,
        },
      }),
    ).resolves.toMatchObject({ applied: true });

    const grant = {
      grantId: `reward:${otherCharacterId}:defeat:1`,
      characterId: otherCharacterId,
      sourceId: "monster:mossback",
      defeatSequence: 1,
      itemId: "item:mossback_scale",
      quantity: 1,
    };
    const grants = await Promise.all([
      durableState.grantReward(grant, now),
      durableState.grantReward(grant, now),
    ]);
    expect(grants.filter(Boolean)).toHaveLength(1);
    const state = await durableState.loadCharacterState(otherCharacterId);
    expect(state.inventory).toContainEqual({
      itemId: "item:mossback_scale",
      quantity: 2,
    });
  });

  it("persists discoveries and location checkpoints across a database reconnect", async () => {
    await expect(
      durableState.recordDiscovery(characterId, "discovery:forest_gate", now),
    ).resolves.toBe(true);
    await expect(
      durableState.checkpointLocation({
        characterId,
        logicalMapId: "map:village",
        entranceId: "village_square",
        position: { x: 172, y: 320 },
        safeSpawn: { x: 128, y: 320 },
        connectionState: "disconnected",
        now,
      }),
    ).resolves.toBe(true);

    await database.close();
    database = connectDatabase(databaseUrl);
    accountRepository = new GuestAccountRepository(database.db);
    durableState = new DurableStateRepository(database.db);
    const state = await durableState.loadCharacterState(characterId);
    expect(state.discoveries).toContain("discovery:forest_gate");
    expect(state.location).toMatchObject({
      logicalMapId: "map:village",
      entranceId: "village_square",
      position: { x: 172, y: 320 },
      connectionState: "disconnected",
    });
  });

  it("rejects durable mutations when PostgreSQL is unavailable", async () => {
    const unavailable = connectDatabase(
      "postgres://gameish:gameish@127.0.0.1:1/gameish",
    );
    const unavailableState = new DurableStateRepository(unavailable.db);
    await expect(
      unavailableState.grantReward({
        grantId: "reward:database-unavailable",
        characterId,
        sourceId: "monster:mossback",
        defeatSequence: 99,
        itemId: "item:mossback_scale",
        quantity: 1,
      }),
    ).rejects.toThrow();
    await unavailable.close();
  });
});

afterAll(async () => {
  await database.close();
});
