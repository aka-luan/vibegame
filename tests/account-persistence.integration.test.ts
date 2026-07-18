import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectDatabase,
  GuestAccountRepository,
  migrateDatabase,
  seedInitialState,
} from "@gameish/database";

const database = connectDatabase(
  process.env.TEST_DATABASE_URL ??
    "postgres://gameish:gameish@localhost:5432/gameish",
);
const repository = new GuestAccountRepository(database.db);
const integrationUserId = `user:integration-${randomUUID()}`;

beforeAll(async () => {
  await migrateDatabase(
    database.db,
    join(process.cwd(), "packages/database/migrations"),
  );
});

describe("durable guest account state", () => {
  it("applies the reviewed migrations and repeats the deterministic seed safely", async () => {
    await seedInitialState(database.db);
    await seedInitialState(database.db);

    await expect(
      repository.listCharacters("user:seed_foundation"),
    ).resolves.toHaveLength(1);
  });

  it("atomically initializes characters and consumes a ticket once", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    await repository.createGuestSession({
      id: "session:integration-account",
      userId: integrationUserId,
      secretHash: "integration:session-secret-hash",
      now,
      expiresAt: new Date("2026-08-18T12:00:00.000Z"),
      rotatedAt: now,
    });
    const input = {
      id: `character:integration-account:${integrationUserId.slice(-8)}`,
      userId: integrationUserId,
      name: "Integration Ranger",
      normalizedName: "integration ranger",
      creationRequestId: "integration:create-1",
      now,
      contentVersion: "content:village_m1_v1",
      classId: "class:trailwarden",
      basicAttackId: "attack:trailward_strike",
      abilityIds: [
        "ability:thorn_arc",
        "ability:binding_briar",
        "ability:warding_breath",
        "ability:disrupting_roar",
      ] as [string, string, string, string],
      starterEquipmentItemId: "item:trailwarden_tunic",
      rigId: "rig:village_placeholder",
      baseLayerId: "base",
      armorLayerId: "tunic",
      logicalMapId: "map:village",
      entranceId: "village_square",
    };
    const [first, replay] = await Promise.all([
      repository.createCharacter(input),
      repository.createCharacter({
        ...input,
        id: "character:integration-race",
      }),
    ]);
    expect(first.id).toBe(replay.id);

    expect(first.appearance).toEqual({
      rigId: "rig:village_placeholder",
      baseLayerId: "base",
      armorLayerId: "tunic",
    });
    expect(first.logicalMapId).toBe("map:village");

    const tokenHash = `integration:ticket-hash:${integrationUserId}`;
    await expect(
      repository.issuePlayTicket({
        tokenHash,
        userId: integrationUserId,
        characterId: first.id,
        logicalDestination: "map:village",
        contentVersion: "content:village_m1_v1",
        nonce: `integration:ticket-nonce:${integrationUserId}`,
        now,
        expiresAt: new Date("2026-07-18T12:00:15.000Z"),
      }),
    ).resolves.toBe(true);
    const concurrentConsumption = await Promise.all([
      repository.consumePlayTicket(
        tokenHash,
        new Date("2026-07-18T12:00:01.000Z"),
      ),
      repository.consumePlayTicket(
        tokenHash,
        new Date("2026-07-18T12:00:01.000Z"),
      ),
    ]);
    expect(
      concurrentConsumption.filter((result) => result.success),
    ).toHaveLength(1);
    expect(
      concurrentConsumption.filter(
        (result) => !result.success && result.reason === "replayed",
      ),
    ).toHaveLength(1);
  });
});

afterAll(async () => {
  await database.close();
});
