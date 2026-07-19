import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";

import type { GameDatabase } from "../index.js";
import type * as schema from "../schema.js";
import {
  characterDiscoveries,
  characterInventory,
  characterLocations,
  characterProgression,
  characterQuests,
  characters,
  durableActionRecords,
  questObjectiveEvents,
  rewardGrants,
} from "../schema.js";

type GameTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type StateExecutor = GameDatabase | GameTransaction;

export type DurableQuestStatus = "available" | "active" | "ready" | "completed";

export interface DurableQuestSnapshot {
  questId: string;
  status: DurableQuestStatus;
  progress: number;
  appliedEventIds: readonly string[];
  revision: number;
}

export interface DurableQuestObjective {
  targetId: string;
  requiredCount: number;
}

export interface DurableQuestReward {
  itemId: string;
  quantity: number;
  experience: number;
  currency: number;
}

export type DurableQuestTransition =
  | { kind: "accept" }
  | { kind: "objective"; eventId: string; targetId: string }
  | { kind: "complete" };

export type DurableQuestTransitionResult =
  | { applied: true; snapshot: DurableQuestSnapshot }
  | {
      applied: false;
      reason: "already_applied" | "illegal_transition" | "objective_mismatch";
      snapshot: DurableQuestSnapshot;
    };

export interface DurableRewardGrant {
  grantId: string;
  characterId: string;
  sourceId: string;
  defeatSequence: number;
  itemId: string;
  quantity: number;
}

export interface DurableCharacterState {
  characterRevision: number;
  progression: {
    level: number;
    experience: number;
    currency: number;
    revision: number;
  };
  inventory: { itemId: string; quantity: number }[];
  discoveries: string[];
  location: {
    logicalMapId: string;
    entranceId: string;
    position: { x: number; y: number };
    safeSpawn: { x: number; y: number };
    connectionState: "online" | "disconnected" | "offline";
  };
}

export interface LocationCheckpointInput {
  characterId: string;
  logicalMapId: string;
  entranceId: string;
  position: { x: number; y: number };
  safeSpawn: { x: number; y: number };
  connectionState: "online" | "disconnected" | "offline";
  now: Date;
}

export class DurableStateRepository {
  constructor(readonly db: GameDatabase) {}

  async loadCharacterState(
    characterId: string,
  ): Promise<DurableCharacterState> {
    const [character] = await this.db
      .select({ revision: characters.revision })
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    const [progression] = await this.db
      .select({
        level: characterProgression.level,
        experience: characterProgression.experience,
        currency: characterProgression.currency,
        revision: characterProgression.revision,
      })
      .from(characterProgression)
      .where(eq(characterProgression.characterId, characterId))
      .limit(1);
    const [location] = await this.db
      .select({
        logicalMapId: characterLocations.logicalMapId,
        entranceId: characterLocations.entranceId,
        positionX: characterLocations.positionX,
        positionY: characterLocations.positionY,
        safeSpawnX: characterLocations.safeSpawnX,
        safeSpawnY: characterLocations.safeSpawnY,
        connectionState: characterLocations.connectionState,
      })
      .from(characterLocations)
      .where(eq(characterLocations.characterId, characterId))
      .limit(1);
    if (!character || !progression || !location) {
      throw new Error("Durable character state is incomplete");
    }
    const inventory = await this.db
      .select({
        itemId: characterInventory.itemId,
        quantity: characterInventory.quantity,
      })
      .from(characterInventory)
      .where(eq(characterInventory.characterId, characterId));
    const discoveries = await this.db
      .select({ discoveryId: characterDiscoveries.discoveryId })
      .from(characterDiscoveries)
      .where(eq(characterDiscoveries.characterId, characterId));

    return {
      characterRevision: character.revision,
      progression,
      inventory,
      discoveries: discoveries.map((discovery) => discovery.discoveryId),
      location: {
        logicalMapId: location.logicalMapId,
        entranceId: location.entranceId,
        position: { x: location.positionX, y: location.positionY },
        safeSpawn: { x: location.safeSpawnX, y: location.safeSpawnY },
        connectionState: parseConnectionState(location.connectionState),
      },
    };
  }

  async loadQuest(
    characterId: string,
    questId: string,
  ): Promise<DurableQuestSnapshot> {
    const [quest] = await this.db
      .select({
        questId: characterQuests.questId,
        status: characterQuests.status,
        progress: characterQuests.progress,
        revision: characterQuests.revision,
      })
      .from(characterQuests)
      .where(
        and(
          eq(characterQuests.characterId, characterId),
          eq(characterQuests.questId, questId),
        ),
      )
      .limit(1);
    if (!quest) return availableQuest(questId);
    return this.#snapshot(characterId, quest);
  }

  async transitionQuest(input: {
    characterId: string;
    questId: string;
    objective: DurableQuestObjective;
    transition: DurableQuestTransition;
    reward?: DurableQuestReward;
    completionId?: string;
    now: Date;
  }): Promise<DurableQuestTransitionResult> {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(characterQuests)
        .values({
          characterId: input.characterId,
          questId: input.questId,
          status: "available",
          progress: 0,
          revision: 0,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing();
      const quest = await this.#lockedQuest(
        tx,
        input.characterId,
        input.questId,
      );
      if (!quest) throw new Error("Quest state is unavailable");
      const current = await this.#snapshot(input.characterId, quest, tx);

      if (input.transition.kind === "accept") {
        if (current.status !== "available") {
          return rejected(current, "illegal_transition");
        }
        const next = applied(current, { status: "active" });
        await this.#updateQuest(tx, input, next.snapshot);
        await this.#bumpCharacterRevision(tx, input.characterId, input.now);
        return next;
      }

      if (input.transition.kind === "complete") {
        if (input.completionId) {
          const [existingAction] = await tx
            .select({ actionId: durableActionRecords.actionId })
            .from(durableActionRecords)
            .where(
              and(
                eq(durableActionRecords.actionId, input.completionId),
                eq(durableActionRecords.characterId, input.characterId),
              ),
            )
            .limit(1);
          if (existingAction) return rejected(current, "already_applied");
        }
        if (current.status !== "ready") {
          return rejected(current, "illegal_transition");
        }
        if (!input.completionId) {
          return rejected(current, "illegal_transition");
        }
        const action = await tx
          .insert(durableActionRecords)
          .values({
            actionId: input.completionId,
            characterId: input.characterId,
            kind: "quest_completion",
            createdAt: input.now,
          })
          .onConflictDoNothing()
          .returning({ actionId: durableActionRecords.actionId });
        if (action.length === 0) return rejected(current, "already_applied");
        const next = applied(current, { status: "completed" });
        await this.#updateQuest(tx, input, next.snapshot);
        if (input.reward) {
          await this.#applyReward(
            tx,
            input.characterId,
            input.reward,
            input.now,
          );
        }
        await this.#bumpCharacterRevision(tx, input.characterId, input.now);
        return next;
      }

      const [existingEvent] = await tx
        .select({ eventId: questObjectiveEvents.eventId })
        .from(questObjectiveEvents)
        .where(
          and(
            eq(questObjectiveEvents.characterId, input.characterId),
            eq(questObjectiveEvents.questId, input.questId),
            eq(questObjectiveEvents.eventId, input.transition.eventId),
          ),
        )
        .limit(1);
      if (existingEvent) return rejected(current, "already_applied");
      if (current.status !== "active") {
        return rejected(current, "illegal_transition");
      }
      if (input.transition.targetId !== input.objective.targetId) {
        return rejected(current, "objective_mismatch");
      }
      const event = await tx
        .insert(questObjectiveEvents)
        .values({
          characterId: input.characterId,
          questId: input.questId,
          eventId: input.transition.eventId,
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ eventId: questObjectiveEvents.eventId });
      if (event.length === 0) return rejected(current, "already_applied");
      const progress = Math.min(
        input.objective.requiredCount,
        current.progress + 1,
      );
      const next = applied(current, {
        progress,
        status: progress >= input.objective.requiredCount ? "ready" : "active",
        appliedEventIds: [...current.appliedEventIds, input.transition.eventId],
      });
      await this.#updateQuest(tx, input, next.snapshot);
      await this.#bumpCharacterRevision(tx, input.characterId, input.now);
      return next;
    });
  }

  async grantReward(
    reward: DurableRewardGrant,
    now = new Date(),
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(rewardGrants)
        .values({
          grantId: reward.grantId,
          characterId: reward.characterId,
          sourceId: reward.sourceId,
          defeatSequence: reward.defeatSequence,
          itemId: reward.itemId,
          quantity: reward.quantity,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ grantId: rewardGrants.grantId });
      if (inserted.length === 0) return false;
      await this.#applyReward(
        tx,
        reward.characterId,
        {
          itemId: reward.itemId,
          quantity: reward.quantity,
          experience: 0,
          currency: 0,
        },
        now,
      );
      await this.#bumpCharacterRevision(tx, reward.characterId, now);
      return true;
    });
  }

  async recordDiscovery(
    characterId: string,
    discoveryId: string,
    now = new Date(),
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(characterDiscoveries)
        .values({ characterId, discoveryId, discoveredAt: now })
        .onConflictDoNothing()
        .returning({ discoveryId: characterDiscoveries.discoveryId });
      if (inserted.length === 0) return false;
      await this.#bumpCharacterRevision(tx, characterId, now);
      return true;
    });
  }

  async checkpointLocation(input: LocationCheckpointInput): Promise<boolean> {
    if (
      !Number.isFinite(input.position.x) ||
      !Number.isFinite(input.position.y) ||
      !Number.isFinite(input.safeSpawn.x) ||
      !Number.isFinite(input.safeSpawn.y)
    ) {
      return false;
    }
    const updated = await this.db
      .update(characterLocations)
      .set({
        logicalMapId: input.logicalMapId,
        entranceId: input.entranceId,
        positionX: input.position.x,
        positionY: input.position.y,
        safeSpawnX: input.safeSpawn.x,
        safeSpawnY: input.safeSpawn.y,
        connectionState: input.connectionState,
        updatedAt: input.now,
      })
      .where(eq(characterLocations.characterId, input.characterId))
      .returning({ characterId: characterLocations.characterId });
    return updated.length > 0;
  }

  async #lockedQuest(
    tx: GameTransaction,
    characterId: string,
    questId: string,
  ) {
    const [quest] = await tx
      .select({
        questId: characterQuests.questId,
        status: characterQuests.status,
        progress: characterQuests.progress,
        revision: characterQuests.revision,
      })
      .from(characterQuests)
      .where(
        and(
          eq(characterQuests.characterId, characterId),
          eq(characterQuests.questId, questId),
        ),
      )
      .for("update")
      .limit(1);
    return quest;
  }

  async #snapshot(
    characterId: string,
    quest: {
      questId: string;
      status: string;
      progress: number;
      revision: number;
    },
    executor: StateExecutor = this.db,
  ): Promise<DurableQuestSnapshot> {
    const events = await executor
      .select({ eventId: questObjectiveEvents.eventId })
      .from(questObjectiveEvents)
      .where(
        and(
          eq(questObjectiveEvents.characterId, characterId),
          eq(questObjectiveEvents.questId, quest.questId),
        ),
      );
    return {
      questId: quest.questId,
      status: parseQuestStatus(quest.status),
      progress: quest.progress,
      appliedEventIds: events.map(
        (event: { eventId: string }) => event.eventId,
      ),
      revision: quest.revision,
    };
  }

  async #updateQuest(
    tx: GameTransaction,
    input: { characterId: string; questId: string; now: Date },
    snapshot: DurableQuestSnapshot,
  ): Promise<void> {
    await tx
      .update(characterQuests)
      .set({
        status: snapshot.status,
        progress: snapshot.progress,
        revision: snapshot.revision,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(characterQuests.characterId, input.characterId),
          eq(characterQuests.questId, input.questId),
        ),
      );
  }

  async #applyReward(
    tx: GameTransaction,
    characterId: string,
    reward: DurableQuestReward,
    now: Date,
  ): Promise<void> {
    const [progression] = await tx
      .select({
        level: characterProgression.level,
        experience: characterProgression.experience,
        currency: characterProgression.currency,
      })
      .from(characterProgression)
      .where(eq(characterProgression.characterId, characterId))
      .for("update")
      .limit(1);
    if (!progression) throw new Error("Character progression is unavailable");
    const experience = progression.experience + reward.experience;
    await tx
      .update(characterProgression)
      .set({
        level: levelForExperience(experience),
        experience,
        currency: progression.currency + reward.currency,
        revision: sql`${characterProgression.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(characterProgression.characterId, characterId));
    await tx
      .insert(characterInventory)
      .values({
        characterId,
        itemId: reward.itemId,
        quantity: reward.quantity,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [characterInventory.characterId, characterInventory.itemId],
        set: {
          quantity: sql`${characterInventory.quantity} + ${reward.quantity}`,
          updatedAt: now,
        },
      });
  }

  async #bumpCharacterRevision(
    tx: GameTransaction,
    characterId: string,
    now: Date,
  ): Promise<void> {
    await tx
      .update(characters)
      .set({
        revision: sql`${characters.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(characters.id, characterId));
  }
}

function availableQuest(questId: string): DurableQuestSnapshot {
  return {
    questId,
    status: "available",
    progress: 0,
    appliedEventIds: [],
    revision: 0,
  };
}

function applied(
  snapshot: DurableQuestSnapshot,
  changes: Partial<DurableQuestSnapshot>,
): DurableQuestTransitionResult {
  return {
    applied: true,
    snapshot: {
      ...snapshot,
      ...changes,
      revision: snapshot.revision + 1,
    },
  };
}

function rejected(
  snapshot: DurableQuestSnapshot,
  reason: Extract<DurableQuestTransitionResult, { applied: false }>["reason"],
): DurableQuestTransitionResult {
  return { applied: false, reason, snapshot };
}

function levelForExperience(experience: number): number {
  return Math.max(1, Math.floor(experience / 100) + 1);
}

function parseQuestStatus(status: string): DurableQuestStatus {
  if (
    status === "available" ||
    status === "active" ||
    status === "ready" ||
    status === "completed"
  ) {
    return status;
  }
  throw new Error(`Invalid durable quest status: ${status}`);
}

function parseConnectionState(
  state: string,
): DurableCharacterState["location"]["connectionState"] {
  if (state === "online" || state === "disconnected" || state === "offline") {
    return state;
  }
  throw new Error(`Invalid durable connection state: ${state}`);
}
