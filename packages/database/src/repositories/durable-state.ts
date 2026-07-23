import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";

import type { GameDatabase } from "../index.js";
import type * as schema from "../schema.js";
import {
  characterAppearance,
  characterDiscoveries,
  characterEquipment,
  characterLoadouts,
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
  completionId?: string;
}

export interface DurableQuestObjective {
  /**
   * Opaque caller-defined objective discriminator (e.g. "kill"). The
   * database never interprets this value; it is passed through untouched
   * to the caller-supplied `QuestTransitionDecider`.
   */
  kind: string;
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
  | {
      kind: "objective";
      event: {
        eventId: string;
        kind: string;
        targetId: string;
        count?: number;
      };
    }
  | { kind: "objective"; eventId: string; targetId: string }
  | { kind: "complete"; completionId: string };

export type DurableQuestTransitionResult =
  | { applied: true; snapshot: DurableQuestSnapshot }
  | {
      applied: false;
      reason:
        | "already_applied"
        | "illegal_transition"
        | "objective_mismatch"
        | "invalid_event"
        | "prerequisites_unmet"
        | "invalid_completion_id";
      snapshot: DurableQuestSnapshot;
    };

export type QuestTransitionDecider = (
  snapshot: DurableQuestSnapshot,
  context: {
    objective: DurableQuestObjective;
    prerequisiteQuestIds?: readonly string[];
    completedPrerequisiteQuestIds?: ReadonlySet<string>;
    completionId?: string;
  },
  transition: DurableQuestTransition,
) => DurableQuestTransitionResult;

export interface DurableRewardGrant {
  grantId: string;
  characterId: string;
  sourceId: string;
  defeatSequence: number;
  itemId: string;
  quantity: number;
}

export type DurableEquipmentSlot = "body";

export interface DurableEquipmentRequirements {
  minimumLevel?: number | undefined;
  classId?: string | undefined;
}

export interface DurableEquipmentItem {
  itemId: string;
  slot: DurableEquipmentSlot;
  rigId: string;
  layerId: string;
  requirements: DurableEquipmentRequirements;
}

export interface DurableEquipmentSnapshot {
  characterRevision: number;
  appearanceRevision: number;
  appearance: {
    rigId: string;
    baseLayerId: string;
    armorLayerId: string;
  };
  inventory: { itemId: string; quantity: number }[];
  equipment: { slot: DurableEquipmentSlot; itemId: string }[];
}

export type DurableEquipmentMutationResult =
  | { applied: true; snapshot: DurableEquipmentSnapshot }
  | {
      applied: false;
      reason:
        | "stale_revision"
        | "item_not_owned"
        | "incompatible_item"
        | "requirements_not_met"
        | "already_equipped"
        | "not_equipped";
      snapshot: DurableEquipmentSnapshot;
    };

/**
 * The character facts an {@link EquipmentDecider} needs to judge item
 * requirements. Read from storage by the persistence adapter and handed to
 * the decider as opaque data — the decider interprets it, the adapter never
 * does.
 */
export interface EquipmentRulesContext {
  classId: string;
  level: number;
}

export interface EquipItemRequest {
  item: DurableEquipmentItem;
  expectedCharacterRevision: number;
}

export interface UnequipItemRequest {
  slot: DurableEquipmentSlot;
  expectedCharacterRevision: number;
}

/**
 * The single equip/unequip rules module. Every persistence adapter
 * (Postgres, in-memory) applies its decision instead of re-deriving the
 * invariant.
 */
export interface EquipmentDecider {
  decideEquip: (
    snapshot: DurableEquipmentSnapshot,
    context: EquipmentRulesContext,
    request: EquipItemRequest,
  ) => DurableEquipmentMutationResult;
  decideUnequip: (
    snapshot: DurableEquipmentSnapshot,
    context: EquipmentRulesContext,
    request: UnequipItemRequest,
  ) => DurableEquipmentMutationResult;
}

export interface DurableCharacterState {
  characterRevision: number;
  appearanceRevision: number;
  progression: {
    level: number;
    experience: number;
    currency: number;
    revision: number;
  };
  inventory: { itemId: string; quantity: number }[];
  appearance: DurableEquipmentSnapshot["appearance"];
  equipment: DurableEquipmentSnapshot["equipment"];
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
    const [appearance] = await this.db
      .select({
        rigId: characterAppearance.rigId,
        baseLayerId: characterAppearance.baseLayerId,
        armorLayerId: characterAppearance.armorLayerId,
        appearanceRevision: characterAppearance.appearanceRevision,
      })
      .from(characterAppearance)
      .where(eq(characterAppearance.characterId, characterId))
      .limit(1);
    if (!character || !progression || !location || !appearance) {
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
    const equipment = await this.db
      .select({
        slot: characterEquipment.slot,
        itemId: characterEquipment.itemId,
      })
      .from(characterEquipment)
      .where(eq(characterEquipment.characterId, characterId));

    return {
      characterRevision: character.revision,
      appearanceRevision: appearance.appearanceRevision,
      progression,
      inventory,
      appearance: appearanceValues(appearance),
      equipment: equipment.map((item) => ({
        slot: parseEquipmentSlot(item.slot),
        itemId: item.itemId,
      })),
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

  async loadEquipment(characterId: string): Promise<DurableEquipmentSnapshot> {
    const state = await this.loadCharacterState(characterId);
    return {
      characterRevision: state.characterRevision,
      appearanceRevision: state.appearanceRevision,
      appearance: state.appearance,
      inventory: state.inventory,
      equipment: state.equipment,
    };
  }

  async equipItem(input: {
    characterId: string;
    item: DurableEquipmentItem;
    expectedCharacterRevision: number;
    decide: EquipmentDecider;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    return this.db.transaction(async (tx) => {
      const current = await this.#lockedEquipmentSnapshot(
        tx,
        input.characterId,
      );
      const context = await this.#equipmentRulesContext(tx, input.characterId);
      const result = input.decide.decideEquip(current, context, {
        item: input.item,
        expectedCharacterRevision: input.expectedCharacterRevision,
      });
      if (!result.applied) return result;

      await tx
        .insert(characterEquipment)
        .values({
          characterId: input.characterId,
          slot: input.item.slot,
          itemId: input.item.itemId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [characterEquipment.characterId, characterEquipment.slot],
          set: { itemId: input.item.itemId, updatedAt: input.now },
        });
      await tx
        .update(characterAppearance)
        .set({
          armorLayerId: input.item.layerId,
          appearanceRevision: sql`${characterAppearance.appearanceRevision} + 1`,
          updatedAt: input.now,
        })
        .where(eq(characterAppearance.characterId, input.characterId));
      await this.#bumpCharacterRevision(
        tx,
        input.characterId,
        input.now,
        input.expectedCharacterRevision,
      );
      return {
        applied: true,
        snapshot: await this.#lockedEquipmentSnapshot(tx, input.characterId),
      };
    });
  }

  async unequipItem(input: {
    characterId: string;
    slot: DurableEquipmentSlot;
    expectedCharacterRevision: number;
    decide: EquipmentDecider;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    return this.db.transaction(async (tx) => {
      const current = await this.#lockedEquipmentSnapshot(
        tx,
        input.characterId,
      );
      const context = await this.#equipmentRulesContext(tx, input.characterId);
      const result = input.decide.decideUnequip(current, context, {
        slot: input.slot,
        expectedCharacterRevision: input.expectedCharacterRevision,
      });
      if (!result.applied) return result;

      await tx
        .delete(characterEquipment)
        .where(
          and(
            eq(characterEquipment.characterId, input.characterId),
            eq(characterEquipment.slot, input.slot),
          ),
        );
      await tx
        .update(characterAppearance)
        .set({
          armorLayerId: "",
          appearanceRevision: sql`${characterAppearance.appearanceRevision} + 1`,
          updatedAt: input.now,
        })
        .where(eq(characterAppearance.characterId, input.characterId));
      await this.#bumpCharacterRevision(
        tx,
        input.characterId,
        input.now,
        input.expectedCharacterRevision,
      );
      return {
        applied: true,
        snapshot: await this.#lockedEquipmentSnapshot(tx, input.characterId),
      };
    });
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
    prerequisiteQuestIds?: readonly string[];
    completedPrerequisiteQuestIds?: ReadonlySet<string>;
    reward?: DurableQuestReward;
    decide: QuestTransitionDecider;
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

      if (input.transition.kind === "complete") {
        const [existingAction] = await tx
          .select({ actionId: durableActionRecords.actionId })
          .from(durableActionRecords)
          .where(
            and(
              eq(durableActionRecords.actionId, input.transition.completionId),
              eq(durableActionRecords.characterId, input.characterId),
            ),
          )
          .limit(1);
        if (existingAction) return rejected(current, "already_applied");
      }

      const result = input.decide(
        current,
        {
          objective: input.objective,
          ...(input.prerequisiteQuestIds === undefined
            ? {}
            : { prerequisiteQuestIds: input.prerequisiteQuestIds }),
          ...(input.completedPrerequisiteQuestIds === undefined
            ? {}
            : {
                completedPrerequisiteQuestIds:
                  input.completedPrerequisiteQuestIds,
              }),
          ...(input.transition.kind === "complete"
            ? {
                completionId: `quest-completion:${input.characterId}:${input.questId}`,
              }
            : {}),
        },
        input.transition,
      );
      if (!result.applied) return result;

      if (input.transition.kind === "accept") {
        await this.#updateQuest(tx, input, result.snapshot);
        await this.#bumpCharacterRevision(tx, input.characterId, input.now);
        return result;
      }

      if (input.transition.kind === "complete") {
        const action = await tx
          .insert(durableActionRecords)
          .values({
            actionId: input.transition.completionId,
            characterId: input.characterId,
            kind: "quest_completion",
            createdAt: input.now,
          })
          .onConflictDoNothing()
          .returning({ actionId: durableActionRecords.actionId });
        if (action.length === 0) return rejected(current, "already_applied");
        await this.#updateQuest(tx, input, result.snapshot);
        if (input.reward) {
          await this.#applyReward(
            tx,
            input.characterId,
            input.reward,
            input.now,
          );
        }
        await this.#bumpCharacterRevision(tx, input.characterId, input.now);
        return result;
      }

      const objectiveEventId =
        "event" in input.transition
          ? input.transition.event.eventId
          : input.transition.eventId;
      const event = await tx
        .insert(questObjectiveEvents)
        .values({
          characterId: input.characterId,
          questId: input.questId,
          eventId: objectiveEventId,
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ eventId: questObjectiveEvents.eventId });
      if (event.length === 0) return rejected(current, "already_applied");
      await this.#updateQuest(tx, input, result.snapshot);
      await this.#bumpCharacterRevision(tx, input.characterId, input.now);
      return result;
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

  async #lockedEquipmentSnapshot(
    tx: GameTransaction,
    characterId: string,
  ): Promise<DurableEquipmentSnapshot> {
    const [character] = await tx
      .select({ revision: characters.revision })
      .from(characters)
      .where(eq(characters.id, characterId))
      .for("update")
      .limit(1);
    const [appearance] = await tx
      .select({
        rigId: characterAppearance.rigId,
        baseLayerId: characterAppearance.baseLayerId,
        armorLayerId: characterAppearance.armorLayerId,
        appearanceRevision: characterAppearance.appearanceRevision,
      })
      .from(characterAppearance)
      .where(eq(characterAppearance.characterId, characterId))
      .limit(1);
    if (!character || !appearance) {
      throw new Error("Character equipment state is incomplete");
    }
    const inventory = await tx
      .select({
        itemId: characterInventory.itemId,
        quantity: characterInventory.quantity,
      })
      .from(characterInventory)
      .where(eq(characterInventory.characterId, characterId));
    const equipment = await tx
      .select({
        slot: characterEquipment.slot,
        itemId: characterEquipment.itemId,
      })
      .from(characterEquipment)
      .where(eq(characterEquipment.characterId, characterId));
    return {
      characterRevision: character.revision,
      appearanceRevision: appearance.appearanceRevision,
      appearance: appearanceValues(appearance),
      inventory,
      equipment: equipment.map((item) => ({
        slot: parseEquipmentSlot(item.slot),
        itemId: item.itemId,
      })),
    };
  }

  /**
   * Reads the character facts an {@link EquipmentDecider} needs to judge
   * item requirements. This is storage only — it does not interpret
   * `classId`/`level` against any item's requirements; that judgment belongs
   * entirely to the decider.
   */
  async #equipmentRulesContext(
    tx: GameTransaction,
    characterId: string,
  ): Promise<EquipmentRulesContext> {
    const [character] = await tx
      .select({ classId: characterLoadouts.classId })
      .from(characterLoadouts)
      .where(eq(characterLoadouts.characterId, characterId))
      .limit(1);
    const [progression] = await tx
      .select({ level: characterProgression.level })
      .from(characterProgression)
      .where(eq(characterProgression.characterId, characterId))
      .limit(1);
    if (!character || !progression) {
      throw new Error("Character loadout/progression state is incomplete");
    }
    return { classId: character.classId, level: progression.level };
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
    expectedRevision?: number,
  ): Promise<void> {
    const updated = await tx
      .update(characters)
      .set({
        revision: sql`${characters.revision} + 1`,
        updatedAt: now,
      })
      .where(
        expectedRevision === undefined
          ? eq(characters.id, characterId)
          : and(
              eq(characters.id, characterId),
              eq(characters.revision, expectedRevision),
            ),
      )
      .returning({ id: characters.id });
    if (updated.length === 0) throw new Error("Character revision is stale");
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

function appearanceValues(appearance: {
  rigId: string;
  baseLayerId: string;
  armorLayerId: string;
}): DurableEquipmentSnapshot["appearance"] {
  return {
    rigId: appearance.rigId,
    baseLayerId: appearance.baseLayerId,
    armorLayerId: appearance.armorLayerId,
  };
}

function parseConnectionState(
  state: string,
): DurableCharacterState["location"]["connectionState"] {
  if (state === "online" || state === "disconnected" || state === "offline") {
    return state;
  }
  throw new Error(`Invalid durable connection state: ${state}`);
}

function parseEquipmentSlot(state: string): DurableEquipmentSlot {
  if (state === "body") return state;
  throw new Error(`Invalid durable equipment slot: ${state}`);
}
