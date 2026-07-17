import type {
  AbilityDefinition,
  BasicAttackDefinition,
  CombatEffect,
} from "@gameish/content/combat";
import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";

export interface CombatPosition {
  x: number;
  y: number;
}

export interface BasicAttackResolutionRequest {
  nowMs: number;
  lastActionAtMs: number | undefined;
  cooldownEndsAtMs: number;
  attacker: CombatPosition & {
    resource: number;
    defeated: boolean;
  };
  target: CombatPosition & {
    health: number;
    maxHealth: number;
    defeated: boolean;
  };
  attack: BasicAttackDefinition;
}

export interface AbilityResolutionRequest {
  nowMs: number;
  lastActionAtMs: number | undefined;
  cooldownEndsAtMs: number;
  attacker: CombatPosition & {
    resource: number;
    defeated: boolean;
  };
  target: CombatPosition & {
    health: number;
    maxHealth: number;
    defeated: boolean;
  };
  ability: AbilityDefinition;
}

export type AbilityResolution =
  | { accepted: false; code: ErrorCode }
  | {
      accepted: true;
      damage: number;
      remainingHealth: number;
      remainingResource: number;
      cooldownEndsAtMs: number;
      movementLockedUntilMs: number;
      castEndsAtMs: number;
      effects: readonly CombatEffect[];
      defeated: boolean;
    };

export type BasicAttackResolution =
  | { accepted: false; code: ErrorCode }
  | {
      accepted: true;
      damage: number;
      remainingHealth: number;
      remainingResource: number;
      cooldownEndsAtMs: number;
      defeated: boolean;
    };

export function resolveBasicAttack(
  request: BasicAttackResolutionRequest,
): BasicAttackResolution {
  const rules = request.attack.serverOnly;
  if (request.attacker.defeated) {
    return { accepted: false, code: ERROR_CODES.invalidCombatState };
  }
  if (request.target.defeated) {
    return { accepted: false, code: ERROR_CODES.targetDefeated };
  }
  if (
    Math.hypot(
      request.attacker.x - request.target.x,
      request.attacker.y - request.target.y,
    ) > rules.range
  ) {
    return { accepted: false, code: ERROR_CODES.targetOutOfRange };
  }
  if (
    request.lastActionAtMs !== undefined &&
    request.nowMs < request.lastActionAtMs + rules.actionRateLimitMs
  ) {
    return { accepted: false, code: ERROR_CODES.actionRateLimited };
  }
  if (request.nowMs < request.cooldownEndsAtMs) {
    return { accepted: false, code: ERROR_CODES.actionOnCooldown };
  }
  if (request.attacker.resource < rules.resourceCost) {
    return { accepted: false, code: ERROR_CODES.insufficientResource };
  }

  const damage = rules.damage;
  const remainingHealth = Math.max(0, request.target.health - damage);
  return {
    accepted: true,
    damage,
    remainingHealth,
    remainingResource: request.attacker.resource - rules.resourceCost,
    cooldownEndsAtMs: request.nowMs + rules.cooldownMs,
    defeated: remainingHealth === 0,
  };
}

export function resolveAbility(
  request: AbilityResolutionRequest,
): AbilityResolution {
  const rules = request.ability.serverOnly;
  if (request.attacker.defeated) {
    return { accepted: false, code: ERROR_CODES.invalidCombatState };
  }
  if (request.target.defeated) {
    return { accepted: false, code: ERROR_CODES.targetDefeated };
  }
  if (
    Math.hypot(
      request.attacker.x - request.target.x,
      request.attacker.y - request.target.y,
    ) > rules.range
  ) {
    return { accepted: false, code: ERROR_CODES.targetOutOfRange };
  }
  if (
    request.lastActionAtMs !== undefined &&
    request.nowMs < request.lastActionAtMs + rules.actionRateLimitMs
  ) {
    return { accepted: false, code: ERROR_CODES.actionRateLimited };
  }
  if (request.nowMs < request.cooldownEndsAtMs) {
    return { accepted: false, code: ERROR_CODES.actionOnCooldown };
  }
  if (request.attacker.resource < rules.resourceCost) {
    return { accepted: false, code: ERROR_CODES.insufficientResource };
  }

  const damage = rules.effects
    .filter((effect) => effect.kind === "damage")
    .reduce((total, effect) => total + effect.amount, 0);
  const remainingHealth = Math.max(0, request.target.health - damage);
  const movementLockedUntilMs =
    rules.movementLock === "none"
      ? request.nowMs
      : request.nowMs +
        (rules.movementLock === "cast"
          ? rules.castTimeMs
          : rules.castTimeMs + rules.recoveryMs);
  return {
    accepted: true,
    damage,
    remainingHealth,
    remainingResource: request.attacker.resource - rules.resourceCost,
    cooldownEndsAtMs: request.nowMs + rules.cooldownMs,
    movementLockedUntilMs,
    castEndsAtMs: request.nowMs + rules.castTimeMs,
    effects: rules.effects,
    defeated: remainingHealth === 0,
  };
}
