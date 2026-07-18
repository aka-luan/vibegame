import { and, eq, gt, isNull } from "drizzle-orm";

import type { GameDatabase } from "../index.js";
import {
  characterAppearance,
  characterEquipment,
  characterInventory,
  characterLoadouts,
  characterLocations,
  characterProgression,
  characters,
  contentReferences,
  playTickets,
  sessions,
  users,
} from "../schema.js";

export interface GuestSessionInput {
  id: string;
  userId: string;
  secretHash: string;
  now: Date;
  expiresAt: Date;
  rotatedAt: Date;
  selectedCharacterId?: string | null;
}

export interface GuestSessionRecord {
  id: string;
  userId: string;
  secretHash: string;
  lastSeenAt: Date;
  expiresAt: Date;
  rotatedAt: Date;
  selectedCharacterId: string | null;
}

export interface CharacterCreationInput {
  id: string;
  userId: string;
  name: string;
  normalizedName: string;
  creationRequestId: string;
  now: Date;
  contentVersion: string;
  classId: string;
  basicAttackId: string;
  abilityIds: [string, string, string, string];
  starterEquipmentItemId: string;
  rigId: string;
  baseLayerId: string;
  armorLayerId: string;
  logicalMapId: string;
  entranceId: string;
}

export interface AccountCharacter {
  id: string;
  name: string;
  revision: number;
  appearance: {
    rigId: string;
    baseLayerId: string;
    armorLayerId: string;
  };
  logicalMapId: string;
  entranceId: string;
}

export interface PlayTicketInput {
  tokenHash: string;
  userId: string;
  characterId: string;
  logicalDestination: string;
  contentVersion: string;
  nonce: string;
  now: Date;
  expiresAt: Date;
}

export interface PlayTicketAdmission {
  userId: string;
  characterId: string;
  partyId?: string | undefined;
  displayName: string;
  logicalDestination: string;
  contentVersion: string;
  nonce: string;
  appearance: {
    rigId: string;
    baseLayerId: string;
    armorLayerId: string;
  };
}

export type PlayTicketFailure = "invalid" | "expired" | "replayed";

export class CharacterNameTakenError extends Error {
  constructor() {
    super("Character name is already in use");
    this.name = "CharacterNameTakenError";
  }
}

export class GuestAccountRepository {
  constructor(readonly db: GameDatabase) {}

  async createGuestSession(input: GuestSessionInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: input.userId,
        kind: "guest",
        createdAt: input.now,
        updatedAt: input.now,
      });
      await tx.insert(sessions).values({
        id: input.id,
        userId: input.userId,
        secretHash: input.secretHash,
        createdAt: input.now,
        updatedAt: input.now,
        lastSeenAt: input.now,
        expiresAt: input.expiresAt,
        rotatedAt: input.rotatedAt,
      });
    });
  }

  async findSession(
    secretHash: string,
    now: Date,
  ): Promise<GuestSessionRecord | undefined> {
    const [session] = await this.db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        secretHash: sessions.secretHash,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        rotatedAt: sessions.rotatedAt,
        selectedCharacterId: sessions.selectedCharacterId,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.secretHash, secretHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .limit(1);
    return session;
  }

  async touchSession(id: string, now: Date): Promise<void> {
    await this.db
      .update(sessions)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
  }

  async revokeSession(id: string, now: Date): Promise<boolean> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return revoked.length > 0;
  }

  async selectCharacter(
    sessionId: string,
    userId: string,
    characterId: string,
    now: Date,
  ): Promise<boolean> {
    const owned = await this.db
      .select({ id: characters.id })
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.userId, userId)))
      .limit(1);
    if (owned.length === 0) return false;
    const selected = await this.db
      .update(sessions)
      .set({ selectedCharacterId: characterId, updatedAt: now })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    return selected.length > 0;
  }

  async rotateSession(input: {
    oldId: string;
    oldSecretHash: string;
    replacement: GuestSessionInput;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(sessions)
        .set({
          revokedAt: input.replacement.now,
          updatedAt: input.replacement.now,
        })
        .where(
          and(
            eq(sessions.id, input.oldId),
            eq(sessions.secretHash, input.oldSecretHash),
            isNull(sessions.revokedAt),
          ),
        )
        .returning({ id: sessions.id });
      if (revoked.length === 0) return false;

      await tx.insert(sessions).values({
        id: input.replacement.id,
        userId: input.replacement.userId,
        secretHash: input.replacement.secretHash,
        createdAt: input.replacement.now,
        updatedAt: input.replacement.now,
        lastSeenAt: input.replacement.now,
        expiresAt: input.replacement.expiresAt,
        rotatedAt: input.replacement.rotatedAt,
        selectedCharacterId: input.replacement.selectedCharacterId ?? null,
      });
      return true;
    });
  }

  async listCharacters(userId: string): Promise<AccountCharacter[]> {
    const rows = await this.db
      .select({
        id: characters.id,
        name: characters.name,
        revision: characters.revision,
        rigId: characterAppearance.rigId,
        baseLayerId: characterAppearance.baseLayerId,
        armorLayerId: characterAppearance.armorLayerId,
        logicalMapId: characterLocations.logicalMapId,
        entranceId: characterLocations.entranceId,
      })
      .from(characters)
      .innerJoin(
        characterAppearance,
        eq(characterAppearance.characterId, characters.id),
      )
      .innerJoin(
        characterLocations,
        eq(characterLocations.characterId, characters.id),
      )
      .where(eq(characters.userId, userId));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      revision: row.revision,
      appearance: {
        rigId: row.rigId,
        baseLayerId: row.baseLayerId,
        armorLayerId: row.armorLayerId,
      },
      logicalMapId: row.logicalMapId,
      entranceId: row.entranceId,
    }));
  }

  async createCharacter(
    input: CharacterCreationInput,
  ): Promise<AccountCharacter> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: characters.id })
        .from(characters)
        .where(
          and(
            eq(characters.userId, input.userId),
            eq(characters.creationRequestId, input.creationRequestId),
          ),
        )
        .limit(1);
      let characterId = existing[0]?.id;

      if (!characterId) {
        const inserted = await tx
          .insert(characters)
          .values({
            id: input.id,
            userId: input.userId,
            name: input.name,
            normalizedName: input.normalizedName,
            creationRequestId: input.creationRequestId,
            revision: 0,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing()
          .returning({ id: characters.id });
        const insertedCharacter = inserted[0]?.id;
        characterId = insertedCharacter;
        if (!characterId) {
          const requestConflict = await tx
            .select({ id: characters.id })
            .from(characters)
            .where(
              and(
                eq(characters.userId, input.userId),
                eq(characters.creationRequestId, input.creationRequestId),
              ),
            )
            .limit(1);
          characterId = requestConflict[0]?.id;
          if (!characterId) {
            const nameConflict = await tx
              .select({ id: characters.id })
              .from(characters)
              .where(
                and(
                  eq(characters.userId, input.userId),
                  eq(characters.normalizedName, input.normalizedName),
                ),
              )
              .limit(1);
            if (nameConflict.length > 0) throw new CharacterNameTakenError();
            throw new Error("Character creation conflict");
          }
        }

        if (insertedCharacter) {
          await tx.insert(characterAppearance).values({
            characterId,
            rigId: input.rigId,
            baseLayerId: input.baseLayerId,
            armorLayerId: input.armorLayerId,
            createdAt: input.now,
            updatedAt: input.now,
          });
          await tx.insert(characterProgression).values({
            characterId,
            level: 1,
            experience: 0,
            currency: 0,
            revision: 0,
            createdAt: input.now,
            updatedAt: input.now,
          });
          await tx.insert(characterLoadouts).values({
            characterId,
            contentVersion: input.contentVersion,
            classId: input.classId,
            basicAttackId: input.basicAttackId,
            ability1Id: input.abilityIds[0],
            ability2Id: input.abilityIds[1],
            ability3Id: input.abilityIds[2],
            ability4Id: input.abilityIds[3],
            createdAt: input.now,
            updatedAt: input.now,
          });
          await tx.insert(characterLocations).values({
            characterId,
            logicalMapId: input.logicalMapId,
            entranceId: input.entranceId,
            createdAt: input.now,
            updatedAt: input.now,
          });
          await tx.insert(characterInventory).values({
            characterId,
            itemId: input.starterEquipmentItemId,
            quantity: 1,
            createdAt: input.now,
            updatedAt: input.now,
          });
          await tx.insert(characterEquipment).values({
            characterId,
            slot: "body",
            itemId: input.starterEquipmentItemId,
            createdAt: input.now,
            updatedAt: input.now,
          });
        }
      }

      const [character] = await tx
        .select({
          id: characters.id,
          name: characters.name,
          revision: characters.revision,
          rigId: characterAppearance.rigId,
          baseLayerId: characterAppearance.baseLayerId,
          armorLayerId: characterAppearance.armorLayerId,
          logicalMapId: characterLocations.logicalMapId,
          entranceId: characterLocations.entranceId,
        })
        .from(characters)
        .innerJoin(
          characterAppearance,
          eq(characterAppearance.characterId, characters.id),
        )
        .innerJoin(
          characterLocations,
          eq(characterLocations.characterId, characters.id),
        )
        .where(eq(characters.id, characterId))
        .limit(1);
      if (!character) throw new Error("Created character state is incomplete");
      return {
        id: character.id,
        name: character.name,
        revision: character.revision,
        appearance: {
          rigId: character.rigId,
          baseLayerId: character.baseLayerId,
          armorLayerId: character.armorLayerId,
        },
        logicalMapId: character.logicalMapId,
        entranceId: character.entranceId,
      };
    });
  }

  async issuePlayTicket(input: PlayTicketInput): Promise<boolean> {
    const owned = await this.db
      .select({ id: characters.id })
      .from(characters)
      .where(
        and(
          eq(characters.id, input.characterId),
          eq(characters.userId, input.userId),
        ),
      )
      .limit(1);
    if (owned.length === 0) return false;
    await this.db.insert(playTickets).values({
      tokenHash: input.tokenHash,
      userId: input.userId,
      characterId: input.characterId,
      logicalDestination: input.logicalDestination,
      contentVersion: input.contentVersion,
      nonce: input.nonce,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    });
    return true;
  }

  async consumePlayTicket(
    tokenHash: string,
    now: Date,
  ): Promise<
    | { success: true; admission: PlayTicketAdmission }
    | { success: false; reason: PlayTicketFailure }
  > {
    const consumed = await this.db
      .update(playTickets)
      .set({ consumedAt: now })
      .where(
        and(
          eq(playTickets.tokenHash, tokenHash),
          isNull(playTickets.consumedAt),
          gt(playTickets.expiresAt, now),
        ),
      )
      .returning({ tokenHash: playTickets.tokenHash });
    if (consumed.length === 0) {
      const [ticket] = await this.db
        .select({
          expiresAt: playTickets.expiresAt,
          consumedAt: playTickets.consumedAt,
        })
        .from(playTickets)
        .where(eq(playTickets.tokenHash, tokenHash))
        .limit(1);
      if (!ticket) return { success: false, reason: "invalid" };
      if (ticket.consumedAt) return { success: false, reason: "replayed" };
      return { success: false, reason: "expired" };
    }

    const [admission] = await this.db
      .select({
        userId: playTickets.userId,
        characterId: playTickets.characterId,
        displayName: characters.name,
        logicalDestination: playTickets.logicalDestination,
        contentVersion: playTickets.contentVersion,
        nonce: playTickets.nonce,
        rigId: characterAppearance.rigId,
        baseLayerId: characterAppearance.baseLayerId,
        armorLayerId: characterAppearance.armorLayerId,
      })
      .from(playTickets)
      .innerJoin(characters, eq(characters.id, playTickets.characterId))
      .innerJoin(
        characterAppearance,
        eq(characterAppearance.characterId, characters.id),
      )
      .where(eq(playTickets.tokenHash, tokenHash))
      .limit(1);
    if (!admission)
      throw new Error("Consumed play ticket has incomplete state");
    return {
      success: true,
      admission: {
        userId: admission.userId,
        characterId: admission.characterId,
        displayName: admission.displayName,
        logicalDestination: admission.logicalDestination,
        contentVersion: admission.contentVersion,
        nonce: admission.nonce,
        appearance: {
          rigId: admission.rigId,
          baseLayerId: admission.baseLayerId,
          armorLayerId: admission.armorLayerId,
        },
      },
    };
  }
}

export async function seedInitialState(
  db: GameDatabase,
  now = new Date("2026-07-14T00:00:00.000Z"),
): Promise<void> {
  const userId = "user:seed_foundation";
  const characterId = "character:seed_trailwarden";
  const sessionId = "session:seed_foundation";
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ id: userId, kind: "guest", createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await tx
      .insert(sessions)
      .values({
        id: sessionId,
        userId,
        secretHash: "seed:foundation:secret-hash",
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        rotatedAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(characters)
      .values({
        id: characterId,
        userId,
        name: "Seed Trailwarden",
        normalizedName: "seed trailwarden",
        creationRequestId: "seed:foundation-character",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(characterAppearance)
      .values({
        characterId,
        rigId: "rig:village_placeholder",
        baseLayerId: "base",
        armorLayerId: "tunic",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(characterProgression)
      .values({ characterId, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await tx
      .insert(characterLoadouts)
      .values({
        characterId,
        contentVersion: "content:village_m1_v1",
        classId: "class:trailwarden",
        basicAttackId: "attack:trailward_strike",
        ability1Id: "ability:thorn_arc",
        ability2Id: "ability:binding_briar",
        ability3Id: "ability:warding_breath",
        ability4Id: "ability:disrupting_roar",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(characterLocations)
      .values({
        characterId,
        logicalMapId: "map:village",
        entranceId: "village_square",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const references = [
      ["class", "class:trailwarden"],
      ["attack", "attack:trailward_strike"],
      ["ability", "ability:thorn_arc"],
      ["ability", "ability:binding_briar"],
      ["ability", "ability:warding_breath"],
      ["ability", "ability:disrupting_roar"],
      ["item", "item:trailwarden_tunic"],
      ["map", "map:village"],
    ] as const;
    for (const [kind, contentId] of references) {
      await tx
        .insert(contentReferences)
        .values({
          id: `content-reference:seed:${kind}:${contentId}`,
          contentVersion: "content:village_m1_v1",
          kind,
          contentId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    await tx
      .insert(characterInventory)
      .values({
        characterId,
        itemId: "item:trailwarden_tunic",
        quantity: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(characterEquipment)
      .values({
        characterId,
        slot: "body",
        itemId: "item:trailwarden_tunic",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });
}
