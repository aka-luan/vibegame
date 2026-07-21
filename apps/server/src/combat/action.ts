import type {
  CombatCatalog,
  CombatEffect,
  StatusDefinition,
} from "@gameish/content/combat";
import {
  ERROR_CODES,
  type CombatEffectFeedback,
  type CombatResultAccepted,
  type CombatResultRejected,
  type CombatStateMessage,
  type ErrorCode,
} from "@gameish/protocol";
import { z } from "zod";

import { resolveAbility, resolveBasicAttack } from "./resolver.js";
import {
  applyCombatStatus,
  combatControlState,
  type ActiveCombatStatus,
} from "./status.js";
import type { MonsterLifecycleState } from "./monster-lifecycle.js";

const MAX_COMBAT_MESSAGE_BYTES = 256;
const TARGET_SELECTION_RATE_LIMIT_MS = 100;

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

/**
 * Per-player combat bookkeeping the room owns across the lifetime of a
 * session. Plain data so the combat action module can read and mutate it
 * without any Colyseus dependency.
 */
export interface PlayerCombatState {
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

export interface CombatActionPosition {
  x: number;
  y: number;
}

/**
 * Narrow port the combat action module needs from the monster's lifecycle.
 * `MonsterLifecycle` satisfies this structurally, so it can be passed
 * straight through by the room while remaining Colyseus-free and unit
 * testable via a hand-written fake.
 */
export interface CombatMonsterPort {
  readonly state: Pick<
    MonsterLifecycleState,
    "entityId" | "x" | "y" | "health" | "maxHealth" | "state"
  >;
  applyDamage(
    amount: number,
    nowMs: number,
  ): { type: "hit"; remainingHealth: number } | { type: "defeated" };
  applyStatus(definition: StatusDefinition, nowMs: number): ActiveCombatStatus;
  interrupt(
    nowMs?: number,
  ): { type: "interrupted"; abilityId: string } | { type: "not_interrupted" };
}

export interface CombatActionState {
  readonly nowMs: number;
  readonly catalog: CombatCatalog;
  readonly monster: CombatMonsterPort;
  readonly player: CombatActionPosition | undefined;
  readonly combat: PlayerCombatState | undefined;
}

export type CombatActionRequest =
  | { type: "targetSelection"; raw: unknown }
  | { type: "basicAttack"; raw: unknown }
  | { type: "ability"; raw: unknown };

export type CombatEventBroadcast =
  | { kind: "hit" | "defeated"; entityId: string; healthFraction: number }
  | { kind: "interrupted"; entityId: string };

/**
 * Data-only description of what happened to a combat action. The room turns
 * this into Colyseus sends/broadcasts/schema writes; the module never talks
 * to a client directly.
 */
export type CombatActionOutcome =
  | { type: "ignored" }
  | { type: "rejected"; code: ErrorCode }
  | { type: "result"; result: CombatResultRejected }
  | { type: "targetSelected"; targetEntityId: string }
  | {
      type: "resolved";
      result: CombatResultAccepted;
      broadcasts: readonly CombatEventBroadcast[];
      recordParticipation: boolean;
      monsterDefeated: boolean;
      defeatedEntityId: string;
    };

export function resolveCombatAction(
  state: CombatActionState,
  request: CombatActionRequest,
): CombatActionOutcome {
  switch (request.type) {
    case "targetSelection":
      return resolveTargetSelection(state, request.raw);
    case "basicAttack":
      return resolveBasicAttackAction(state, request.raw);
    case "ability":
      return resolveAbilityAction(state, request.raw);
  }
}

function rejectedResult(
  actionId: string,
  code: ErrorCode,
): CombatResultRejected {
  return { accepted: false, actionId, code };
}

function monsterHealthFraction(monster: CombatMonsterPort): number {
  return monster.state.maxHealth === 0
    ? 0
    : monster.state.health / monster.state.maxHealth;
}

function isOversized(encoded: string | undefined): boolean {
  return (
    encoded === undefined ||
    Buffer.byteLength(encoded) > MAX_COMBAT_MESSAGE_BYTES
  );
}

function resolveTargetSelection(
  state: CombatActionState,
  raw: unknown,
): CombatActionOutcome {
  const encoded = JSON.stringify(raw);
  const parsed = targetSelectionSchema.safeParse(raw);
  const combat = state.combat;
  if (isOversized(encoded) || !parsed.success || !combat) {
    return { type: "rejected", code: ERROR_CODES.invalidTargetSelection };
  }
  const target = state.monster.state;
  if (combat.health <= 0) {
    return { type: "rejected", code: ERROR_CODES.invalidCombatState };
  }
  if (
    parsed.data.targetEntityId !== target.entityId ||
    target.state === "defeated"
  ) {
    return { type: "rejected", code: ERROR_CODES.targetNotFound };
  }
  const aggroRange = state.catalog.monsters[0]?.serverOnly.aggroRange ?? 0;
  if (
    !state.player ||
    Math.hypot(state.player.x - target.x, state.player.y - target.y) >
      aggroRange
  ) {
    return { type: "rejected", code: ERROR_CODES.targetOutOfRange };
  }
  if (
    combat.lastTargetSelectionAtMs !== undefined &&
    state.nowMs <
      combat.lastTargetSelectionAtMs + TARGET_SELECTION_RATE_LIMIT_MS
  ) {
    return { type: "rejected", code: ERROR_CODES.actionRateLimited };
  }
  combat.lastTargetSelectionAtMs = state.nowMs;
  combat.targetEntityId = target.entityId;
  return { type: "targetSelected", targetEntityId: target.entityId };
}

function resolveBasicAttackAction(
  state: CombatActionState,
  raw: unknown,
): CombatActionOutcome {
  const encoded = JSON.stringify(raw);
  const parsed = basicAttackSchema.safeParse(raw);
  const combat = state.combat;
  if (isOversized(encoded) || !parsed.success || !combat) {
    return {
      type: "result",
      result: rejectedResult(
        parsed.success ? parsed.data.actionId : "invalid",
        ERROR_CODES.invalidCombatIntention,
      ),
    };
  }

  const target = state.monster.state;
  if (combat.targetEntityId === null) {
    return {
      type: "result",
      result: rejectedResult(
        parsed.data.actionId,
        ERROR_CODES.targetNotSelected,
      ),
    };
  }
  if (
    parsed.data.targetEntityId !== combat.targetEntityId ||
    parsed.data.targetEntityId !== target.entityId
  ) {
    return {
      type: "result",
      result: rejectedResult(parsed.data.actionId, ERROR_CODES.targetNotFound),
    };
  }

  const classDefinition = state.catalog.classes[0];
  const attackId = classDefinition?.serverOnly.basicAttackId;
  const attack = state.catalog.attacks.find(
    (candidate) => candidate.id === attackId,
  );
  if (!classDefinition || !attack) {
    return {
      type: "result",
      result: rejectedResult(
        parsed.data.actionId,
        ERROR_CODES.invalidCombatState,
      ),
    };
  }
  if (!state.player) return { type: "ignored" };

  const resolution = resolveBasicAttack({
    nowMs: state.nowMs,
    lastActionAtMs: combat.lastActionAtMs,
    cooldownEndsAtMs: combat.cooldownEndsAtMs,
    attacker: {
      x: state.player.x,
      y: state.player.y,
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
    return {
      type: "result",
      result: rejectedResult(parsed.data.actionId, resolution.code),
    };
  }

  combat.resource = resolution.remainingResource;
  combat.cooldownEndsAtMs = resolution.cooldownEndsAtMs;
  combat.cooldowns.set(attack.id, resolution.cooldownEndsAtMs);
  combat.lastActionAtMs = state.nowMs;

  const lifecycleResult = state.monster.applyDamage(
    resolution.damage,
    state.nowMs,
  );
  const defeated = lifecycleResult.type === "defeated";
  const broadcasts: CombatEventBroadcast[] = [
    {
      kind: defeated ? "defeated" : "hit",
      entityId: target.entityId,
      healthFraction: monsterHealthFraction(state.monster),
    },
  ];
  if (defeated) combat.targetEntityId = null;

  return {
    type: "resolved",
    result: {
      accepted: true,
      actionId: parsed.data.actionId,
      targetEntityId: target.entityId,
      damage: resolution.damage,
      remainingResource: combat.resource,
      cooldownEndsAtMs: combat.cooldownEndsAtMs,
      defeated,
    },
    broadcasts,
    recordParticipation: true,
    monsterDefeated: defeated,
    defeatedEntityId: target.entityId,
  };
}

function resolveAbilityAction(
  state: CombatActionState,
  raw: unknown,
): CombatActionOutcome {
  const encoded = JSON.stringify(raw);
  const parsed = abilitySchema.safeParse(raw);
  const combat = state.combat;
  if (isOversized(encoded) || !parsed.success || !combat) {
    return {
      type: "result",
      result: rejectedResult(
        parsed.success ? parsed.data.actionId : "invalid",
        ERROR_CODES.invalidCombatIntention,
      ),
    };
  }

  if (combat.recentActionIds.includes(parsed.data.actionId)) {
    return {
      type: "result",
      result: rejectedResult(parsed.data.actionId, ERROR_CODES.staleAction),
    };
  }
  combat.recentActionIds.push(parsed.data.actionId);
  if (combat.recentActionIds.length > 64) combat.recentActionIds.shift();

  const classDefinition = state.catalog.classes[0];
  const ability = state.catalog.abilities.find(
    (candidate) =>
      candidate.id === parsed.data.abilityId &&
      classDefinition?.serverOnly.abilityIds.includes(candidate.id),
  );
  if (!classDefinition || !ability) {
    return {
      type: "result",
      result: rejectedResult(parsed.data.actionId, ERROR_CODES.abilityNotFound),
    };
  }
  if (combat.targetEntityId === null) {
    return {
      type: "result",
      result: rejectedResult(
        parsed.data.actionId,
        ERROR_CODES.targetNotSelected,
      ),
    };
  }
  const target = state.monster.state;
  if (
    parsed.data.targetEntityId !== combat.targetEntityId ||
    parsed.data.targetEntityId !== target.entityId
  ) {
    return {
      type: "result",
      result: rejectedResult(parsed.data.actionId, ERROR_CODES.targetNotFound),
    };
  }
  if (!state.player) return { type: "ignored" };

  const cooldownEndsAtMs = combat.cooldowns.get(ability.id) ?? 0;
  const resolution = resolveAbility({
    nowMs: state.nowMs,
    lastActionAtMs: combat.lastActionAtMs,
    cooldownEndsAtMs,
    attacker: {
      x: state.player.x,
      y: state.player.y,
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
    return {
      type: "result",
      result: rejectedResult(parsed.data.actionId, resolution.code),
    };
  }

  combat.resource = resolution.remainingResource;
  combat.cooldowns.set(ability.id, resolution.cooldownEndsAtMs);
  combat.lastActionAtMs = state.nowMs;
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
      const definition = state.catalog.statuses.find(
        (candidate) => candidate.id === effect.statusId,
      );
      if (!definition) continue;
      const status =
        effect.target === "self"
          ? applyCombatStatus(combat.statuses, definition, state.nowMs)
          : state.monster.applyStatus(definition, state.nowMs);
      feedback.push({
        kind: "status",
        statusId: status.statusId,
        durationMs: status.expiresAtMs - state.nowMs,
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
      if (state.monster.interrupt(state.nowMs).type === "interrupted") {
        interrupted = true;
        feedback.push({ kind: "interrupt" });
      }
    }
  }

  const lifecycleResult = state.monster.applyDamage(
    resolution.damage,
    state.nowMs,
  );
  const defeated = lifecycleResult.type === "defeated";
  const broadcasts: CombatEventBroadcast[] = [
    {
      kind: defeated ? "defeated" : "hit",
      entityId: target.entityId,
      healthFraction: monsterHealthFraction(state.monster),
    },
  ];
  if (interrupted) {
    broadcasts.push({ kind: "interrupted", entityId: target.entityId });
  }
  if (defeated) combat.targetEntityId = null;

  return {
    type: "resolved",
    result: {
      accepted: true,
      actionId: parsed.data.actionId,
      targetEntityId: target.entityId,
      damage: resolution.damage,
      remainingResource: combat.resource,
      cooldownEndsAtMs: resolution.cooldownEndsAtMs,
      defeated,
      abilityId: ability.id,
      slot: ability.slot,
      effects: feedback,
      movementLockedUntilMs: resolution.movementLockedUntilMs,
    },
    broadcasts,
    recordParticipation: true,
    monsterDefeated: defeated,
    defeatedEntityId: target.entityId,
  };
}

/**
 * Applies a monster action's target-facing effects (currently: statuses) to
 * a player's combat state. Used when the monster lands an attack outside of
 * a player-initiated combat action.
 */
export function applyMonsterEffectsToPlayer(
  combat: PlayerCombatState,
  effects: readonly CombatEffect[],
  catalog: CombatCatalog,
  nowMs: number,
): void {
  for (const effect of effects) {
    if (effect.kind !== "apply_status" || effect.target !== "target") {
      continue;
    }
    const definition = catalog.statuses.find(
      (candidate) => candidate.id === effect.statusId,
    );
    if (definition) {
      applyCombatStatus(combat.statuses, definition, nowMs);
    }
  }
}

/**
 * Builds the outbound combat-state snapshot for a player from plain combat
 * state. The room only sends the result.
 */
export function buildCombatStateMessage(
  combat: PlayerCombatState,
  catalog: CombatCatalog,
  nowMs: number,
): CombatStateMessage | undefined {
  const classDefinition = catalog.classes[0];
  if (!classDefinition) return undefined;
  const cooldowns: Record<string, number> = {};
  for (const [actionId, endsAtMs] of combat.cooldowns) {
    if (endsAtMs > nowMs) cooldowns[actionId] = endsAtMs;
  }
  return {
    serverTimeMs: nowMs,
    resource: combat.resource,
    maximumResource: classDefinition.serverOnly.maximumResource,
    cooldowns,
    movementLockedUntilMs: combat.movementLockedUntilMs,
    controlState:
      combat.movementLockedUntilMs > nowMs
        ? "casting"
        : combatControlState(combat.statuses, catalog.statuses),
    statuses: [...combat.statuses.keys()],
  };
}
