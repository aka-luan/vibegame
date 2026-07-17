import type {
  EncounterDefinition,
  MonsterActionDefinition,
  MonsterDefinition,
  StatusDefinition,
} from "@gameish/content/combat";
import { moveBody, type MovementWorld } from "@gameish/world";

import type { CombatPosition } from "./resolver.js";
import {
  applyCombatStatus,
  combatControlState,
  expireCombatStatuses,
  type ActiveCombatStatus,
} from "./status.js";

export interface MonsterTarget extends CombatPosition {
  id: string;
}

export type MonsterLifecycleEvent =
  | { type: "aggro"; targetId: string }
  | {
      type: "cast_started";
      targetId: string;
      abilityId: string;
      startTimeMs: number;
      durationMs: number;
      interruptible: boolean;
    }
  | { type: "attack"; targetId: string; abilityId?: string }
  | { type: "interrupted"; abilityId: string }
  | { type: "defeated" }
  | { type: "respawned" };

export interface MonsterLifecycleState extends CombatPosition {
  entityId: string;
  health: number;
  maxHealth: number;
  targetId: string | null;
  state: "idle" | "chasing" | "leashing" | "attacking" | "defeated";
  attackCooldownEndsAtMs: number;
  cast: {
    abilityId: string;
    targetId: string;
    endsAtMs: number;
    interruptible: boolean;
  } | null;
  respawnAtMs: number | null;
}

export class MonsterLifecycle {
  readonly #monster: MonsterDefinition;
  readonly #world: MovementWorld;
  readonly #rng: () => number;
  readonly #spawn: CombatPosition;
  readonly #bossAction: MonsterActionDefinition | undefined;
  readonly #statuses = new Map<string, ActiveCombatStatus>();
  readonly state: MonsterLifecycleState;

  constructor(options: {
    entityId: string;
    monster: MonsterDefinition;
    encounter: EncounterDefinition;
    world: MovementWorld;
    rng: () => number;
    bossAction?: MonsterActionDefinition | undefined;
  }) {
    this.#monster = options.monster;
    this.#world = options.world;
    this.#rng = options.rng;
    this.#spawn = { ...options.encounter.spawn };
    this.#bossAction = options.bossAction;
    this.state = {
      entityId: options.entityId,
      x: options.encounter.spawn.x,
      y: options.encounter.spawn.y,
      health: options.monster.serverOnly.maxHealth,
      maxHealth: options.monster.serverOnly.maxHealth,
      targetId: null,
      state: "idle",
      attackCooldownEndsAtMs: 0,
      cast: null,
      respawnAtMs: null,
    };
  }

  tick(
    nowMs: number,
    targets: readonly MonsterTarget[],
  ): MonsterLifecycleEvent[] {
    expireCombatStatuses(this.#statuses, nowMs);
    if (this.state.state === "defeated") {
      if (this.state.respawnAtMs !== null && nowMs >= this.state.respawnAtMs) {
        this.state.x = this.#spawn.x;
        this.state.y = this.#spawn.y;
        this.state.health = this.state.maxHealth;
        this.state.targetId = null;
        this.state.state = "idle";
        this.state.cast = null;
        this.state.attackCooldownEndsAtMs = 0;
        this.#statuses.clear();
        this.state.respawnAtMs = null;
        return [{ type: "respawned" }];
      }
      return [];
    }

    let wasLeashed = false;
    const currentTarget = targets.find(
      (target) => target.id === this.state.targetId,
    );
    if (
      currentTarget &&
      (this.#distance(this.state, currentTarget) >
        this.#monster.serverOnly.leashRange ||
        this.#distance(this.#spawn, currentTarget) >
          this.#monster.serverOnly.leashRange)
    ) {
      this.state.targetId = null;
      this.state.health = this.state.maxHealth;
      this.state.state = "leashing";
      this.state.cast = null;
      wasLeashed = true;
    } else if (this.state.targetId && !currentTarget) {
      this.state.targetId = null;
      this.state.health = this.state.maxHealth;
      this.state.state = "leashing";
      this.state.cast = null;
      wasLeashed = true;
    }

    if (!this.state.targetId) {
      const candidates = targets.filter(
        (target) =>
          this.#distance(this.state, target) <=
          this.#monster.serverOnly.aggroRange,
      );
      if (candidates.length > 0) {
        const nearestDistance = Math.min(
          ...candidates.map((candidate) =>
            this.#distance(this.state, candidate),
          ),
        );
        const nearest = candidates.filter(
          (candidate) =>
            Math.abs(this.#distance(this.state, candidate) - nearestDistance) <
            0.001,
        );
        const selected =
          nearest[
            Math.min(
              nearest.length - 1,
              Math.floor(this.#rng() * nearest.length),
            )
          ]!;
        this.state.targetId = selected.id;
        this.state.state = "chasing";
        return [{ type: "aggro", targetId: selected.id }];
      }
    }

    const target = targets.find(
      (candidate) => candidate.id === this.state.targetId,
    );
    if (target) {
      if (this.state.cast) {
        if (nowMs < this.state.cast.endsAtMs) {
          this.state.state = "attacking";
          return [];
        }
        const abilityId = this.state.cast.abilityId;
        this.state.cast = null;
        this.state.attackCooldownEndsAtMs =
          nowMs + (this.#bossAction?.serverOnly.cooldownMs ?? 0);
        this.state.state = "attacking";
        return [{ type: "attack", targetId: target.id, abilityId }];
      }
      const distance = this.#distance(this.state, target);
      const bossAction = this.#bossAction;
      if (
        bossAction &&
        distance <= bossAction.serverOnly.range &&
        nowMs >= this.state.attackCooldownEndsAtMs
      ) {
        this.state.cast = {
          abilityId: bossAction.id,
          targetId: target.id,
          endsAtMs: nowMs + bossAction.serverOnly.castTimeMs,
          interruptible: bossAction.serverOnly.interruptible,
        };
        this.state.state = "attacking";
        return [
          {
            type: "cast_started",
            targetId: target.id,
            abilityId: bossAction.id,
            startTimeMs: nowMs,
            durationMs: bossAction.serverOnly.telegraphDurationMs,
            interruptible: bossAction.serverOnly.interruptible,
          },
        ];
      }
      if (distance <= this.#monster.serverOnly.attackRange) {
        if (nowMs >= this.state.attackCooldownEndsAtMs) {
          this.state.state = "attacking";
          this.state.attackCooldownEndsAtMs =
            nowMs + this.#monster.serverOnly.attackCooldownMs;
          return [{ type: "attack", targetId: target.id }];
        }
        this.state.state = "idle";
        return [];
      }
      if (
        combatControlState(this.#statuses, this.#statusDefinitions) !== "rooted"
      ) {
        this.#moveTowards(target);
      }
      this.state.state = "chasing";
      return [];
    }

    if (this.#distance(this.state, this.#spawn) > 0.1) {
      this.#moveTowards(this.#spawn);
      this.state.state = "leashing";
    } else if (wasLeashed) {
      this.state.state = "leashing";
    } else {
      this.state.state = "idle";
    }
    return [];
  }

  #statusDefinitions: readonly StatusDefinition[] = [];

  applyStatus(definition: StatusDefinition, nowMs: number): ActiveCombatStatus {
    this.#statusDefinitions = this.#statusDefinitions.includes(definition)
      ? this.#statusDefinitions
      : [...this.#statusDefinitions, definition];
    return applyCombatStatus(this.#statuses, definition, nowMs);
  }

  applyDamage(
    amount: number,
    nowMs: number,
  ): { type: "hit"; remainingHealth: number } | { type: "defeated" } {
    if (this.state.state === "defeated") {
      return { type: "hit", remainingHealth: 0 };
    }
    const safeAmount = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    this.state.health = Math.max(0, this.state.health - safeAmount);
    if (this.state.health > 0) {
      this.state.state = "chasing";
      return { type: "hit", remainingHealth: this.state.health };
    }
    this.state.state = "defeated";
    this.state.targetId = null;
    this.state.cast = null;
    this.state.respawnAtMs = nowMs + this.#monster.serverOnly.respawnMs;
    return { type: "defeated" };
  }

  interrupt(
    nowMs = 0,
  ): { type: "interrupted"; abilityId: string } | { type: "not_interrupted" } {
    if (!this.state.cast?.interruptible) return { type: "not_interrupted" };
    const abilityId = this.state.cast.abilityId;
    this.state.cast = null;
    this.state.attackCooldownEndsAtMs =
      nowMs + (this.#bossAction?.serverOnly.cooldownMs ?? 0);
    this.state.state = "chasing";
    return { type: "interrupted", abilityId };
  }

  #moveTowards(target: CombatPosition): void {
    const direction = {
      x: target.x - this.state.x,
      y: target.y - this.state.y,
    };
    const moved = moveBody({
      position: this.state,
      direction,
      speed: this.#monster.serverOnly.moveSpeed,
      elapsedMs: 50,
      body: this.#monster.serverOnly.collision,
      world: this.#world,
    });
    this.state.x = moved.x;
    this.state.y = moved.y;
  }

  #distance(first: CombatPosition, second: CombatPosition): number {
    return Math.hypot(first.x - second.x, first.y - second.y);
  }
}
