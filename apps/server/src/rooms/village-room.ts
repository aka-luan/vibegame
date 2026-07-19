import { Room, ServerError, type Client } from "@colyseus/core";
import { MapSchema, Schema, type } from "@colyseus/schema";
import villageCombat from "@gameish/content/village-combat-server";
import villageCharacter from "@gameish/content/village-character";
import villageMap from "@gameish/content/village-map-server";
import villageDialogue from "@gameish/content/village-dialogue-server";
import villageQuests from "@gameish/content/village-quests-server";
import type {
  DurableCharacterState,
  LocationCheckpointInput,
} from "@gameish/database";
import type { CombatCatalog, CombatEffect } from "@gameish/content/combat";
import type { DialogueQuestAction } from "@gameish/content/dialogue";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type CombatResult,
  type CombatStateMessage,
  type CombatEffectFeedback,
  type MovementIntention,
  type QuestRewardMessage,
  type QuestStateMessage,
} from "@gameish/protocol";
import { moveCharacterFoot, PLAYER_MOVEMENT } from "@gameish/world";
import { z } from "zod";

import type { PlayTicketConsumer } from "../identity/play-tickets.js";
import { MonsterLifecycle } from "../combat/monster-lifecycle.js";
import { resolveAbility, resolveBasicAttack } from "../combat/resolver.js";
import {
  applyCombatStatus,
  combatControlState,
  expireCombatStatuses,
  type ActiveCombatStatus,
} from "../combat/status.js";
import { rewardGrantId } from "../rewards/grants.js";
import { rollPersonalLoot } from "../rewards/loot.js";
import {
  InMemoryRewardPersistence,
  type RewardPersistence,
} from "../rewards/persistence.js";
import {
  ParticipationWindow,
  type ParticipationCandidate,
} from "../rewards/participation.js";
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
const targetSelectionSchema = z
  .object({ targetEntityId: z.string().trim().min(1).max(80) })
  .strict();
const basicAttackSchema = z
  .object({
    actionId: z.string().trim().min(1).max(64),
    targetEntityId: z.string().trim().min(1).max(80),
  })
  .strict();
const abilitySchema = z
  .object({
    actionId: z.string().trim().min(1).max(64),
    abilityId: z.string().trim().min(1).max(80),
    targetEntityId: z.string().trim().min(1).max(80),
  })
  .strict();
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

const MAX_MOVEMENT_MESSAGE_BYTES = 256;
const MAX_COMBAT_MESSAGE_BYTES = 256;
const TARGET_SELECTION_RATE_LIMIT_MS = 100;
const MAX_INTENTION_VIOLATIONS = 5;
const MAX_PENDING_INTENTIONS = 120;
const REWARD_PROXIMITY_RADIUS = 180;
const REWARD_AFK_AFTER_MS = 5_000;
const INTERACTION_RADIUS = 56;
const INTERACTION_RATE_LIMIT_MS = 250;
const DIALOGUE_ACTION_RATE_LIMIT_MS = 100;
const MAX_DIALOGUE_MESSAGE_BYTES = 256;

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
  facing = "east";

  @type("string")
  animation = "idle";

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
  animation = "idle";

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

interface PlayerCombatState {
  targetEntityId: string | null;
  resource: number;
  health: number;
  cooldownEndsAtMs: number;
  lastActionAtMs: number | undefined;
  lastTargetSelectionAtMs: number | undefined;
  cooldowns: Map<string, number>;
  movementLockedUntilMs: number;
  statuses: Map<string, ActiveCombatStatus>;
  recentActionIds: string[];
}

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
      new InMemoryQuestPersistence("quest:forest_mossbacks");
    readonly #checkpointLocation = options.checkpointLocation;
    readonly #questDefinition = villageQuests.quests.find(
      (quest) => quest.id === "quest:forest_mossbacks",
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
    readonly #dialogueSessions = new Map<
      string,
      { npcId: string; nodeId: string }
    >();
    readonly #lastInteractionAtMs = new Map<string, number>();
    readonly #lastDialogueActionAtMs = new Map<string, number>();
    readonly #joinedAtMs = new Map<string, number>();
    readonly #lastActivityAtMs = new Map<string, number>();
    readonly #lastCheckpointAtMs = new Map<string, number>();
    readonly #disconnectedSessions = new Set<string>();
    #participationWindow!: ParticipationWindow;
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
        entityId: "monster:village_mossback:1",
        monster,
        encounter,
        world: { bounds: villageMap.bounds, obstacles: villageMap.collision },
        rng: this.#rng,
        bossAction,
      });
      this.#participationWindow = this.#newParticipationWindow();
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
          const encodedSelection = JSON.stringify(unsafeSelection);
          const selection = targetSelectionSchema.safeParse(unsafeSelection);
          const combat = this.#playerCombat.get(client.sessionId);
          if (
            encodedSelection === undefined ||
            Buffer.byteLength(encodedSelection) > MAX_COMBAT_MESSAGE_BYTES ||
            !selection.success ||
            !combat
          ) {
            this.#rejectCombat(client, ERROR_CODES.invalidTargetSelection);
            return;
          }
          const target = this.#monsterLifecycle.state;
          if (combat.health <= 0) {
            this.#rejectCombat(client, ERROR_CODES.invalidCombatState);
            return;
          }
          if (
            selection.data.targetEntityId !== target.entityId ||
            target.state === "defeated"
          ) {
            this.#rejectCombat(client, ERROR_CODES.targetNotFound);
            return;
          }
          const player = this.state.players.get(client.sessionId);
          if (
            !player ||
            Math.hypot(player.x - target.x, player.y - target.y) >
              (this.#combatCatalog.monsters[0]?.serverOnly.aggroRange ?? 0)
          ) {
            this.#rejectCombat(client, ERROR_CODES.targetOutOfRange);
            return;
          }
          if (
            combat.lastTargetSelectionAtMs !== undefined &&
            this.state.serverTimeMs <
              combat.lastTargetSelectionAtMs + TARGET_SELECTION_RATE_LIMIT_MS
          ) {
            this.#rejectCombat(client, ERROR_CODES.actionRateLimited);
            return;
          }
          combat.lastTargetSelectionAtMs = this.state.serverTimeMs;
          combat.targetEntityId = target.entityId;
          client.send(SERVER_MESSAGES.targetSelected, {
            targetEntityId: target.entityId,
          });
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.basicAttack,
        (client, unsafeIntention: unknown) => {
          const encodedIntention = JSON.stringify(unsafeIntention);
          const intention = basicAttackSchema.safeParse(unsafeIntention);
          const combat = this.#playerCombat.get(client.sessionId);
          if (
            encodedIntention === undefined ||
            Buffer.byteLength(encodedIntention) > MAX_COMBAT_MESSAGE_BYTES ||
            !intention.success ||
            !combat
          ) {
            this.#sendCombatResult(client, {
              accepted: false,
              actionId: intention.success ? intention.data.actionId : "invalid",
              code: ERROR_CODES.invalidCombatIntention,
            });
            return;
          }

          const target = this.#monsterLifecycle.state;
          if (combat.targetEntityId === null) {
            this.#sendCombatResult(client, {
              accepted: false,
              actionId: intention.data.actionId,
              code: ERROR_CODES.targetNotSelected,
            });
            return;
          }
          if (
            intention.data.targetEntityId !== combat.targetEntityId ||
            intention.data.targetEntityId !== target.entityId
          ) {
            this.#sendCombatResult(client, {
              accepted: false,
              actionId: intention.data.actionId,
              code: ERROR_CODES.targetNotFound,
            });
            return;
          }

          const classDefinition = this.#combatCatalog.classes[0];
          const attackId = classDefinition?.serverOnly.basicAttackId;
          const attack = this.#combatCatalog.attacks.find(
            (candidate) => candidate.id === attackId,
          );
          if (!classDefinition || !attack) {
            this.#sendCombatResult(client, {
              accepted: false,
              actionId: intention.data.actionId,
              code: ERROR_CODES.invalidCombatState,
            });
            return;
          }
          const player = this.state.players.get(client.sessionId);
          if (!player) return;
          const resolution = resolveBasicAttack({
            nowMs: this.state.serverTimeMs,
            lastActionAtMs: combat.lastActionAtMs,
            cooldownEndsAtMs: combat.cooldownEndsAtMs,
            attacker: {
              x: player.x,
              y: player.y,
              resource: combat.resource,
              defeated: combat.health <= 0,
            },
            target: {
              x: target.x,
              y: target.y,
              health: target.health,
              maxHealth: target.maxHealth,
              defeated: target.state === "defeated",
            },
            attack,
          });
          if (!resolution.accepted) {
            this.#sendCombatResult(client, {
              accepted: false,
              actionId: intention.data.actionId,
              code: resolution.code,
            });
            return;
          }

          this.#recordParticipation(client);
          combat.resource = resolution.remainingResource;
          combat.cooldownEndsAtMs = resolution.cooldownEndsAtMs;
          combat.cooldowns.set(attack.id, resolution.cooldownEndsAtMs);
          combat.lastActionAtMs = this.state.serverTimeMs;
          const lifecycleResult = this.#monsterLifecycle.applyDamage(
            resolution.damage,
            this.state.serverTimeMs,
          );
          this.#syncPublicMonster();
          const defeated = lifecycleResult.type === "defeated";
          this.broadcast(SERVER_MESSAGES.combatEvent, {
            kind: defeated ? "defeated" : "hit",
            entityId: target.entityId,
            healthFraction: this.#monsterHealthFraction(),
          });
          this.#sendCombatResult(client, {
            accepted: true,
            actionId: intention.data.actionId,
            targetEntityId: target.entityId,
            damage: resolution.damage,
            remainingResource: combat.resource,
            cooldownEndsAtMs: combat.cooldownEndsAtMs,
            defeated,
          });
          this.#sendCombatState(client);
          if (defeated) {
            combat.targetEntityId = null;
            this.#completeMonsterDefeat(target.entityId);
          }
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.ability,
        (client, unsafeIntention: unknown) => {
          this.#handleAbility(client, unsafeIntention);
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

      this.setSimulationInterval(
        () => this.#simulateFixedStep(),
        PLAYER_MOVEMENT.fixedStepMs,
      );
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
      const completionId =
        action.kind === "complete_quest"
          ? `quest-completion:${identity.characterId}:${definition.id}`
          : undefined;
      try {
        const result = await this.#questPersistence.transitionQuest({
          characterId: identity.characterId,
          questId: definition.id,
          objective: definition.serverOnly.objective,
          transition:
            action.kind === "accept_quest"
              ? { kind: "accept" }
              : { kind: "complete" },
          ...(reward === undefined ? {} : { reward }),
          ...(completionId === undefined ? {} : { completionId }),
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
        const result = await this.#questPersistence.transitionQuest({
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

    #handleAbility(client: Client, unsafeIntention: unknown): void {
      const encodedIntention = JSON.stringify(unsafeIntention);
      const intention = abilitySchema.safeParse(unsafeIntention);
      const combat = this.#playerCombat.get(client.sessionId);
      if (
        encodedIntention === undefined ||
        Buffer.byteLength(encodedIntention) > MAX_COMBAT_MESSAGE_BYTES ||
        !intention.success ||
        !combat
      ) {
        this.#sendCombatResult(client, {
          accepted: false,
          actionId: intention.success ? intention.data.actionId : "invalid",
          code: ERROR_CODES.invalidCombatIntention,
        });
        return;
      }
      if (combat.recentActionIds.includes(intention.data.actionId)) {
        this.#sendCombatResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: ERROR_CODES.staleAction,
        });
        return;
      }
      combat.recentActionIds.push(intention.data.actionId);
      if (combat.recentActionIds.length > 64) combat.recentActionIds.shift();

      const classDefinition = this.#combatCatalog.classes[0];
      const ability = this.#combatCatalog.abilities.find(
        (candidate) =>
          candidate.id === intention.data.abilityId &&
          classDefinition?.serverOnly.abilityIds.includes(candidate.id),
      );
      if (!classDefinition || !ability) {
        this.#sendCombatResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: ERROR_CODES.abilityNotFound,
        });
        return;
      }
      if (combat.targetEntityId === null) {
        this.#sendCombatResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: ERROR_CODES.targetNotSelected,
        });
        return;
      }
      const target = this.#monsterLifecycle.state;
      if (
        intention.data.targetEntityId !== combat.targetEntityId ||
        intention.data.targetEntityId !== target.entityId
      ) {
        this.#sendCombatResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: ERROR_CODES.targetNotFound,
        });
        return;
      }
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const cooldownEndsAtMs = combat.cooldowns.get(ability.id) ?? 0;
      const resolution = resolveAbility({
        nowMs: this.state.serverTimeMs,
        lastActionAtMs: combat.lastActionAtMs,
        cooldownEndsAtMs,
        attacker: {
          x: player.x,
          y: player.y,
          resource: combat.resource,
          defeated: combat.health <= 0,
        },
        target: {
          x: target.x,
          y: target.y,
          health: target.health,
          maxHealth: target.maxHealth,
          defeated: target.state === "defeated",
        },
        ability,
      });
      if (!resolution.accepted) {
        this.#sendCombatResult(client, {
          accepted: false,
          actionId: intention.data.actionId,
          code: resolution.code,
        });
        return;
      }

      this.#recordParticipation(client);
      combat.resource = resolution.remainingResource;
      combat.cooldowns.set(ability.id, resolution.cooldownEndsAtMs);
      combat.lastActionAtMs = this.state.serverTimeMs;
      combat.movementLockedUntilMs = Math.max(
        combat.movementLockedUntilMs,
        resolution.movementLockedUntilMs,
      );
      const feedback: CombatEffectFeedback[] = [];
      let interrupted = false;
      for (const effect of resolution.effects) {
        if (effect.kind === "damage") {
          feedback.push({ kind: "damage", amount: effect.amount });
        } else if (effect.kind === "apply_status") {
          const definition = this.#combatCatalog.statuses.find(
            (candidate) => candidate.id === effect.statusId,
          );
          if (!definition) continue;
          const status =
            effect.target === "self"
              ? applyCombatStatus(
                  combat.statuses,
                  definition,
                  this.state.serverTimeMs,
                )
              : this.#monsterLifecycle.applyStatus(
                  definition,
                  this.state.serverTimeMs,
                );
          feedback.push({
            kind: "status",
            statusId: status.statusId,
            durationMs: status.expiresAtMs - this.state.serverTimeMs,
          });
        } else if (effect.kind === "restore_resource") {
          const previous = combat.resource;
          combat.resource = Math.min(
            classDefinition.serverOnly.maximumResource,
            combat.resource + effect.amount,
          );
          feedback.push({
            kind: "resource",
            amount: combat.resource - previous,
          });
        } else if (effect.kind === "interrupt") {
          if (
            this.#monsterLifecycle.interrupt(this.state.serverTimeMs).type ===
            "interrupted"
          ) {
            interrupted = true;
            feedback.push({ kind: "interrupt" });
          }
        }
      }
      const lifecycleResult = this.#monsterLifecycle.applyDamage(
        resolution.damage,
        this.state.serverTimeMs,
      );
      this.#syncPublicMonster();
      const defeated = lifecycleResult.type === "defeated";
      this.broadcast(SERVER_MESSAGES.combatEvent, {
        kind: defeated ? "defeated" : "hit",
        entityId: target.entityId,
        healthFraction: this.#monsterHealthFraction(),
      });
      if (interrupted) {
        this.broadcast(SERVER_MESSAGES.combatEvent, {
          kind: "interrupted",
          entityId: target.entityId,
        });
      }
      this.#sendCombatResult(client, {
        accepted: true,
        actionId: intention.data.actionId,
        targetEntityId: target.entityId,
        damage: resolution.damage,
        remainingResource: combat.resource,
        cooldownEndsAtMs: resolution.cooldownEndsAtMs,
        defeated,
        abilityId: ability.id,
        slot: ability.slot,
        effects: feedback,
        movementLockedUntilMs: resolution.movementLockedUntilMs,
      });
      this.#sendCombatState(client);
      if (defeated) {
        combat.targetEntityId = null;
        this.#completeMonsterDefeat(target.entityId);
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
      if (consumption.admission.logicalDestination !== "map:village") {
        throw new ServerError(4_224, ERROR_CODES.destinationNotAllowed);
      }
      if (consumption.admission.contentVersion !== "content:village_m1_v2") {
        throw new ServerError(4_225, ERROR_CODES.staleContentVersion);
      }

      const player = new PublicPlayer();
      player.displayName = consumption.admission.displayName;
      const spawn = villageMap.spawns.find(
        (candidate) => candidate.entranceId === "village_square",
      );
      if (!spawn) throw new Error("Village player spawn is unavailable");
      const savedPosition = validSavedPosition(
        consumption.admission.characterState,
      );
      player.x = savedPosition?.x ?? spawn.x;
      player.y = savedPosition?.y ?? spawn.y;
      player.appearance.assign(consumption.admission.appearance);
      this.state.players.set(client.sessionId, player);
      this.#playerIdentity.set(client.sessionId, {
        characterId: consumption.admission.characterId,
        partyId: consumption.admission.partyId,
      });
      const questSnapshot = await this.#questPersistence.loadQuest(
        consumption.admission.characterId,
        this.#questDefinition?.id ?? "quest:forest_mossbacks",
      );
      this.#questSnapshots.set(client.sessionId, questSnapshot);
      this.#characterDialogueState.set(client.sessionId, {
        level: consumption.admission.characterState?.progression.level ?? 1,
        flags: new Set(),
        completedQuestIds: new Set(),
        questStatuses: new Map([[questSnapshot.questId, questSnapshot.status]]),
      });
      this.#joinedAtMs.set(client.sessionId, this.state.serverTimeMs);
      this.#lastActivityAtMs.delete(consumption.admission.characterId);
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
            this.#applyEffectsToPlayer(combat, action.serverOnly.effects);
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
          this.#participationWindow = this.#newParticipationWindow();
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
        (candidate) => candidate.entranceId === "village_square",
      );
      if (!player || !identity || !spawn) return;
      this.#lastCheckpointAtMs.set(sessionId, this.state.serverTimeMs);
      void this.#checkpointLocation({
        characterId: identity.characterId,
        logicalMapId: "map:village",
        entranceId: "village_square",
        position: { x: player.x, y: player.y },
        safeSpawn: { x: spawn.x, y: spawn.y },
        connectionState,
        now: new Date(this.state.serverTimeMs),
      }).catch(() => undefined);
    }

    #applyEffectsToPlayer(
      combat: PlayerCombatState,
      effects: readonly CombatEffect[],
    ): void {
      for (const effect of effects) {
        if (effect.kind !== "apply_status" || effect.target !== "target") {
          continue;
        }
        const definition = this.#combatCatalog.statuses.find(
          (candidate) => candidate.id === effect.statusId,
        );
        if (definition) {
          applyCombatStatus(
            combat.statuses,
            definition,
            this.state.serverTimeMs,
          );
        }
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
      const classDefinition = this.#combatCatalog.classes[0];
      if (!combat || !classDefinition) return;
      const cooldowns: Record<string, number> = {};
      for (const [actionId, endsAtMs] of combat.cooldowns) {
        if (endsAtMs > this.state.serverTimeMs) cooldowns[actionId] = endsAtMs;
      }
      const message: CombatStateMessage = {
        serverTimeMs: this.state.serverTimeMs,
        resource: combat.resource,
        maximumResource: classDefinition.serverOnly.maximumResource,
        cooldowns,
        movementLockedUntilMs: combat.movementLockedUntilMs,
        controlState:
          combat.movementLockedUntilMs > this.state.serverTimeMs
            ? "casting"
            : combatControlState(combat.statuses, this.#combatCatalog.statuses),
        statuses: [...combat.statuses.keys()],
      };
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

    #recordParticipation(client: Client): void {
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!identity) return;
      const now = this.state.serverTimeMs;
      this.#lastActivityAtMs.set(identity.characterId, now);
      this.#participationWindow.recordActivity({
        characterId: identity.characterId,
        partyId: identity.partyId,
        atMs: now,
      });
    }

    #completeMonsterDefeat(monsterEntityId: string): void {
      this.#participationWindow.close(this.state.serverTimeMs);
      this.#defeatSequence += 1;
      const defeatSequence = this.#defeatSequence;
      const monster = this.#monsterLifecycle.state;
      const candidates: ParticipationCandidate[] = [];
      for (const [sessionId, player] of this.state.players) {
        const identity = this.#playerIdentity.get(sessionId);
        if (!identity) continue;
        candidates.push({
          characterId: identity.characterId,
          partyId: identity.partyId,
          x: player.x,
          y: player.y,
          connected: !this.#disconnectedSessions.has(sessionId),
          joinedAtMs:
            this.#joinedAtMs.get(sessionId) ?? Number.MAX_SAFE_INTEGER,
          lastActivityAtMs:
            this.#lastActivityAtMs.get(identity.characterId) ?? 0,
        });
      }
      const eligibleCharacters = this.#participationWindow.eligibleCharacters({
        defeatedAtMs: this.state.serverTimeMs,
        monsterPosition: { x: monster.x, y: monster.y },
        candidates,
      });
      const sourceMonsterId = this.#combatCatalog.monsters[0]?.id;
      if (!sourceMonsterId) return;
      const questEventId = `quest-event:${this.roomId}:${monsterEntityId}:${String(defeatSequence)}`;
      for (const characterId of eligibleCharacters) {
        void this.#applyQuestObjectiveProgress(
          characterId,
          questEventId,
          sourceMonsterId,
        );
      }
      const loot = this.#combatCatalog.loot.find(
        (definition) => definition.monsterId === sourceMonsterId,
      );
      if (!loot) return;
      for (const characterId of eligibleCharacters) {
        const sessionId = [...this.#playerIdentity.entries()].find(
          ([, identity]) => identity.characterId === characterId,
        )?.[0];
        if (!sessionId) continue;
        const itemId = rollPersonalLoot(loot, this.#rewardRng);
        const grant = {
          grantId: rewardGrantId(
            this.roomId,
            monsterEntityId,
            defeatSequence,
            characterId,
          ),
          characterId,
          sourceMonsterId,
          defeatSequence,
          itemId,
          quantity: 1,
        };
        void this.#rewardPersistence
          .grant(grant)
          .then(() => {
            const client = this.clients.find(
              (candidate) => candidate.sessionId === sessionId,
            );
            client?.send(SERVER_MESSAGES.rewardSummary, {
              sourceMonsterId,
              items: [{ itemId, quantity: 1 }],
            });
          })
          .catch(() => undefined);
      }
    }

    #newParticipationWindow(): ParticipationWindow {
      return new ParticipationWindow({
        proximityRadius: REWARD_PROXIMITY_RADIUS,
        afkAfterMs: REWARD_AFK_AFTER_MS,
      });
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
    location.logicalMapId !== "map:village" ||
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
