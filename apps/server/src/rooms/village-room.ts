import { Room, ServerError, type Client } from "@colyseus/core";
import { MapSchema, Schema, type } from "@colyseus/schema";
import villageCombat from "@gameish/content/village-combat-server";
import villageCharacter from "@gameish/content/village-character";
import villageMap from "@gameish/content/village-map-server";
import type { CombatCatalog, CombatEffect } from "@gameish/content/combat";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type CombatResult,
  type CombatStateMessage,
  type CombatEffectFeedback,
  type MovementIntention,
} from "@gameish/protocol";
import { moveCharacterFoot, PLAYER_MOVEMENT } from "@gameish/world";
import { z } from "zod";

import type { DevelopmentPlayTickets } from "../development/play-tickets.js";
import { MonsterLifecycle } from "../combat/monster-lifecycle.js";
import { resolveAbility, resolveBasicAttack } from "../combat/resolver.js";
import {
  applyCombatStatus,
  combatControlState,
  expireCombatStatuses,
  type ActiveCombatStatus,
} from "../combat/status.js";

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

const MAX_MOVEMENT_MESSAGE_BYTES = 256;
const MAX_COMBAT_MESSAGE_BYTES = 256;
const TARGET_SELECTION_RATE_LIMIT_MS = 100;
const MAX_INTENTION_VIOLATIONS = 5;
const MAX_PENDING_INTENTIONS = 120;

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
  playTickets: DevelopmentPlayTickets,
  options: {
    now?: () => number;
    reconnectGraceSeconds?: number;
    combatCatalog?: CombatCatalog;
    rng?: () => number;
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
    readonly #playerCombat = new Map<string, PlayerCombatState>();
    #monsterLifecycle!: MonsterLifecycle;

    override onCreate() {
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
          if (defeated) combat.targetEntityId = null;
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.ability,
        (client, unsafeIntention: unknown) => {
          this.#handleAbility(client, unsafeIntention);
        },
      );

      this.setSimulationInterval(
        () => this.#simulateFixedStep(),
        PLAYER_MOVEMENT.fixedStepMs,
      );
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
      if (defeated) combat.targetEntityId = null;
    }

    override onJoin(client: Client, unsafeOptions: unknown) {
      const options = joinOptionsSchema.safeParse(unsafeOptions);
      if (!options.success) {
        throw new ServerError(4_221, ERROR_CODES.invalidJoinOptions);
      }
      const consumption = playTickets.consume(options.data.ticket);
      if (!consumption.success) {
        throw new ServerError(4_223, consumption.code);
      }

      const player = new PublicPlayer();
      player.displayName = consumption.admission.displayName;
      const spawn = villageMap.spawns.find(
        (candidate) => candidate.entranceId === "village_square",
      );
      if (!spawn) throw new Error("Village player spawn is unavailable");
      player.x = spawn.x;
      player.y = spawn.y;
      player.appearance.assign(consumption.admission.appearance);
      this.state.players.set(client.sessionId, player);
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
      this.#sendCombatState(client);
    }

    override onLeave(client: Client) {
      this.#pendingIntentions.delete(client.sessionId);
      this.#intentionViolations.delete(client.sessionId);
      this.#lastProcessedSequences.delete(client.sessionId);
      this.#playerCombat.delete(client.sessionId);
      this.state.players.delete(client.sessionId);
      options.recordLifecycle?.("removed");
    }

    override onDrop(client: Client) {
      if (!this.state.players.has(client.sessionId)) return;
      options.recordLifecycle?.("disconnected");
      void this.allowReconnection(client, this.#reconnectGraceSeconds).catch(
        () => undefined,
      );
    }

    override onReconnect(client: Client) {
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
