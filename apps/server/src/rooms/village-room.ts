import { Room, ServerError, type Client } from "@colyseus/core";
import { MapSchema, Schema, type } from "@colyseus/schema";
import villageCombat from "@gameish/content/village-combat-server";
import villageEquipment from "@gameish/content/village-equipment-server";
import villageCharacter from "@gameish/content/village-character";
import villageMap from "@gameish/content/village-map-server";
import villageDialogue from "@gameish/content/village-dialogue-server";
import villageQuests from "@gameish/content/village-quests-server";
import { villageSlice } from "@gameish/content/slices/village";
import type {
  DurableCharacterState,
  DurableEquipmentSnapshot,
  LocationCheckpointInput,
} from "@gameish/database";
import type { CombatCatalog } from "@gameish/content/combat";
import type { DialogueQuestAction } from "@gameish/content/dialogue";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type CombatResult,
  type EquipmentResult,
  type EquipmentStateMessage,
  type MovementIntention,
  type PublicAppearance as PublicAppearanceState,
  type PublicMonsterState,
  type PublicPlayerState,
  type PublicVillageState,
  type QuestRewardMessage,
  type QuestStateMessage,
} from "@gameish/protocol";
import { moveCharacterFoot, PLAYER_MOVEMENT } from "@gameish/world";
import { z } from "zod";

import type { PlayTicketConsumer } from "../identity/play-tickets.js";
import {
  InMemoryEquipmentPersistence,
  UnavailableEquipmentPersistence,
  type EquipmentPersistence,
  type EquipmentSeed,
} from "../equipment/persistence.js";
import {
  applyMonsterEffectsToPlayer,
  buildCombatStateMessage,
  resolveCombatAction,
  type CombatActionOutcome,
  type CombatActionState,
  type PlayerCombatState,
} from "../combat/action.js";
import { MonsterLifecycle } from "../combat/monster-lifecycle.js";
import { expireCombatStatuses, combatControlState } from "../combat/status.js";
import {
  InMemoryRewardPersistence,
  type RewardPersistence,
} from "../rewards/persistence.js";
import {
  RewardSettlementWindow,
  settleDefeat,
  type RewardCandidate,
} from "../rewards/settlement.js";
import {
  resolveDialogueChoice,
  resolveDialogueNode,
  type DialogueCharacterState,
} from "../dialogue/resolver.js";
import {
  InMemoryQuestPersistence,
  type QuestPersistence,
  type QuestReward,
} from "../quests/persistence.js";
import type { QuestSnapshot } from "../quests/state.js";

const joinOptionsSchema = z
  .object({ ticket: z.string().min(1).max(200) })
  .strict();
const movementIntentionSchema = z
  .object({
    x: z.number().finite().min(-1).max(1),
    y: z.number().finite().min(-1).max(1),
    sequence: z.number().int().nonnegative(),
  })
  .strict()
  .refine((intention) => Math.hypot(intention.x, intention.y) <= 1, {
    message: "Movement direction exceeds normalized speed",
  });
const interactionSchema = z
  .object({
    actionId: z.string().trim().min(1).max(64),
    interactiveId: z.string().trim().min(1).max(80),
  })
  .strict();
const dialogueChoiceSchema = z
  .object({
    actionId: z.string().trim().min(1).max(64),
    npcId: z.string().trim().min(1).max(80),
    nodeId: z.string().trim().min(1).max(80),
    choiceId: z.string().trim().min(1).max(80),
  })
  .strict();
const dialogueCloseSchema = z
  .object({ actionId: z.string().trim().min(1).max(64) })
  .strict();
const equipmentEquipSchema = z
  .object({
    actionId: z.string().trim().min(1).max(64),
    itemId: z.string().trim().min(1).max(80),
    expectedCharacterRevision: z.number().int().nonnegative(),
  })
  .strict();
const equipmentUnequipSchema = z
  .object({
    actionId: z.string().trim().min(1).max(64),
    slot: z.literal("body"),
    expectedCharacterRevision: z.number().int().nonnegative(),
  })
  .strict();

const MAX_MOVEMENT_MESSAGE_BYTES = 256;
const MAX_INTENTION_VIOLATIONS = 5;
const MAX_PENDING_INTENTIONS = 120;
const INTERACTION_RADIUS = 56;
const INTERACTION_RATE_LIMIT_MS = 250;
const DIALOGUE_ACTION_RATE_LIMIT_MS = 100;
const MAX_DIALOGUE_MESSAGE_BYTES = 256;
const MAX_EQUIPMENT_MESSAGE_BYTES = 256;

const STARTING_CHARACTER_LEVEL = 1;

const developmentStarterEquipmentItem = villageEquipment.items[0];
if (!developmentStarterEquipmentItem) {
  throw new Error("Village equipment catalog is missing a starter item");
}
const developmentStarterClass = villageCombat.classes[0];
if (!developmentStarterClass) {
  throw new Error("Village combat catalog is missing a starter class");
}
const developmentEquipmentSeed: EquipmentSeed = {
  appearance: {
    rigId: developmentStarterEquipmentItem.serverOnly.rigId,
    baseLayerId: "base",
    armorLayerId: developmentStarterEquipmentItem.clientVisible.layerId,
  },
  inventory: [{ itemId: developmentStarterEquipmentItem.id, quantity: 1 }],
  equipment: [
    {
      slot: developmentStarterEquipmentItem.slot,
      itemId: developmentStarterEquipmentItem.id,
    },
  ],
  context: {
    classId: developmentStarterClass.id,
    // Matches the level a freshly created character starts at
    // (`guest-account.ts`); never derived from the item being judged, so a
    // requirement the production path would reject is rejected here too.
    level: STARTING_CHARACTER_LEVEL,
  },
};

class PublicAppearance extends Schema {
  @type("string")
  rigId = "";

  @type("string")
  baseLayerId = "";

  @type("string")
  armorLayerId = "";
}

class PublicPlayer extends Schema {
  @type("string")
  displayName = "";

  @type("number")
  x = 0;

  @type("number")
  y = 0;

  @type("string")
  facing: PublicPlayerState["facing"] = "east";

  @type("string")
  animation: PublicPlayerState["animation"] = "idle";

  @type("number")
  appearanceRevision = 0;

  @type(PublicAppearance)
  appearance = new PublicAppearance();
}

class PublicMonster extends Schema {
  @type("string")
  displayName = "";

  @type("number")
  x = 0;

  @type("number")
  y = 0;

  @type("string")
  animation: PublicMonsterState["animation"] = "idle";

  @type("number")
  healthFraction = 1;
}

class VillageState extends Schema {
  @type("number")
  serverTimeMs = 0;

  @type({ map: PublicPlayer })
  players = new MapSchema<PublicPlayer>();

  @type({ map: PublicMonster })
  monsters = new MapSchema<PublicMonster>();
}

/**
 * Compile-time proof that the room's Colyseus schema classes conform to the
 * public room-state contract in `@gameish/protocol`. If a field is removed
 * or retyped on the schema classes without a matching protocol update, this
 * fails to compile.
 */
type AssertConforms<T extends U, U> = T;

export type PublicAppearanceConformance = AssertConforms<
  PublicAppearance,
  PublicAppearanceState
>;
export type PublicPlayerConformance = AssertConforms<
  PublicPlayer,
  PublicPlayerState
>;
export type PublicMonsterConformance = AssertConforms<
  PublicMonster,
  PublicMonsterState
>;
export type VillageStateConformance = AssertConforms<
  VillageState,
  PublicVillageState
>;

export type {
  AssertConforms,
  PublicAppearance,
  PublicPlayer,
  PublicMonster,
  VillageState,
};

const MAX_PLAYER_HEALTH = 100;

export function createVillageRoom(
  playTickets: PlayTicketConsumer,
  options: {
    now?: () => number;
    reconnectGraceSeconds?: number;
    combatCatalog?: CombatCatalog;
    rng?: () => number;
    rewardRng?: () => number;
    rewardPersistence?: RewardPersistence;
    questPersistence?: QuestPersistence;
    equipmentPersistence?: EquipmentPersistence;
    developmentEquipmentEnabled?: boolean;
    developmentQuestEnabled?: boolean;
    logEquipmentPersistenceFailure?: (details: {
      operation: string;
      characterId: string;
      error: unknown;
    }) => void;
    checkpointLocation?:
      ((input: LocationCheckpointInput) => Promise<boolean>) | undefined;
    recordLifecycle?: (
      event: "disconnected" | "reconnected" | "removed",
    ) => void;
  } = {},
) {
  return class VillageRoom extends Room<{ state: VillageState }> {
    override state = new VillageState();
    readonly #pendingIntentions = new Map<
      string,
      Map<number, MovementIntention>
    >();
    readonly #intentionViolations = new Map<string, number>();
    readonly #lastProcessedSequences = new Map<string, number>();
    readonly #now = options.now ?? Date.now;
    readonly #reconnectGraceSeconds = options.reconnectGraceSeconds ?? 5;
    readonly #combatCatalog = options.combatCatalog ?? villageCombat;
    readonly #rng = options.rng ?? Math.random;
    readonly #rewardRng = options.rewardRng ?? options.rng ?? Math.random;
    readonly #rewardPersistence =
      options.rewardPersistence ?? new InMemoryRewardPersistence();
    readonly #questPersistence =
      options.questPersistence ??
      new InMemoryQuestPersistence(villageSlice.questId);
    readonly #developmentQuestPersistence = new InMemoryQuestPersistence(
      villageSlice.questId,
    );
    readonly #developmentQuestEnabled =
      options.developmentQuestEnabled ?? false;
    readonly #equipmentPersistence =
      options.equipmentPersistence ?? new UnavailableEquipmentPersistence();
    readonly #developmentEquipmentPersistence =
      new InMemoryEquipmentPersistence(developmentEquipmentSeed);
    readonly #developmentEquipmentEnabled =
      options.developmentEquipmentEnabled ?? false;
    readonly #logEquipmentPersistenceFailure =
      options.logEquipmentPersistenceFailure;
    readonly #checkpointLocation = options.checkpointLocation;
    readonly #questDefinition = villageQuests.quests.find(
      (quest) => quest.id === villageSlice.questId,
    );
    readonly #playerCombat = new Map<string, PlayerCombatState>();
    readonly #playerIdentity = new Map<
      string,
      { characterId: string; partyId: string | undefined }
    >();
    readonly #characterDialogueState = new Map<
      string,
      DialogueCharacterState
    >();
    readonly #questSnapshots = new Map<string, QuestSnapshot>();
    readonly #equipmentSnapshots = new Map<string, DurableEquipmentSnapshot>();
    readonly #dialogueSessions = new Map<
      string,
      { npcId: string; nodeId: string }
    >();
    readonly #lastInteractionAtMs = new Map<string, number>();
    readonly #lastDialogueActionAtMs = new Map<string, number>();
    readonly #joinedAtMs = new Map<string, number>();
    readonly #lastCheckpointAtMs = new Map<string, number>();
    readonly #disconnectedSessions = new Set<string>();
    readonly #participationWindow = new RewardSettlementWindow();
    #defeatSequence = 0;
    #monsterLifecycle!: MonsterLifecycle;

    override onCreate() {
      if (!this.#questDefinition) {
        throw new Error("Village quest definition is unavailable");
      }
      const monster = this.#combatCatalog.monsters[0];
      const encounter = this.#combatCatalog.encounters[0];
      if (!monster || !encounter) {
        throw new Error("Village combat encounter is unavailable");
      }
      const bossAction = monster.serverOnly.bossActionId
        ? this.#combatCatalog.monsterActions.find(
            (candidate) => candidate.id === monster.serverOnly.bossActionId,
          )
        : undefined;
      if (
        monster.serverOnly.behaviorProfile === "telegraphed_boss" &&
        !bossAction
      ) {
        throw new Error("Village boss action is unavailable");
      }
      this.#monsterLifecycle = new MonsterLifecycle({
        entityId: villageSlice.monsterEntityId,
        monster,
        encounter,
        world: { bounds: villageMap.bounds, obstacles: villageMap.collision },
        rng: this.#rng,
        bossAction,
      });
      this.#syncPublicMonster();

      this.maxMessagesPerSecond = 60;
      this.state.serverTimeMs = this.#now();
      this.onMessage(
        CLIENT_MESSAGES.movement,
        (client, unsafeIntention: unknown) => {
          const encodedIntention = JSON.stringify(unsafeIntention);
          const intention = movementIntentionSchema.safeParse(unsafeIntention);
          const player = this.state.players.get(client.sessionId);
          const pending = this.#pendingIntentions.get(client.sessionId);
          const lastProcessedSequence = this.#lastProcessedSequences.get(
            client.sessionId,
          );
          if (
            encodedIntention === undefined ||
            Buffer.byteLength(encodedIntention) > MAX_MOVEMENT_MESSAGE_BYTES ||
            !intention.success ||
            !player ||
            !pending ||
            lastProcessedSequence === undefined ||
            intention.data.sequence >
              lastProcessedSequence + MAX_PENDING_INTENTIONS
          ) {
            this.#rejectIntention(client);
            return;
          }
          if (intention.data.sequence <= lastProcessedSequence) return;
          pending.set(intention.data.sequence, intention.data);
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.targetSelection,
        (client, unsafeSelection: unknown) => {
          this.#applyCombatOutcome(
            client,
            resolveCombatAction(this.#combatActionState(client), {
              type: "targetSelection",
              raw: unsafeSelection,
            }),
          );
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.basicAttack,
        (client, unsafeIntention: unknown) => {
          this.#applyCombatOutcome(
            client,
            resolveCombatAction(this.#combatActionState(client), {
              type: "basicAttack",
              raw: unsafeIntention,
            }),
          );
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.ability,
        (client, unsafeIntention: unknown) => {
          this.#applyCombatOutcome(
            client,
            resolveCombatAction(this.#combatActionState(client), {
              type: "ability",
              raw: unsafeIntention,
            }),
          );
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.interaction,
        (client, unsafeIntention: unknown) => {
          this.#handleInteraction(client, unsafeIntention);
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.dialogueChoice,
        (client, unsafeIntention: unknown) => {
          void this.#handleDialogueChoice(client, unsafeIntention);
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.dialogueClose,
        (client, unsafeIntention: unknown) => {
          const intention = dialogueCloseSchema.safeParse(unsafeIntention);
          if (!intention.success) {
            this.#sendDialogueRejected(client, ERROR_CODES.invalidInteraction);
            return;
          }
          this.#dialogueSessions.delete(client.sessionId);
        },
      );
      this.onMessage(CLIENT_MESSAGES.questStateRequest, (client) => {
        this.#sendQuestState(client);
      });
      this.onMessage(
        CLIENT_MESSAGES.equipmentEquip,
        (client, unsafeIntention: unknown) => {
          void this.#handleEquipmentEquip(client, unsafeIntention);
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.equipmentUnequip,
        (client, unsafeIntention: unknown) => {
          void this.#handleEquipmentUnequip(client, unsafeIntention);
        },
      );
      this.onMessage(CLIENT_MESSAGES.equipmentStateRequest, (client) => {
        this.#sendEquipmentState(client);
      });

      this.setSimulationInterval(
        () => this.#simulateFixedStep(),
        PLAYER_MOVEMENT.fixedStepMs,
      );
    }

    async #handleEquipmentEquip(
      client: Client,
      unsafeIntention: unknown,
    ): Promise<void> {
      const encodedIntention = JSON.stringify(unsafeIntention);
      const intention = equipmentEquipSchema.safeParse(unsafeIntention);
      const snapshot = this.#equipmentSnapshots.get(client.sessionId);
      if (
        encodedIntention === undefined ||
        Buffer.byteLength(encodedIntention) > MAX_EQUIPMENT_MESSAGE_BYTES ||
        !intention.success ||
        !snapshot
      ) {
        this.#sendEquipmentResult(client, {
          accepted: false,
          actionId: intention.success ? intention.data.actionId : "invalid",
          code: ERROR_CODES.invalidEquipmentIntention,
        });
        return;
      }
      const definition = villageEquipment.items.find(
        (item) => item.id === intention.data.itemId,
      );
      if (!definition) {
        this.#sendEquipmentResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: ERROR_CODES.equipmentItemNotFound,
        });
        return;
      }
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!identity) return;
      let result;
      try {
        result = await this.#equipmentForCharacter(
          identity.characterId,
        ).equipItem({
          characterId: identity.characterId,
          item: {
            itemId: definition.id,
            slot: definition.slot,
            rigId: definition.serverOnly.rigId,
            layerId: definition.clientVisible.layerId,
            requirements: definition.serverOnly.requirements,
          },
          expectedCharacterRevision: intention.data.expectedCharacterRevision,
          now: new Date(this.state.serverTimeMs),
        });
      } catch (error) {
        this.#recordEquipmentPersistenceFailure(
          "equip",
          identity.characterId,
          error,
        );
        this.#sendEquipmentResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: ERROR_CODES.equipmentPersistenceUnavailable,
        });
        return;
      }
      this.#applyEquipmentSnapshot(client.sessionId, result.snapshot);
      if (!result.applied) {
        this.#sendEquipmentResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: equipmentFailureCode(result.reason),
          state: this.#equipmentState(result.snapshot),
        });
        return;
      }
      this.#sendEquipmentResult(client, {
        accepted: true,
        actionId: intention.data.actionId,
        state: this.#equipmentState(result.snapshot),
      });
    }

    async #handleEquipmentUnequip(
      client: Client,
      unsafeIntention: unknown,
    ): Promise<void> {
      const encodedIntention = JSON.stringify(unsafeIntention);
      const intention = equipmentUnequipSchema.safeParse(unsafeIntention);
      const snapshot = this.#equipmentSnapshots.get(client.sessionId);
      if (
        encodedIntention === undefined ||
        Buffer.byteLength(encodedIntention) > MAX_EQUIPMENT_MESSAGE_BYTES ||
        !intention.success ||
        !snapshot
      ) {
        this.#sendEquipmentResult(client, {
          accepted: false,
          actionId: intention.success ? intention.data.actionId : "invalid",
          code: ERROR_CODES.invalidEquipmentIntention,
        });
        return;
      }
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!identity) return;
      let result;
      try {
        result = await this.#equipmentForCharacter(
          identity.characterId,
        ).unequipItem({
          characterId: identity.characterId,
          slot: intention.data.slot,
          expectedCharacterRevision: intention.data.expectedCharacterRevision,
          now: new Date(this.state.serverTimeMs),
        });
      } catch (error) {
        this.#recordEquipmentPersistenceFailure(
          "unequip",
          identity.characterId,
          error,
        );
        this.#sendEquipmentResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: ERROR_CODES.equipmentPersistenceUnavailable,
        });
        return;
      }
      this.#applyEquipmentSnapshot(client.sessionId, result.snapshot);
      if (!result.applied) {
        this.#sendEquipmentResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: equipmentFailureCode(result.reason),
          state: this.#equipmentState(result.snapshot),
        });
        return;
      }
      this.#sendEquipmentResult(client, {
        accepted: true,
        actionId: intention.data.actionId,
        state: this.#equipmentState(result.snapshot),
      });
    }

    #applyEquipmentSnapshot(
      sessionId: string,
      snapshot: DurableEquipmentSnapshot,
    ): void {
      this.#equipmentSnapshots.set(sessionId, snapshot);
      const player = this.state.players.get(sessionId);
      if (!player) return;
      player.appearance.assign(snapshot.appearance);
      player.appearanceRevision = snapshot.appearanceRevision;
    }

    #equipmentForCharacter(characterId: string): EquipmentPersistence {
      return this.#developmentEquipmentEnabled &&
        characterId.startsWith("development:")
        ? this.#developmentEquipmentPersistence
        : this.#equipmentPersistence;
    }

    #questsForCharacter(characterId: string): QuestPersistence {
      return this.#developmentQuestEnabled &&
        characterId.startsWith("development:")
        ? this.#developmentQuestPersistence
        : this.#questPersistence;
    }

    #equipmentState(snapshot: DurableEquipmentSnapshot): EquipmentStateMessage {
      return {
        characterRevision: snapshot.characterRevision,
        appearanceRevision: snapshot.appearanceRevision,
        appearance: { ...snapshot.appearance },
        inventory: snapshot.inventory.map((item) => ({ ...item })),
        equipment: snapshot.equipment.map((item) => ({ ...item })),
      };
    }

    #sendEquipmentState(client: Client): void {
      const snapshot = this.#equipmentSnapshots.get(client.sessionId);
      if (snapshot) {
        client.send(
          SERVER_MESSAGES.equipmentState,
          this.#equipmentState(snapshot),
        );
      }
    }

    #sendEquipmentResult(client: Client, result: EquipmentResult): void {
      client.send(SERVER_MESSAGES.equipmentResult, result);
    }

    #recordEquipmentPersistenceFailure(
      operation: string,
      characterId: string,
      error: unknown,
    ): void {
      this.#logEquipmentPersistenceFailure?.({
        operation,
        characterId,
        error,
      });
    }

    // prettier-ignore
    async #reloadEquipment(sessionId: string, characterId: string, operation: string): Promise<void> {
      try {
        const snapshot = await this.#equipmentForCharacter(characterId).load(characterId);
        if (!this.state.players.has(sessionId)) return;
        this.#applyEquipmentSnapshot(sessionId, snapshot);
        const client = this.clients.find((candidate) => candidate.sessionId === sessionId);
        if (client) this.#sendEquipmentState(client);
      } catch (error) {
        this.#recordEquipmentPersistenceFailure(operation, characterId, error);
      }
    }

    #handleInteraction(client: Client, unsafeIntention: unknown): void {
      const encodedIntention = JSON.stringify(unsafeIntention);
      const intention = interactionSchema.safeParse(unsafeIntention);
      const player = this.state.players.get(client.sessionId);
      const character = this.#characterDialogueState.get(client.sessionId);
      if (
        encodedIntention === undefined ||
        Buffer.byteLength(encodedIntention) > MAX_DIALOGUE_MESSAGE_BYTES ||
        !intention.success ||
        !player ||
        !character
      ) {
        this.#sendDialogueRejected(client, ERROR_CODES.invalidInteraction);
        return;
      }

      const now = this.state.serverTimeMs;
      const lastInteractionAtMs = this.#lastInteractionAtMs.get(
        client.sessionId,
      );
      if (
        lastInteractionAtMs !== undefined &&
        now < lastInteractionAtMs + INTERACTION_RATE_LIMIT_MS
      ) {
        this.#sendDialogueRejected(client, ERROR_CODES.interactionRateLimited);
        return;
      }
      this.#lastInteractionAtMs.set(client.sessionId, now);

      const interactive = villageMap.interactives.find(
        (candidate) => candidate.id === intention.data.interactiveId,
      );
      const npc = villageDialogue.npcs.find(
        (candidate) => candidate.interactiveId === intention.data.interactiveId,
      );
      if (!interactive || !npc) {
        this.#sendDialogueRejected(client, ERROR_CODES.interactionNotFound);
        return;
      }
      const interactiveX = interactive.x + interactive.width / 2;
      const interactiveY = interactive.y + interactive.height / 2;
      if (
        Math.hypot(player.x - interactiveX, player.y - interactiveY) >
        INTERACTION_RADIUS
      ) {
        this.#sendDialogueRejected(client, ERROR_CODES.interactionOutOfRange);
        return;
      }

      const graph = villageDialogue.graphs.find(
        (candidate) => candidate.id === npc.graphId,
      );
      if (!graph) {
        this.#sendDialogueRejected(client, ERROR_CODES.dialogueBlocked);
        return;
      }
      const resolved = resolveDialogueNode(
        villageDialogue,
        npc.id,
        graph.rootNodeId,
        character,
      );
      if (!resolved.success) {
        this.#sendDialogueRejected(
          client,
          resolved.reason === "blocked"
            ? ERROR_CODES.dialogueBlocked
            : ERROR_CODES.interactionNotFound,
        );
        return;
      }
      this.#dialogueSessions.set(client.sessionId, {
        npcId: npc.id,
        nodeId: resolved.node.nodeId,
      });
      client.send(SERVER_MESSAGES.dialogueNode, resolved.node);
    }

    async #handleDialogueChoice(
      client: Client,
      unsafeIntention: unknown,
    ): Promise<void> {
      const encodedIntention = JSON.stringify(unsafeIntention);
      const intention = dialogueChoiceSchema.safeParse(unsafeIntention);
      const character = this.#characterDialogueState.get(client.sessionId);
      const session = this.#dialogueSessions.get(client.sessionId);
      if (
        encodedIntention === undefined ||
        Buffer.byteLength(encodedIntention) > MAX_DIALOGUE_MESSAGE_BYTES ||
        !intention.success ||
        !character
      ) {
        this.#sendDialogueRejected(client, ERROR_CODES.invalidInteraction);
        return;
      }
      if (!session) {
        this.#sendDialogueRejected(client, ERROR_CODES.dialogueNotActive);
        return;
      }
      const now = this.state.serverTimeMs;
      const lastDialogueActionAtMs = this.#lastDialogueActionAtMs.get(
        client.sessionId,
      );
      if (
        lastDialogueActionAtMs !== undefined &&
        now < lastDialogueActionAtMs + DIALOGUE_ACTION_RATE_LIMIT_MS
      ) {
        this.#sendDialogueRejected(client, ERROR_CODES.interactionRateLimited);
        return;
      }
      this.#lastDialogueActionAtMs.set(client.sessionId, now);
      if (
        session.npcId !== intention.data.npcId ||
        session.nodeId !== intention.data.nodeId
      ) {
        this.#sendDialogueRejected(client, ERROR_CODES.dialogueChoiceInvalid);
        return;
      }

      const resolved = resolveDialogueChoice(
        villageDialogue,
        session.npcId,
        session.nodeId,
        intention.data.choiceId,
        character,
      );
      if (!resolved.success) {
        this.#sendDialogueRejected(
          client,
          resolved.reason === "blocked"
            ? ERROR_CODES.dialogueBlocked
            : ERROR_CODES.dialogueChoiceInvalid,
        );
        return;
      }
      if (resolved.action) {
        const actionResult = await this.#applyQuestAction(
          client,
          resolved.action,
        );
        if (!actionResult) return;
      }
      if ("closed" in resolved) {
        this.#dialogueSessions.delete(client.sessionId);
        client.send(SERVER_MESSAGES.dialogueClosed, {
          npcId: session.npcId,
        });
        return;
      }
      this.#dialogueSessions.set(client.sessionId, {
        npcId: session.npcId,
        nodeId: resolved.node.nodeId,
      });
      client.send(SERVER_MESSAGES.dialogueNode, resolved.node);
    }

    #sendDialogueRejected(
      client: Client,
      code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    ): void {
      client.send(SERVER_MESSAGES.dialogueRejected, { code });
    }

    async #applyQuestAction(
      client: Client,
      action: DialogueQuestAction,
    ): Promise<boolean> {
      const identity = this.#playerIdentity.get(client.sessionId);
      const definition = this.#questDefinition;
      if (!identity || !definition || action.questId !== definition.id) {
        this.#sendQuestRejected(client, ERROR_CODES.questNotFound);
        return false;
      }
      const reward: QuestReward | undefined =
        action.kind === "complete_quest"
          ? definition.serverOnly.reward
          : undefined;
      try {
        const result = await this.#questsForCharacter(
          identity.characterId,
        ).transitionQuest({
          characterId: identity.characterId,
          questId: definition.id,
          objective: definition.serverOnly.objective,
          transition:
            action.kind === "accept_quest"
              ? { kind: "accept" }
              : {
                  kind: "complete",
                  completionId: `quest-completion:${identity.characterId}:${definition.id}`,
                },
          ...(reward === undefined ? {} : { reward }),
        });
        if (!result.applied) {
          this.#sendQuestRejected(
            client,
            result.reason === "objective_mismatch"
              ? ERROR_CODES.questObjectiveInvalid
              : ERROR_CODES.questTransitionInvalid,
          );
          return false;
        }
        this.#setQuestSnapshot(client.sessionId, result.snapshot);
        this.#sendQuestState(client);
        if (action.kind === "complete_quest") {
          client.send(SERVER_MESSAGES.questReward, {
            questId: definition.id,
            ...definition.serverOnly.reward,
          } satisfies QuestRewardMessage);
          void this.#reloadEquipment(
            client.sessionId,
            identity.characterId,
            "quest_completion_reload",
          );
        }
        return true;
      } catch {
        this.#sendQuestRejected(
          client,
          ERROR_CODES.questPersistenceUnavailable,
        );
        return false;
      }
    }

    async #applyQuestObjectiveProgress(
      characterId: string,
      eventId: string,
      targetId: string,
    ): Promise<void> {
      const sessionId = [...this.#playerIdentity.entries()].find(
        ([, identity]) => identity.characterId === characterId,
      )?.[0];
      const definition = this.#questDefinition;
      if (!sessionId || !definition) return;
      const current = this.#questSnapshots.get(sessionId);
      if (!current || current.status !== "active") return;
      try {
        const result = await this.#questsForCharacter(
          characterId,
        ).transitionQuest({
          characterId,
          questId: definition.id,
          objective: definition.serverOnly.objective,
          transition: { kind: "objective", eventId, targetId },
        });
        if (!result.applied) return;
        this.#setQuestSnapshot(sessionId, result.snapshot);
        const client = this.clients.find(
          (candidate) => candidate.sessionId === sessionId,
        );
        if (client) this.#sendQuestState(client);
      } catch {
        const client = this.clients.find(
          (candidate) => candidate.sessionId === sessionId,
        );
        if (client)
          this.#sendQuestRejected(
            client,
            ERROR_CODES.questPersistenceUnavailable,
          );
      }
    }

    #setQuestSnapshot(sessionId: string, snapshot: QuestSnapshot): void {
      this.#questSnapshots.set(sessionId, snapshot);
      const character = this.#characterDialogueState.get(sessionId);
      if (!character) return;
      const questStatuses = new Map(character.questStatuses ?? []);
      questStatuses.set(snapshot.questId, snapshot.status);
      const completedQuestIds = new Set(character.completedQuestIds);
      if (snapshot.status === "completed") {
        completedQuestIds.add(snapshot.questId);
      }
      this.#characterDialogueState.set(sessionId, {
        ...character,
        completedQuestIds,
        questStatuses,
      });
    }

    #sendQuestState(client: Client): void {
      const definition = this.#questDefinition;
      const snapshot = this.#questSnapshots.get(client.sessionId);
      if (!definition || !snapshot) return;
      const message: QuestStateMessage = {
        questId: definition.id,
        status: snapshot.status,
        progress: snapshot.progress,
        requiredCount: definition.serverOnly.objective.requiredCount,
        title: definition.clientVisible.title,
        description: definition.clientVisible.description,
        guidance: definition.clientVisible.guidance,
      };
      client.send(SERVER_MESSAGES.questState, message);
    }

    #sendQuestRejected(
      client: Client,
      code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    ): void {
      client.send(SERVER_MESSAGES.questRejected, { code });
    }

    #combatActionState(client: Client): CombatActionState {
      return {
        nowMs: this.state.serverTimeMs,
        catalog: this.#combatCatalog,
        monster: this.#monsterLifecycle,
        player: this.state.players.get(client.sessionId),
        combat: this.#playerCombat.get(client.sessionId),
      };
    }

    #applyCombatOutcome(client: Client, outcome: CombatActionOutcome): void {
      switch (outcome.type) {
        case "ignored":
          return;
        case "rejected":
          this.#rejectCombat(client, outcome.code);
          return;
        case "result":
          this.#sendCombatResult(client, outcome.result);
          return;
        case "targetSelected":
          client.send(SERVER_MESSAGES.targetSelected, {
            targetEntityId: outcome.targetEntityId,
          });
          return;
        case "resolved":
          if (outcome.recordParticipation) this.#recordParticipation(client);
          this.#syncPublicMonster();
          for (const broadcast of outcome.broadcasts) {
            this.broadcast(SERVER_MESSAGES.combatEvent, broadcast);
          }
          this.#sendCombatResult(client, outcome.result);
          this.#sendCombatState(client);
          if (outcome.monsterDefeated) {
            this.#completeMonsterDefeat(outcome.defeatedEntityId);
          }
          return;
      }
    }

    override async onJoin(client: Client, unsafeOptions: unknown) {
      const options = joinOptionsSchema.safeParse(unsafeOptions);
      if (!options.success) {
        throw new ServerError(4_221, ERROR_CODES.invalidJoinOptions);
      }
      const consumption = await playTickets.consume(options.data.ticket);
      if (!consumption.success) {
        throw new ServerError(4_223, consumption.code);
      }
      if (consumption.admission.logicalDestination !== villageSlice.mapId) {
        throw new ServerError(4_224, ERROR_CODES.destinationNotAllowed);
      }
      if (
        consumption.admission.contentVersion !== villageSlice.contentVersion
      ) {
        throw new ServerError(4_225, ERROR_CODES.staleContentVersion);
      }

      let equipment: DurableEquipmentSnapshot;
      try {
        equipment = await this.#equipmentForCharacter(
          consumption.admission.characterId,
        ).load(
          consumption.admission.characterId,
          consumption.admission.appearance,
        );
      } catch (error) {
        this.#recordEquipmentPersistenceFailure(
          "join_load",
          consumption.admission.characterId,
          error,
        );
        throw new ServerError(
          4_226,
          ERROR_CODES.equipmentPersistenceUnavailable,
        );
      }
      const player = new PublicPlayer();
      player.displayName = consumption.admission.displayName;
      const spawn = villageMap.spawns.find(
        (candidate) => candidate.entranceId === villageSlice.entranceId,
      );
      if (!spawn) throw new Error("Village player spawn is unavailable");
      const savedPosition = validSavedPosition(
        consumption.admission.characterState,
      );
      player.x = savedPosition?.x ?? spawn.x;
      player.y = savedPosition?.y ?? spawn.y;
      player.appearance.assign(equipment.appearance);
      player.appearanceRevision = equipment.appearanceRevision;
      this.state.players.set(client.sessionId, player);
      this.#equipmentSnapshots.set(client.sessionId, equipment);
      this.#playerIdentity.set(client.sessionId, {
        characterId: consumption.admission.characterId,
        partyId: consumption.admission.partyId,
      });
      const questSnapshot = await this.#questsForCharacter(
        consumption.admission.characterId,
      ).loadQuest(
        consumption.admission.characterId,
        this.#questDefinition?.id ?? villageSlice.questId,
      );
      this.#questSnapshots.set(client.sessionId, questSnapshot);
      this.#characterDialogueState.set(client.sessionId, {
        level: consumption.admission.characterState?.progression.level ?? 1,
        flags: new Set(),
        completedQuestIds: new Set(),
        questStatuses: new Map([[questSnapshot.questId, questSnapshot.status]]),
      });
      this.#joinedAtMs.set(client.sessionId, this.state.serverTimeMs);
      this.#pendingIntentions.set(client.sessionId, new Map());
      this.#lastProcessedSequences.set(client.sessionId, 0);
      this.#intentionViolations.set(client.sessionId, 0);
      const classDefinition = this.#combatCatalog.classes[0];
      if (!classDefinition) throw new Error("Village class is unavailable");
      this.#playerCombat.set(client.sessionId, {
        targetEntityId: null,
        resource: classDefinition.serverOnly.startingResource,
        health: MAX_PLAYER_HEALTH,
        cooldownEndsAtMs: 0,
        lastActionAtMs: undefined,
        lastTargetSelectionAtMs: undefined,
        cooldowns: new Map(),
        movementLockedUntilMs: 0,
        statuses: new Map(),
        recentActionIds: [],
      });
      this.#checkpoint(client.sessionId, "online");
      this.#sendCombatState(client);
      this.#sendQuestState(client);
      this.#sendEquipmentState(client);
    }

    override onLeave(client: Client) {
      this.#checkpoint(client.sessionId, "offline");
      this.#pendingIntentions.delete(client.sessionId);
      this.#intentionViolations.delete(client.sessionId);
      this.#lastProcessedSequences.delete(client.sessionId);
      this.#playerCombat.delete(client.sessionId);
      this.#playerIdentity.delete(client.sessionId);
      this.#characterDialogueState.delete(client.sessionId);
      this.#questSnapshots.delete(client.sessionId);
      this.#equipmentSnapshots.delete(client.sessionId);
      this.#dialogueSessions.delete(client.sessionId);
      this.#lastInteractionAtMs.delete(client.sessionId);
      this.#lastDialogueActionAtMs.delete(client.sessionId);
      this.#joinedAtMs.delete(client.sessionId);
      this.#lastCheckpointAtMs.delete(client.sessionId);
      this.#disconnectedSessions.delete(client.sessionId);
      this.state.players.delete(client.sessionId);
      options.recordLifecycle?.("removed");
    }

    override onDrop(client: Client) {
      if (!this.state.players.has(client.sessionId)) return;
      this.#checkpoint(client.sessionId, "disconnected");
      this.#disconnectedSessions.add(client.sessionId);
      options.recordLifecycle?.("disconnected");
      void this.allowReconnection(client, this.#reconnectGraceSeconds).catch(
        () => undefined,
      );
    }

    override onReconnect(client: Client) {
      this.#disconnectedSessions.delete(client.sessionId);
      this.#checkpoint(client.sessionId, "online");
      options.recordLifecycle?.("reconnected");
      this.#sendAuthoritativeMovement(client);
    }

    #rejectIntention(client: Client) {
      client.send(SERVER_MESSAGES.intentionRejected, {
        code: ERROR_CODES.invalidMovementIntention,
      });
      const score = (this.#intentionViolations.get(client.sessionId) ?? 0) + 1;
      this.#intentionViolations.set(client.sessionId, score);
      if (score >= MAX_INTENTION_VIOLATIONS) {
        client.leave(4_008, ERROR_CODES.invalidMovementIntention);
      }
    }

    #simulateFixedStep() {
      this.state.serverTimeMs = this.#now();
      for (const [sessionId, player] of this.state.players) {
        const pending = this.#pendingIntentions.get(sessionId);
        const combat = this.#playerCombat.get(sessionId);
        if (combat)
          expireCombatStatuses(combat.statuses, this.state.serverTimeMs);
        if (combat) this.#sendCombatStateBySessionId(sessionId);
        const lastProcessedSequence =
          this.#lastProcessedSequences.get(sessionId) ?? 0;
        const nextSequence = lastProcessedSequence + 1;
        const intention = pending?.get(nextSequence);
        if (!intention) {
          player.animation = "idle";
          continue;
        }
        pending?.delete(nextSequence);
        this.#lastProcessedSequences.set(sessionId, nextSequence);
        const isMoving = intention.x !== 0 || intention.y !== 0;
        const controlState = combat
          ? combatControlState(combat.statuses, this.#combatCatalog.statuses)
          : "normal";
        const movementLocked =
          (combat?.movementLockedUntilMs ?? 0) > this.state.serverTimeMs ||
          controlState !== "normal";
        player.animation = isMoving && !movementLocked ? "walk" : "idle";
        if (!isMoving) {
          this.#sendAuthoritativeMovementBySessionId(sessionId);
          continue;
        }
        if (movementLocked) {
          this.#sendAuthoritativeMovementBySessionId(sessionId);
          continue;
        }

        if (intention.x < 0) player.facing = "west";
        else if (intention.x > 0) player.facing = "east";

        const moved = moveCharacterFoot({
          footPosition: player,
          direction: intention,
          speed: PLAYER_MOVEMENT.speed,
          elapsedMs: PLAYER_MOVEMENT.fixedStepMs,
          collision: villageCharacter.collision,
          world: {
            bounds: villageMap.bounds,
            obstacles: villageMap.collision,
          },
        });
        player.x = moved.x;
        player.y = moved.y;
        this.#sendAuthoritativeMovementBySessionId(sessionId);
        if (combat) this.#sendCombatStateBySessionId(sessionId);
      }
      for (const sessionId of this.state.players.keys()) {
        const lastCheckpointAtMs = this.#lastCheckpointAtMs.get(sessionId) ?? 0;
        if (this.state.serverTimeMs >= lastCheckpointAtMs + 5_000) {
          this.#checkpoint(sessionId, "online");
        }
      }
      const lifecycleEvents = this.#monsterLifecycle.tick(
        this.state.serverTimeMs,
        [...this.state.players].map(([id, player]) => ({
          id,
          x: player.x,
          y: player.y,
        })),
      );
      this.#syncPublicMonster();
      for (const event of lifecycleEvents) {
        if (event.type === "cast_started") {
          this.broadcast(SERVER_MESSAGES.combatTelegraph, {
            entityId: this.#monsterLifecycle.state.entityId,
            abilityId: event.abilityId,
            startTimeMs: event.startTimeMs,
            durationMs: event.durationMs,
            interruptible: event.interruptible,
          });
          this.broadcast(SERVER_MESSAGES.combatEvent, {
            kind: "cast_started",
            entityId: this.#monsterLifecycle.state.entityId,
          });
        } else if (event.type === "attack") {
          const combat = this.#playerCombat.get(event.targetId);
          if (!combat) continue;
          const monster = this.#combatCatalog.monsters[0]!;
          const action = event.abilityId
            ? this.#combatCatalog.monsterActions.find(
                (candidate) => candidate.id === event.abilityId,
              )
            : undefined;
          const damage =
            action?.serverOnly.effects
              .filter((effect) => effect.kind === "damage")
              .reduce((total, effect) => total + effect.amount, 0) ??
            monster.serverOnly.attackDamage;
          combat.health = Math.max(0, combat.health - damage);
          if (action)
            applyMonsterEffectsToPlayer(
              combat,
              action.serverOnly.effects,
              this.#combatCatalog,
              this.state.serverTimeMs,
            );
          this.broadcast(SERVER_MESSAGES.combatEvent, {
            kind: "attack",
            entityId: this.#monsterLifecycle.state.entityId,
          });
          const client = this.clients.find(
            (candidate) => candidate.sessionId === event.targetId,
          );
          client?.send(SERVER_MESSAGES.damageTaken, {
            amount: damage,
            remainingHealth: combat.health,
          });
          this.#sendCombatStateBySessionId(event.targetId);
        } else if (event.type === "aggro") {
          this.broadcast(SERVER_MESSAGES.combatEvent, {
            kind: "aggro",
            entityId: this.#monsterLifecycle.state.entityId,
          });
        } else if (event.type === "respawned") {
          this.#participationWindow.open();
          this.broadcast(SERVER_MESSAGES.combatEvent, {
            kind: "respawned",
            entityId: this.#monsterLifecycle.state.entityId,
            healthFraction: 1,
          });
        } else if (event.type === "interrupted") {
          this.broadcast(SERVER_MESSAGES.combatEvent, {
            kind: "interrupted",
            entityId: this.#monsterLifecycle.state.entityId,
          });
        }
      }
    }

    #checkpoint(
      sessionId: string,
      connectionState: LocationCheckpointInput["connectionState"],
    ): void {
      if (!this.#checkpointLocation) return;
      const player = this.state.players.get(sessionId);
      const identity = this.#playerIdentity.get(sessionId);
      const spawn = villageMap.spawns.find(
        (candidate) => candidate.entranceId === villageSlice.entranceId,
      );
      if (!player || !identity || !spawn) return;
      this.#lastCheckpointAtMs.set(sessionId, this.state.serverTimeMs);
      void this.#checkpointLocation({
        characterId: identity.characterId,
        logicalMapId: villageSlice.mapId,
        entranceId: villageSlice.entranceId,
        position: { x: player.x, y: player.y },
        safeSpawn: { x: spawn.x, y: spawn.y },
        connectionState,
        now: new Date(this.state.serverTimeMs),
      }).catch(() => undefined);
    }

    #sendCombatStateBySessionId(sessionId: string): void {
      const client = this.clients.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (client) this.#sendCombatState(client);
    }

    #sendCombatState(client: Client): void {
      const combat = this.#playerCombat.get(client.sessionId);
      if (!combat) return;
      const message = buildCombatStateMessage(
        combat,
        this.#combatCatalog,
        this.state.serverTimeMs,
      );
      if (!message) return;
      client.send(SERVER_MESSAGES.combatState, message);
    }

    #rejectCombat(
      client: Client,
      code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    ) {
      client.send(SERVER_MESSAGES.combatRejected, { code });
    }

    #sendCombatResult(client: Client, result: CombatResult) {
      client.send(SERVER_MESSAGES.combatResult, result);
    }

    // Kept compact so room remains only adapter: record, settle, persist, send.
    // prettier-ignore
    #recordParticipation(client: Client): void {
      const identity = this.#playerIdentity.get(client.sessionId);
      if (identity) this.#participationWindow.recordActivity({ ...identity, atMs: this.state.serverTimeMs });
    }

    // prettier-ignore
    #completeMonsterDefeat(monsterEntityId: string): void {
      const candidates: RewardCandidate[] = []; for (const [recipientSessionId, player] of this.state.players) {
        const identity = this.#playerIdentity.get(recipientSessionId);
        if (!identity) continue;
        candidates.push({ ...identity, recipientSessionId, x: player.x, y: player.y,
          connected: !this.#disconnectedSessions.has(recipientSessionId), joinedAtMs: this.#joinedAtMs.get(recipientSessionId) ?? Number.MAX_SAFE_INTEGER });
      }
      const monster = this.#monsterLifecycle.state; const sourceMonsterId = this.#combatCatalog.monsters[0]?.id;
      if (!sourceMonsterId) return;
      const defeatSequence = ++this.#defeatSequence; const settlement = settleDefeat({
        participationWindow: this.#participationWindow, defeatedMonster: {
          entityId: monsterEntityId, sourceMonsterId, position: { x: monster.x, y: monster.y } },
        roomInstanceId: this.roomId, defeatSequence, candidates,
        combatCatalog: this.#combatCatalog, clock: () => this.state.serverTimeMs, random: this.#rewardRng,
      });
      for (const grant of settlement.grants) {
        void this.#applyQuestObjectiveProgress(grant.characterId, grant.completionId, sourceMonsterId); if (!grant.reward) continue;
        void this.#rewardPersistence.grant(grant.reward).then(() => {
          void this.#reloadEquipment(grant.recipientSessionId, grant.characterId, "reward_reload");
          this.clients.find((client) => client.sessionId === grant.recipientSessionId)
            ?.send(SERVER_MESSAGES.rewardSummary, { sourceMonsterId,
              items: [{ itemId: grant.reward!.itemId, quantity: grant.reward!.quantity }] });
        }).catch(() => undefined);
      }
    }

    #monsterHealthFraction(): number {
      const monster = this.#monsterLifecycle.state;
      return monster.maxHealth === 0 ? 0 : monster.health / monster.maxHealth;
    }

    #syncPublicMonster() {
      const monster = this.#monsterLifecycle.state;
      const definition = this.#combatCatalog.monsters[0];
      if (!definition) return;
      const publicMonster =
        this.state.monsters.get(monster.entityId) ?? new PublicMonster();
      publicMonster.displayName = definition.clientVisible.displayName;
      publicMonster.x = monster.x;
      publicMonster.y = monster.y;
      publicMonster.animation =
        monster.state === "defeated"
          ? "defeated"
          : monster.state === "attacking"
            ? "attack"
            : monster.state === "chasing" || monster.state === "leashing"
              ? "walk"
              : "idle";
      publicMonster.healthFraction = this.#monsterHealthFraction();
      this.state.monsters.set(monster.entityId, publicMonster);
    }

    #sendAuthoritativeMovementBySessionId(sessionId: string) {
      const client = this.clients.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (client) this.#sendAuthoritativeMovement(client);
    }

    #sendAuthoritativeMovement(client: Client) {
      const player = this.state.players.get(client.sessionId);
      const lastProcessedSequence = this.#lastProcessedSequences.get(
        client.sessionId,
      );
      if (!player || lastProcessedSequence === undefined) return;
      const snapshot: AuthoritativeMovementSnapshot = {
        x: player.x,
        y: player.y,
        lastProcessedSequence,
        serverTimeMs: this.state.serverTimeMs,
      };
      client.send(SERVER_MESSAGES.authoritativeMovement, snapshot);
    }
  };
}

function validSavedPosition(
  state: DurableCharacterState | undefined,
): { x: number; y: number } | undefined {
  const location = state?.location;
  if (
    !location ||
    location.logicalMapId !== villageSlice.mapId ||
    !villageMap.spawns.some((spawn) => spawn.entranceId === location.entranceId)
  ) {
    return undefined;
  }
  const { x, y } = location.position;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const body = {
    x:
      x +
      villageCharacter.collision.offsetX -
      villageCharacter.collision.width / 2,
    y:
      y +
      villageCharacter.collision.offsetY -
      villageCharacter.collision.height / 2,
    width: villageCharacter.collision.width,
    height: villageCharacter.collision.height,
  };
  const insideBounds =
    body.x >= villageMap.bounds.x &&
    body.y >= villageMap.bounds.y &&
    body.x + body.width <= villageMap.bounds.x + villageMap.bounds.width &&
    body.y + body.height <= villageMap.bounds.y + villageMap.bounds.height;
  if (!insideBounds) return undefined;
  if (
    villageMap.collision.some(
      (obstacle) =>
        body.x < obstacle.x + obstacle.width &&
        body.x + body.width > obstacle.x &&
        body.y < obstacle.y + obstacle.height &&
        body.y + body.height > obstacle.y,
    )
  ) {
    return undefined;
  }
  return { x, y };
}

function equipmentFailureCode(
  reason:
    | "stale_revision"
    | "item_not_owned"
    | "incompatible_item"
    | "requirements_not_met"
    | "already_equipped"
    | "not_equipped",
): (typeof ERROR_CODES)[keyof typeof ERROR_CODES] {
  switch (reason) {
    case "stale_revision":
      return ERROR_CODES.staleCharacterRevision;
    case "item_not_owned":
      return ERROR_CODES.itemNotOwned;
    case "incompatible_item":
      return ERROR_CODES.incompatibleEquipment;
    case "requirements_not_met":
      return ERROR_CODES.equipmentRequirementsNotMet;
    case "not_equipped":
      return ERROR_CODES.equipmentNotEquipped;
    case "already_equipped":
      return ERROR_CODES.equipmentAlreadyEquipped;
  }
}
