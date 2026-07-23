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
  DurableEquipmentSnapshot,
  LocationCheckpointInput,
} from "@gameish/database";
import type { CombatCatalog } from "@gameish/content/combat";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type CombatResult,
  type EquipmentResult,
  type EquipmentStateMessage,
  type MapChatMessage,
  type MovementIntention,
  type PublicAppearance as PublicAppearanceState,
  type PublicMonsterState,
  type PublicPlayerState,
  type PublicVillageState,
  type TransitionRejectedMessage,
  type TransitionTicketMessage,
  type PartyResultMessage,
} from "@gameish/protocol";
import { moveCharacterFoot, PLAYER_MOVEMENT } from "@gameish/world";
import { z } from "zod";

import type { PlayTicketConsumer } from "../identity/play-tickets.js";
import type { TransitionTicketIssuer } from "../identity/transition-tickets.js";
import {
  PortalCooldownRegistry,
  PortalTransitionCoordinator,
} from "./portal-transition-handler.js";
import { portalTransitionSchema } from "./portal-transition.js";
import {
  DEFAULT_MAP_INSTANCE_HARD_CAPACITY,
  MapPlacementDriver,
  type MapRoomMetadata,
} from "./placement.js";
import { resolveSpawnPosition } from "./spawn-resolution.js";
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
  InMemoryQuestPersistence,
  type QuestPersistence,
} from "../quests/persistence.js";
import {
  QuestDialogueSession,
  type QuestDialogueDecision,
  type QuestDialogueMessage,
} from "../quests/session.js";
import {
  MapChatRateLimiter,
  validateMapChatIntention,
} from "../chat/map-chat.js";
import { PartyCoordinator } from "../party/coordinator.js";
import { registerPartyRoomHandlers } from "../party/room-handlers.js";
import { prepareTravelToMember } from "../party/travel-to-member.js";

const clientJoinOptionsSchema = z
  .object({ ticket: z.string().min(1).max(200) })
  .strict();
const joinOptionsSchema = clientJoinOptionsSchema.extend({
  partyReservationId: z.string().min(1).max(100).optional(),
});
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
const DEFAULT_CHECKPOINT_TIMEOUT_MS = 1_000;

export function createVillageRoom(
  playTickets: PlayTicketConsumer,
  options: {
    now?: () => number;
    reconnectGraceSeconds?: number;
    hardCapacity?: number;
    combatCatalog?: CombatCatalog;
    rng?: () => number;
    rewardRng?: () => number;
    rewardPersistence?: RewardPersistence;
    questPersistence?: QuestPersistence;
    equipmentPersistence?: EquipmentPersistence;
    developmentEquipmentEnabled?: boolean;
    developmentQuestEnabled?: boolean;
    mapChatEnabled?: boolean;
    mapChatRateLimiter?: MapChatRateLimiter;
    recordMapChat?: (details: {
      outcome: "accepted" | "rejected";
      code?: "CHAT_DISABLED" | "INVALID_CHAT_MESSAGE" | "CHAT_RATE_LIMITED";
      utf8Bytes?: number;
      lineCount?: number;
    }) => void;
    logEquipmentPersistenceFailure?: (details: {
      operation: string;
      characterId: string;
      error: unknown;
    }) => void;
    checkpointLocation?:
      ((input: LocationCheckpointInput) => Promise<boolean>) | undefined;
    checkpointTimeoutMs?: number;
    recordCheckpointTimeout?: (details: {
      logicalMapId: string;
      sessionId: string;
      connectionState: LocationCheckpointInput["connectionState"];
      timeoutMs: number;
    }) => void;
    recordLifecycle?: (
      event: "disconnected" | "reconnected" | "removed",
    ) => void;
    transitionTickets?: TransitionTicketIssuer;
    portalCooldowns?: PortalCooldownRegistry;
    parties?: PartyCoordinator;
    placement?: MapPlacementDriver;
    canAccessMap?: (characterId: string, logicalMapId: string) => boolean;
    recordPartyTravelFailure?: (actionId: string) => void;
  } = {},
) {
  const transitionTickets: TransitionTicketIssuer =
    options.transitionTickets ?? {
      issue: () => Promise.resolve(undefined),
    };
  // Shared across every logical-map room when the server wires it, so the
  // cooldown survives the transition that removes the source session.
  const portalCooldowns =
    options.portalCooldowns ?? new PortalCooldownRegistry();
  const parties = options.parties ?? new PartyCoordinator();
  const placement =
    options.placement ??
    new MapPlacementDriver({
      softPopulationTarget: 25,
      hardCapacity: options.hardCapacity ?? DEFAULT_MAP_INSTANCE_HARD_CAPACITY,
    });
  return class VillageRoom extends Room<{
    state: VillageState;
    metadata: MapRoomMetadata;
  }> {
    override state = new VillageState();
    readonly #pendingIntentions = new Map<
      string,
      Map<number, MovementIntention>
    >();
    readonly #intentionViolations = new Map<string, number>();
    readonly #lastProcessedSequences = new Map<string, number>();
    readonly #now = options.now ?? Date.now;
    readonly #reconnectGraceSeconds = options.reconnectGraceSeconds ?? 5;
    readonly #checkpointTimeoutMs = Math.min(
      options.checkpointTimeoutMs ?? DEFAULT_CHECKPOINT_TIMEOUT_MS,
      Math.max(1, this.#reconnectGraceSeconds * 1_000),
    );
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
    readonly #mapChatEnabled = options.mapChatEnabled ?? false;
    readonly #mapChatRateLimiter =
      options.mapChatRateLimiter ?? new MapChatRateLimiter();
    readonly #logEquipmentPersistenceFailure =
      options.logEquipmentPersistenceFailure;
    readonly #checkpointLocation = options.checkpointLocation;
    readonly #questDefinition = villageQuests.quests.find(
      (quest) => quest.id === villageSlice.questId,
    );
    readonly #playerCombat = new Map<string, PlayerCombatState>();
    readonly #playerIdentity = new Map<
      string,
      { userId: string; characterId: string; partyId: string | undefined }
    >();
    readonly #sessionEntranceId = new Map<string, string>();
    readonly #portalTransitions = new PortalTransitionCoordinator({
      sourceMap: villageMap,
      transitionTickets,
      cooldowns: portalCooldowns,
      now: this.#now,
    });
    readonly #questSessions = new Map<string, QuestDialogueSession>();
    readonly #equipmentSnapshots = new Map<string, DurableEquipmentSnapshot>();
    readonly #lastInteractionAtMs = new Map<string, number>();
    readonly #lastDialogueActionAtMs = new Map<string, number>();
    readonly #joinedAtMs = new Map<string, number>();
    readonly #lastCheckpointAtMs = new Map<string, number>();
    readonly #disconnectedSessions = new Set<string>();
    readonly #partyDepartures = new Set<string>();
    readonly #participationWindow = new RewardSettlementWindow();
    #defeatSequence = 0;
    #monsterLifecycle!: MonsterLifecycle;

    static override onAuth(
      _token: string,
      unsafeOptions: unknown,
    ): Promise<unknown> {
      const parsed = clientJoinOptionsSchema.safeParse(unsafeOptions);
      if (!parsed.success) {
        throw new ServerError(4_221, ERROR_CODES.invalidJoinOptions);
      }
      const reservationId = parties.travelReservationForAdmission(
        parsed.data.ticket,
        villageSlice.mapId,
        (options.now ?? Date.now)(),
      );
      if (
        reservationId !== undefined &&
        !placement.hasPartyReservationToken(reservationId, villageSlice.mapId)
      ) {
        throw new ServerError(4_228, ERROR_CODES.instanceUnavailable);
      }
      if (reservationId !== undefined) {
        (unsafeOptions as { partyReservationId?: string }).partyReservationId =
          reservationId;
      }
      return Promise.resolve(true);
    }

    override onCreate(unsafeOptions?: unknown) {
      const creationOptions = joinOptionsSchema.safeParse(unsafeOptions);
      this.maxClients =
        options.hardCapacity ?? DEFAULT_MAP_INSTANCE_HARD_CAPACITY;
      this.metadata = {
        logicalMapId: villageSlice.mapId,
        instanceRole: "public",
        ...(creationOptions.success &&
        creationOptions.data.partyReservationId !== undefined
          ? { partyReservationId: creationOptions.data.partyReservationId }
          : {}),
      };
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
      registerPartyRoomHandlers({
        room: this,
        parties,
        memberIdFor: (sessionId) =>
          this.#playerIdentity.get(sessionId)?.characterId,
        travelToMember: (client, intention) =>
          this.#handleTravelToMember(client, intention),
        ...(options.recordPartyTravelFailure === undefined
          ? {}
          : {
              recordUnexpectedTravelFailure: options.recordPartyTravelFailure,
            }),
      });
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
          this.#questSessions.get(client.sessionId)?.closeDialogue();
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
      this.onMessage(
        CLIENT_MESSAGES.mapChat,
        (client, unsafeIntention: unknown) => {
          this.#handleMapChat(client, unsafeIntention);
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.portalTransition,
        (client, unsafeIntention: unknown) => {
          const memberId = this.#playerIdentity.get(
            client.sessionId,
          )?.characterId;
          void this.#handlePortalTransition(client, unsafeIntention).catch(
            () => {
              if (memberId) parties.cancelTravelForParty(memberId);
              const actionId =
                unsafeIntention &&
                typeof unsafeIntention === "object" &&
                "actionId" in unsafeIntention &&
                typeof unsafeIntention.actionId === "string"
                  ? unsafeIntention.actionId
                  : "invalid-transition";
              options.recordPartyTravelFailure?.(actionId);
              client.send(SERVER_MESSAGES.transitionRejected, {
                actionId,
                code: ERROR_CODES.transitionUnavailable,
              } satisfies TransitionRejectedMessage);
            },
          );
        },
      );

      this.setSimulationInterval(
        () => this.#simulateFixedStep(),
        PLAYER_MOVEMENT.fixedStepMs,
      );
    }

    #handleMapChat(client: Client, unsafeIntention: unknown): void {
      if (!this.#mapChatEnabled) {
        options.recordMapChat?.({ outcome: "rejected", code: "CHAT_DISABLED" });
        client.send(SERVER_MESSAGES.chatRejected, {
          code: ERROR_CODES.chatDisabled,
        });
        return;
      }
      const validation = validateMapChatIntention(unsafeIntention);
      if (!validation.accepted) {
        options.recordMapChat?.({
          outcome: "rejected",
          code: "INVALID_CHAT_MESSAGE",
          ...(validation.utf8Bytes === undefined
            ? {}
            : { utf8Bytes: validation.utf8Bytes }),
          ...(validation.lineCount === undefined
            ? {}
            : { lineCount: validation.lineCount }),
        });
        client.send(SERVER_MESSAGES.chatRejected, {
          code: ERROR_CODES.invalidChatMessage,
        });
        return;
      }
      const identity = this.#playerIdentity.get(client.sessionId);
      const player = this.state.players.get(client.sessionId);
      if (!identity || !player) return;
      if (
        !this.#mapChatRateLimiter.allow(
          identity.userId,
          this.state.serverTimeMs,
        )
      ) {
        options.recordMapChat?.({
          outcome: "rejected",
          code: "CHAT_RATE_LIMITED",
          utf8Bytes: validation.utf8Bytes,
          lineCount: validation.lineCount,
        });
        client.send(SERVER_MESSAGES.chatRejected, {
          code: ERROR_CODES.chatRateLimited,
        });
        return;
      }
      const message: MapChatMessage = {
        entityId: client.sessionId,
        displayName: player.displayName,
        text: validation.text,
        serverTimeMs: this.state.serverTimeMs,
      };
      options.recordMapChat?.({
        outcome: "accepted",
        utf8Bytes: validation.utf8Bytes,
        lineCount: validation.lineCount,
      });
      this.broadcast(SERVER_MESSAGES.mapChat, message);
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
      const session = this.#questSessions.get(client.sessionId);
      if (
        encodedIntention === undefined ||
        Buffer.byteLength(encodedIntention) > MAX_DIALOGUE_MESSAGE_BYTES ||
        !intention.success ||
        !player ||
        !session
      )
        return this.#sendDialogueRejected(
          client,
          ERROR_CODES.invalidInteraction,
        );
      const now = this.state.serverTimeMs;
      const lastInteractionAtMs = this.#lastInteractionAtMs.get(
        client.sessionId,
      );
      if (
        lastInteractionAtMs !== undefined &&
        now < lastInteractionAtMs + INTERACTION_RATE_LIMIT_MS
      )
        return this.#sendDialogueRejected(
          client,
          ERROR_CODES.interactionRateLimited,
        );
      this.#lastInteractionAtMs.set(client.sessionId, now);
      const interactive = villageMap.interactives.find(
        (candidate) => candidate.id === intention.data.interactiveId,
      );
      if (!interactive)
        return this.#sendDialogueRejected(
          client,
          ERROR_CODES.interactionNotFound,
        );
      const interactiveX = interactive.x + interactive.width / 2;
      const interactiveY = interactive.y + interactive.height / 2;
      if (
        Math.hypot(player.x - interactiveX, player.y - interactiveY) >
        INTERACTION_RADIUS
      )
        return this.#sendDialogueRejected(
          client,
          ERROR_CODES.interactionOutOfRange,
        );
      const outcome = session.interact({
        interactiveId: intention.data.interactiveId,
      });
      if (outcome.kind === "messages")
        this.#sendQuestDialogueMessages(client, outcome.messages);
    }

    // prettier-ignore
    async #handleDialogueChoice(client: Client, unsafeIntention: unknown): Promise<void> {
      const encodedIntention = JSON.stringify(unsafeIntention); const intention = dialogueChoiceSchema.safeParse(unsafeIntention);
      const session = this.#questSessions.get(client.sessionId);
      if (
        encodedIntention === undefined ||
        Buffer.byteLength(encodedIntention) > MAX_DIALOGUE_MESSAGE_BYTES ||
        !intention.success ||
        !session
      )
        return this.#sendDialogueRejected(
          client,
          ERROR_CODES.invalidInteraction,
        );
      const now = this.state.serverTimeMs; const lastDialogueActionAtMs = this.#lastDialogueActionAtMs.get(client.sessionId);
      if (
        lastDialogueActionAtMs !== undefined &&
        now < lastDialogueActionAtMs + DIALOGUE_ACTION_RATE_LIMIT_MS
      )
        return this.#sendDialogueRejected(
          client,
          ERROR_CODES.interactionRateLimited,
        );
      this.#lastDialogueActionAtMs.set(client.sessionId, now);
      const outcome = session.chooseDialogue({
        npcId: intention.data.npcId,
        nodeId: intention.data.nodeId,
        choiceId: intention.data.choiceId,
      });
      if (outcome.kind === "messages")
        return this.#sendQuestDialogueMessages(client, outcome.messages);
      await this.#persistQuestDecision(session, outcome, client);
    }

    // prettier-ignore
    #sendDialogueRejected(client: Client, code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]): void { client.send(SERVER_MESSAGES.dialogueRejected, { code }); }

    // prettier-ignore
    async #persistQuestDecision(session: QuestDialogueSession, decision: Extract<QuestDialogueDecision, { kind: "transition" }>, client?: Client): Promise<void> {
      try { const result = await this.#questsForCharacter(decision.request.characterId).transitionQuest(decision.request); if (client) this.#sendQuestDialogueMessages(client, session.applyTransition(decision, result)); else session.applyTransition(decision, result); } catch { if (client) this.#sendQuestDialogueMessages(client, session.persistenceFailure(decision)); }
    }

    // prettier-ignore
    async #applyQuestObjectiveProgress(characterId: string, eventId: string, targetId: string): Promise<void> {
      const sessionId = [...this.#playerIdentity.entries()].find(([, identity]) => identity.characterId === characterId)?.[0]; const session = sessionId ? this.#questSessions.get(sessionId) : undefined; if (!sessionId || !session) return;
      const decision = session.objectiveProgress({ eventId, targetId }); if (!decision) return; const client = this.clients.find((candidate) => candidate.sessionId === sessionId); await this.#persistQuestDecision(session, decision, client);
    }

    // prettier-ignore
    #sendQuestState(client: Client): void { const session = this.#questSessions.get(client.sessionId); if (session) this.#sendQuestDialogueMessages(client, [session.questStateMessage()]); }

    // prettier-ignore
    #sendQuestDialogueMessages(client: Client, messages: QuestDialogueMessage[]): void { for (const message of messages) { client.send(SERVER_MESSAGES[message.type], message.payload); if (message.type !== "questReward") continue; const characterId = this.#playerIdentity.get(client.sessionId)?.characterId; if (characterId) void this.#reloadEquipment(client.sessionId, characterId, "quest_completion_reload"); } }

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

    async #handlePortalTransition(
      client: Client,
      unsafeIntention: unknown,
    ): Promise<void> {
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!identity) return;
      const intention = portalTransitionSchema.safeParse(unsafeIntention);
      if (!intention.success) return;
      const plan = parties.beginCohesiveTravel(
        identity.characterId,
        this.roomId,
        intention.data.travelMode === "alone",
      );
      if (!plan.accepted) {
        const actionId =
          unsafeIntention &&
          typeof unsafeIntention === "object" &&
          "actionId" in unsafeIntention &&
          typeof unsafeIntention.actionId === "string"
            ? unsafeIntention.actionId
            : "invalid-transition";
        client.send(SERVER_MESSAGES.transitionRejected, {
          actionId,
          code: plan.code,
        } satisfies TransitionRejectedMessage);
        return;
      }
      const outcome = await this.#portalTransitions.evaluateCohesive({
        initiatorSessionId: client.sessionId,
        unsafeIntention: intention.data,
        reservationId: plan.reservationId,
        members: plan.members.map((member) => {
          const player = this.state.players.get(member.entityId);
          const memberIdentity = this.#playerIdentity.get(member.entityId);
          return {
            sessionId: member.entityId,
            playerFoot: player ? { x: player.x, y: player.y } : undefined,
            identity: memberIdentity,
            checkpoint: () =>
              this.#checkpointLocation &&
              memberIdentity &&
              !memberIdentity.characterId.startsWith("development:")
                ? this.#checkpoint(member.entityId, "online")
                : Promise.resolve(true),
          };
        }),
        reserveCapacity: (reservation) =>
          placement.reservePartyCapacity({
            reservationId: reservation.reservationId,
            logicalMapId: reservation.destinationMapId,
            memberIds: reservation.memberIds,
            expiresAtMs: reservation.expiresAtMs,
          }).accepted,
        releaseCapacity: (reservationId) =>
          placement.releasePartyReservation(reservationId),
        extendCapacity: (reservationId, expiresAtMs) =>
          placement.extendPartyReservation(reservationId, expiresAtMs),
        revalidateMembers: () =>
          parties.cohesiveTravelStillAvailable(plan.members, this.roomId),
      });
      if (outcome.kind === "invalid") {
        parties.cancelTravel(plan.members.map((member) => member.memberId));
        return;
      }
      if (outcome.kind === "rejected") {
        parties.cancelTravel(plan.members.map((member) => member.memberId));
        if (outcome.code === ERROR_CODES.transitionUnavailable) {
          options.recordPartyTravelFailure?.(outcome.actionId);
        }
        client.send(SERVER_MESSAGES.transitionRejected, {
          actionId: outcome.actionId,
          code: outcome.code,
        } satisfies TransitionRejectedMessage);
        return;
      }
      if (
        outcome.admissions.some(
          (admission) =>
            this.#disconnectedSessions.has(admission.sessionId) ||
            !this.clients.some(
              (candidate) => candidate.sessionId === admission.sessionId,
            ),
        )
      ) {
        placement.releasePartyReservation(outcome.reservationId);
        parties.cancelTravel(plan.members.map((member) => member.memberId));
        client.send(SERVER_MESSAGES.transitionRejected, {
          actionId: outcome.actionId,
          code: ERROR_CODES.partyMemberUnavailable,
        } satisfies TransitionRejectedMessage);
        return;
      }
      for (const admission of outcome.admissions) {
        parties.bindTravelAdmission({
          ticket: admission.ticket,
          reservationId: outcome.reservationId,
          memberId: admission.memberId,
          logicalMapId: outcome.destinationMapId,
          expiresAtMs: admission.expiresAtMs,
        });
      }
      for (const admission of outcome.admissions) {
        const traveler = this.clients.find(
          (candidate) => candidate.sessionId === admission.sessionId,
        )!;
        traveler.send(SERVER_MESSAGES.transitionTicket, {
          actionId: outcome.actionId,
          ticket: admission.ticket,
          destinationRoomName: outcome.destinationRoomName,
          destinationMapId: outcome.destinationMapId,
          expiresAtMs: admission.expiresAtMs,
        } satisfies TransitionTicketMessage);
      }
      for (const admission of outcome.admissions) {
        const traveler = this.clients.find(
          (candidate) => candidate.sessionId === admission.sessionId,
        )!;
        parties.departForTravel(admission.memberId);
        this.#partyDepartures.add(admission.sessionId);
        this.#removeSession(admission.sessionId);
        traveler.leave(4_000, "portal_transition");
      }
    }

    async #handleTravelToMember(
      client: Client,
      intention: { actionId: string; targetEntityId: string },
    ): Promise<void> {
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!identity) return;
      const plan = parties.beginTravelToMember(
        identity.characterId,
        intention.targetEntityId,
      );
      if (!plan.accepted) {
        client.send(SERVER_MESSAGES.partyResult, {
          accepted: false,
          actionId: intention.actionId,
          code: plan.code,
        } satisfies PartyResultMessage);
        return;
      }
      const outcome = await prepareTravelToMember({
        actionId: intention.actionId,
        plan,
        placement,
        transitionTickets,
        now: this.#now,
        canAccessMap: options.canAccessMap ?? (() => false),
        checkpoint: () =>
          this.#checkpointLocation &&
          !identity.characterId.startsWith("development:")
            ? this.#checkpoint(client.sessionId, "online")
            : Promise.resolve(true),
        revalidate: () => parties.travelToMemberStillAvailable(plan),
      });
      if (outcome.kind === "rejected") {
        parties.cancelTravel([identity.characterId]);
        if (outcome.code === ERROR_CODES.transitionUnavailable) {
          options.recordPartyTravelFailure?.(outcome.actionId);
        }
        client.send(SERVER_MESSAGES.partyResult, {
          accepted: false,
          actionId: outcome.actionId,
          code: outcome.code,
        } satisfies PartyResultMessage);
        return;
      }
      if (
        !parties.travelToMemberStillAvailable(plan) ||
        this.#disconnectedSessions.has(client.sessionId) ||
        !this.clients.some(
          (candidate) => candidate.sessionId === client.sessionId,
        )
      ) {
        placement.releasePartyReservation(outcome.reservationId);
        parties.cancelTravel([identity.characterId]);
        client.send(SERVER_MESSAGES.partyResult, {
          accepted: false,
          actionId: intention.actionId,
          code: ERROR_CODES.partyMemberUnavailable,
        } satisfies PartyResultMessage);
        return;
      }
      parties.bindTravelAdmission({
        ticket: outcome.ticket,
        reservationId: outcome.reservationId,
        memberId: outcome.memberId,
        logicalMapId: outcome.destinationMapId,
        expiresAtMs: outcome.expiresAtMs,
      });
      client.send(SERVER_MESSAGES.partyResult, {
        accepted: true,
        actionId: outcome.actionId,
      } satisfies PartyResultMessage);
      client.send(SERVER_MESSAGES.transitionTicket, {
        actionId: outcome.actionId,
        ticket: outcome.ticket,
        destinationRoomName: outcome.destinationRoomName,
        destinationMapId: outcome.destinationMapId,
        expiresAtMs: outcome.expiresAtMs,
      } satisfies TransitionTicketMessage);
      parties.departForTravel(identity.characterId);
      this.#partyDepartures.add(client.sessionId);
      this.#removeSession(client.sessionId);
      client.leave(4_000, "party_travel_to_member");
    }

    #removeSession(sessionId: string): void {
      this.#pendingIntentions.delete(sessionId);
      this.#intentionViolations.delete(sessionId);
      this.#lastProcessedSequences.delete(sessionId);
      this.#playerCombat.delete(sessionId);
      this.#playerIdentity.delete(sessionId);
      this.#questSessions.delete(sessionId);
      this.#equipmentSnapshots.delete(sessionId);
      this.#lastInteractionAtMs.delete(sessionId);
      this.#lastDialogueActionAtMs.delete(sessionId);
      this.#joinedAtMs.delete(sessionId);
      this.#lastCheckpointAtMs.delete(sessionId);
      this.#disconnectedSessions.delete(sessionId);
      this.#sessionEntranceId.delete(sessionId);
      this.#portalTransitions.clearSession(sessionId);
      this.state.players.delete(sessionId);
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
      const entranceId = consumption.admission.entranceId;
      const position = resolveSpawnPosition({
        map: villageMap,
        entranceId,
        savedState: consumption.admission.characterState,
        collision: villageCharacter.collision,
      });
      if (!position) {
        throw new ServerError(4_227, ERROR_CODES.entranceNotFound);
      }

      const definition = this.#questDefinition;
      if (!definition)
        throw new Error("Village quest definition is unavailable");
      const questSnapshot = await this.#questsForCharacter(
        consumption.admission.characterId,
      ).loadQuest(consumption.admission.characterId, definition.id);
      const questSession = new QuestDialogueSession({
        characterId: consumption.admission.characterId,
        character: {
          level: consumption.admission.characterState?.progression.level ?? 1,
          flags: new Set(),
        },
        snapshot: questSnapshot,
        definition,
        dialogue: villageDialogue,
      });
      const classDefinition = this.#combatCatalog.classes[0];
      if (!classDefinition) throw new Error("Village class is unavailable");

      // Consume the coordinated seat only after all fallible join preparation
      // has completed, so a failed equipment/quest load cannot free capacity
      // that the rest of the party was promised.
      if (options.data.partyReservationId !== undefined) {
        if (
          !parties.claimTravelAdmission(
            options.data.ticket,
            options.data.partyReservationId,
            consumption.admission.characterId,
            villageSlice.mapId,
            this.#now(),
          ) ||
          !placement.claimPartySeat(
            options.data.partyReservationId,
            villageSlice.mapId,
            consumption.admission.characterId,
            this.roomId,
          )
        ) {
          throw new ServerError(4_228, ERROR_CODES.instanceUnavailable);
        }
      }

      const player = new PublicPlayer();
      player.displayName = consumption.admission.displayName;
      player.x = position.x;
      player.y = position.y;
      player.appearance.assign(equipment.appearance);
      player.appearanceRevision = equipment.appearanceRevision;
      this.state.players.set(client.sessionId, player);
      this.#equipmentSnapshots.set(client.sessionId, equipment);
      this.#sessionEntranceId.set(client.sessionId, entranceId);
      this.#playerIdentity.set(client.sessionId, {
        userId: consumption.admission.userId,
        characterId: consumption.admission.characterId,
        partyId: consumption.admission.partyId,
      });
      parties.registerPresence({
        memberId: consumption.admission.characterId,
        userId: consumption.admission.userId,
        entityId: client.sessionId,
        displayName: consumption.admission.displayName,
        logicalMapId: villageSlice.mapId,
        internalRoomId: this.roomId,
        send: (messageType, payload) => client.send(messageType, payload),
      });
      this.#questSessions.set(client.sessionId, questSession);
      this.#joinedAtMs.set(client.sessionId, this.state.serverTimeMs);
      this.#pendingIntentions.set(client.sessionId, new Map());
      this.#lastProcessedSequences.set(client.sessionId, 0);
      this.#intentionViolations.set(client.sessionId, 0);
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
      void this.#checkpoint(client.sessionId, "online");
      this.#sendCombatState(client);
      this.#sendQuestState(client);
      this.#sendEquipmentState(client);
      client.send(SERVER_MESSAGES.chatAvailability, {
        enabled: this.#mapChatEnabled,
      });
    }

    override async onLeave(client: Client) {
      // Colyseus waits for this lifecycle hook before disposing an empty
      // room. Keep the final checkpoint inside that grace boundary so the
      // placement driver cannot observe a freed seat before durable recovery
      // state has been attempted.
      await this.#checkpoint(client.sessionId, "offline");
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!this.#partyDepartures.delete(client.sessionId) && identity) {
        parties.disconnect(identity.characterId);
      }
      this.#removeSession(client.sessionId);
      options.recordLifecycle?.("removed");
    }

    override onDrop(client: Client) {
      if (!this.state.players.has(client.sessionId)) return;
      void this.#checkpoint(client.sessionId, "disconnected");
      this.#disconnectedSessions.add(client.sessionId);
      const identity = this.#playerIdentity.get(client.sessionId);
      if (identity) parties.markDisconnected(identity.characterId);
      options.recordLifecycle?.("disconnected");
      void this.allowReconnection(client, this.#reconnectGraceSeconds).catch(
        () => undefined,
      );
    }

    override onReconnect(client: Client) {
      this.#disconnectedSessions.delete(client.sessionId);
      const identity = this.#playerIdentity.get(client.sessionId);
      if (identity) parties.markReconnected(identity.characterId);
      void this.#checkpoint(client.sessionId, "online");
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
          void this.#checkpoint(sessionId, "online");
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

    async #checkpoint(
      sessionId: string,
      connectionState: LocationCheckpointInput["connectionState"],
    ): Promise<boolean> {
      if (!this.#checkpointLocation) return false;
      const player = this.state.players.get(sessionId);
      const identity = this.#playerIdentity.get(sessionId);
      const entranceId =
        this.#sessionEntranceId.get(sessionId) ?? villageSlice.entranceId;
      const spawn = villageMap.spawns.find(
        (candidate) => candidate.entranceId === entranceId,
      );
      if (!player || !identity || !spawn) return false;
      this.#lastCheckpointAtMs.set(sessionId, this.state.serverTimeMs);
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const checkpoint = this.#checkpointLocation({
          characterId: identity.characterId,
          logicalMapId: villageSlice.mapId,
          entranceId,
          position: { x: player.x, y: player.y },
          safeSpawn: { x: spawn.x, y: spawn.y },
          connectionState,
          now: new Date(this.state.serverTimeMs),
        });
        const bounded = new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => {
            options.recordCheckpointTimeout?.({
              logicalMapId: villageSlice.mapId,
              sessionId,
              connectionState,
              timeoutMs: this.#checkpointTimeoutMs,
            });
            resolve(false);
          }, this.#checkpointTimeoutMs);
        });
        try {
          return await Promise.race([checkpoint, bounded]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      } catch {
        return false;
      }
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
      if (identity) this.#participationWindow.recordActivity({ ...identity,
        partyId: parties.partyIdFor(identity.characterId),
        atMs: this.state.serverTimeMs });
    }

    // prettier-ignore
    #completeMonsterDefeat(monsterEntityId: string): void {
      const candidates: RewardCandidate[] = []; for (const [recipientSessionId, player] of this.state.players) {
        const identity = this.#playerIdentity.get(recipientSessionId);
        if (!identity) continue;
        candidates.push({ ...identity,
          partyId: parties.partyIdFor(identity.characterId),
          recipientSessionId, x: player.x, y: player.y,
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
        void this.#applyQuestObjectiveProgress(grant.characterId, grant.objectiveEventId, sourceMonsterId); if (!grant.reward) continue;
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
