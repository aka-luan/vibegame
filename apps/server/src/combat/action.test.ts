import { describe, expect, it } from "vitest";

import foundationContent from "../../../../packages/content/content/foundation.json" with { type: "json" };
import {
  combatCatalogSchema,
  type StatusDefinition,
} from "@gameish/content/combat";

import {
  resolveCombatAction,
  type CombatActionOutcome,
  type CombatActionState,
  type CombatMonsterPort,
  type PlayerCombatState,
} from "./action.js";
import { ParticipationWindow } from "../rewards/participation.js";

const catalog = combatCatalogSchema.parse(foundationContent.combat);
const attack = catalog.attacks[0]!;
const abilities = catalog.abilities;
const damageAbility = abilities.find((a) => a.slot === "ability_1")!; // ability:thorn_arc, damage only
const rootAbility = abilities.find((a) => a.slot === "ability_2")!; // ability:binding_briar, damage + status(target)
const resourceAbility = abilities.find((a) => a.slot === "ability_3")!; // ability:warding_breath, restore_resource(self)
const interruptAbility = abilities.find((a) => a.slot === "ability_4")!; // ability:disrupting_roar, damage + interrupt

const MONSTER_ENTITY_ID = "monster:test_mossback:1";

function createFakeMonster(
  overrides: {
    x?: number;
    y?: number;
    health?: number;
    maxHealth?: number;
    state?: CombatMonsterPort["state"]["state"];
    interruptible?: boolean;
  } = {},
): CombatMonsterPort & { interruptCalls: number } {
  const state = {
    entityId: MONSTER_ENTITY_ID,
    x: overrides.x ?? 150,
    y: overrides.y ?? 100,
    health: overrides.health ?? 50,
    maxHealth: overrides.maxHealth ?? 50,
    state: overrides.state ?? "chasing",
  };
  let interruptible = overrides.interruptible ?? false;
  return {
    state,
    interruptCalls: 0,
    applyDamage(amount: number) {
      state.health = Math.max(0, state.health - amount);
      if (state.health <= 0) {
        state.state = "defeated";
        return { type: "defeated" as const };
      }
      return { type: "hit" as const, remainingHealth: state.health };
    },
    applyStatus(definition: StatusDefinition, nowMs: number) {
      return {
        statusId: definition.id,
        expiresAtMs: nowMs + definition.serverOnly.durationMs,
      };
    },
    interrupt() {
      this.interruptCalls += 1;
      if (!interruptible) return { type: "not_interrupted" as const };
      interruptible = false;
      return { type: "interrupted" as const, abilityId: "monster_action:test" };
    },
  };
}

function baseCombat(
  overrides: Partial<PlayerCombatState> = {},
): PlayerCombatState {
  return {
    targetEntityId: null,
    resource: 100,
    health: 100,
    cooldownEndsAtMs: 0,
    lastActionAtMs: undefined,
    lastTargetSelectionAtMs: undefined,
    cooldowns: new Map(),
    movementLockedUntilMs: 0,
    statuses: new Map(),
    recentActionIds: [],
    ...overrides,
  };
}

function baseState(
  overrides: Partial<CombatActionState> & { monster?: CombatMonsterPort } = {},
): CombatActionState {
  return {
    nowMs: 10_000,
    catalog,
    monster: overrides.monster ?? createFakeMonster(),
    player: overrides.player ?? { x: 100, y: 100 },
    combat: overrides.combat ?? baseCombat(),
    ...overrides,
  };
}

describe("target selection", () => {
  it("rejects a malformed message as invalidTargetSelection", () => {
    const outcome = resolveCombatAction(baseState(), {
      type: "targetSelection",
      raw: { targetEntityId: "" },
    });
    expect(outcome).toEqual({
      type: "rejected",
      code: "INVALID_TARGET_SELECTION",
    });
  });

  it("rejects when there is no tracked combat state as invalidTargetSelection", () => {
    const outcome = resolveCombatAction(baseState({ combat: undefined }), {
      type: "targetSelection",
      raw: { targetEntityId: MONSTER_ENTITY_ID },
    });
    expect(outcome).toEqual({
      type: "rejected",
      code: "INVALID_TARGET_SELECTION",
    });
  });

  it("rejects a defeated player as invalidCombatState", () => {
    const outcome = resolveCombatAction(
      baseState({ combat: baseCombat({ health: 0 }) }),
      { type: "targetSelection", raw: { targetEntityId: MONSTER_ENTITY_ID } },
    );
    expect(outcome).toEqual({ type: "rejected", code: "INVALID_COMBAT_STATE" });
  });

  it("rejects an unknown or defeated target entity as targetNotFound", () => {
    const wrongEntity = resolveCombatAction(baseState(), {
      type: "targetSelection",
      raw: { targetEntityId: "monster:not_this_one:1" },
    });
    expect(wrongEntity).toEqual({ type: "rejected", code: "TARGET_NOT_FOUND" });

    const defeatedTarget = resolveCombatAction(
      baseState({ monster: createFakeMonster({ state: "defeated" }) }),
      { type: "targetSelection", raw: { targetEntityId: MONSTER_ENTITY_ID } },
    );
    expect(defeatedTarget).toEqual({
      type: "rejected",
      code: "TARGET_NOT_FOUND",
    });
  });

  it("rejects a target beyond the monster's aggro range as targetOutOfRange", () => {
    const aggroRange = catalog.monsters[0]!.serverOnly.aggroRange;
    const atBoundary = resolveCombatAction(
      baseState({
        player: { x: 150 - aggroRange, y: 100 },
        monster: createFakeMonster({ x: 150, y: 100 }),
      }),
      { type: "targetSelection", raw: { targetEntityId: MONSTER_ENTITY_ID } },
    );
    expect(atBoundary.type).toBe("targetSelected");

    const overBoundary = resolveCombatAction(
      baseState({
        player: { x: 150 - aggroRange - 1, y: 100 },
        monster: createFakeMonster({ x: 150, y: 100 }),
      }),
      { type: "targetSelection", raw: { targetEntityId: MONSTER_ENTITY_ID } },
    );
    expect(overBoundary).toEqual({
      type: "rejected",
      code: "TARGET_OUT_OF_RANGE",
    });
  });

  it("rejects a reselection inside the rate-limit window as actionRateLimited", () => {
    const combat = baseCombat({ lastTargetSelectionAtMs: 9_950 });
    const outcome = resolveCombatAction(baseState({ combat, nowMs: 10_000 }), {
      type: "targetSelection",
      raw: { targetEntityId: MONSTER_ENTITY_ID },
    });
    expect(outcome).toEqual({ type: "rejected", code: "ACTION_RATE_LIMITED" });
  });

  it("accepts a valid selection and records it on the combat state", () => {
    const combat = baseCombat();
    const outcome = resolveCombatAction(baseState({ combat }), {
      type: "targetSelection",
      raw: { targetEntityId: MONSTER_ENTITY_ID },
    });
    expect(outcome).toEqual({
      type: "targetSelected",
      targetEntityId: MONSTER_ENTITY_ID,
    });
    expect(combat.targetEntityId).toBe(MONSTER_ENTITY_ID);
    expect(combat.lastTargetSelectionAtMs).toBe(10_000);
  });
});

describe("basic attack", () => {
  it("rejects a malformed message as invalidCombatIntention", () => {
    const outcome = resolveCombatAction(baseState(), {
      type: "basicAttack",
      raw: { actionId: "a1" },
    });
    expect(outcome).toEqual({
      type: "result",
      result: {
        accepted: false,
        actionId: "invalid",
        code: "INVALID_COMBAT_INTENTION",
      },
    });
  });

  it("rejects when no target is selected as targetNotSelected", () => {
    const outcome = resolveCombatAction(baseState(), {
      type: "basicAttack",
      raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
    });
    expect(outcome).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "TARGET_NOT_SELECTED" },
    });
  });

  it("rejects a target mismatch as targetNotFound", () => {
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const outcome = resolveCombatAction(baseState({ combat }), {
      type: "basicAttack",
      raw: { actionId: "a1", targetEntityId: "monster:someone_else:1" },
    });
    expect(outcome).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "TARGET_NOT_FOUND" },
    });
  });

  it("returns ignored when the player is not present in room state", () => {
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const outcome = resolveCombatAction(
      baseState({ combat, player: undefined }),
      {
        type: "basicAttack",
        raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
      },
    );
    expect(outcome).toEqual({ type: "ignored" });
  });

  it("rejects a defeated attacker as invalidCombatState (resolver-owned)", () => {
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID, health: 0 });
    const outcome = resolveCombatAction(baseState({ combat }), {
      type: "basicAttack",
      raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
    });
    expect(outcome).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "INVALID_COMBAT_STATE" },
    });
  });

  it("rejects an already-defeated target as targetDefeated", () => {
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const outcome = resolveCombatAction(
      baseState({ combat, monster: createFakeMonster({ state: "defeated" }) }),
      {
        type: "basicAttack",
        raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
      },
    );
    expect(outcome).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "TARGET_DEFEATED" },
    });
  });

  it("enforces the attack's range boundary", () => {
    const range = attack.serverOnly.range;
    const combat = () => baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const atBoundary = resolveCombatAction(
      baseState({ combat: combat(), player: { x: 150 - range, y: 100 } }),
      {
        type: "basicAttack",
        raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
      },
    );
    expect(atBoundary.type).toBe("resolved");

    const overBoundary = resolveCombatAction(
      baseState({ combat: combat(), player: { x: 150 - range - 1, y: 100 } }),
      {
        type: "basicAttack",
        raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
      },
    );
    expect(overBoundary).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "TARGET_OUT_OF_RANGE" },
    });
  });

  it("enforces the action rate limit boundary", () => {
    const combat = baseCombat({
      targetEntityId: MONSTER_ENTITY_ID,
      lastActionAtMs: 10_000 - attack.serverOnly.actionRateLimitMs,
    });
    const atBoundary = resolveCombatAction(baseState({ combat }), {
      type: "basicAttack",
      raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
    });
    expect(atBoundary.type).toBe("resolved");

    const tooSoon = baseCombat({
      targetEntityId: MONSTER_ENTITY_ID,
      lastActionAtMs: 10_000 - attack.serverOnly.actionRateLimitMs + 1,
    });
    const rateLimited = resolveCombatAction(baseState({ combat: tooSoon }), {
      type: "basicAttack",
      raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
    });
    expect(rateLimited).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "ACTION_RATE_LIMITED" },
    });
  });

  it("enforces the cooldown boundary", () => {
    const onCooldown = resolveCombatAction(
      baseState({
        combat: baseCombat({
          targetEntityId: MONSTER_ENTITY_ID,
          cooldownEndsAtMs: 10_001,
        }),
      }),
      {
        type: "basicAttack",
        raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
      },
    );
    expect(onCooldown).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "ABILITY_ON_COOLDOWN" },
    });

    const cooldownElapsed = resolveCombatAction(
      baseState({
        combat: baseCombat({
          targetEntityId: MONSTER_ENTITY_ID,
          cooldownEndsAtMs: 10_000,
        }),
      }),
      {
        type: "basicAttack",
        raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
      },
    );
    expect(cooldownElapsed.type).toBe("resolved");
  });

  it("enforces the resource cost boundary", () => {
    const cost = attack.serverOnly.resourceCost;
    const exact = resolveCombatAction(
      baseState({
        combat: baseCombat({
          targetEntityId: MONSTER_ENTITY_ID,
          resource: cost,
        }),
      }),
      {
        type: "basicAttack",
        raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
      },
    );
    expect(exact.type).toBe("resolved");

    const insufficient = resolveCombatAction(
      baseState({
        combat: baseCombat({
          targetEntityId: MONSTER_ENTITY_ID,
          resource: cost - 1,
        }),
      }),
      {
        type: "basicAttack",
        raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
      },
    );
    expect(insufficient).toEqual({
      type: "result",
      result: {
        accepted: false,
        actionId: "a1",
        code: "INSUFFICIENT_RESOURCE",
      },
    });
  });

  it("resolves damage, mutates combat state, and signals a monster defeat", () => {
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const monster = createFakeMonster({ health: attack.serverOnly.damage });
    const outcome = resolveCombatAction(baseState({ combat, monster }), {
      type: "basicAttack",
      raw: { actionId: "a1", targetEntityId: MONSTER_ENTITY_ID },
    }) as CombatActionOutcome & { type: "resolved" };

    expect(outcome.type).toBe("resolved");
    expect(outcome.result).toMatchObject({
      accepted: true,
      damage: attack.serverOnly.damage,
      defeated: true,
    });
    expect(outcome.monsterDefeated).toBe(true);
    expect(outcome.defeatedEntityId).toBe(MONSTER_ENTITY_ID);
    expect(outcome.broadcasts).toEqual([
      { kind: "defeated", entityId: MONSTER_ENTITY_ID, healthFraction: 0 },
    ]);
    expect(outcome.recordParticipation).toBe(true);
    // Lifecycle transition: target cleared on defeat.
    expect(combat.targetEntityId).toBeNull();
    expect(combat.resource).toBe(100 - attack.serverOnly.resourceCost);
  });
});

describe("ability", () => {
  it("rejects a malformed message as invalidCombatIntention", () => {
    const outcome = resolveCombatAction(baseState(), {
      type: "ability",
      raw: { actionId: "a1" },
    });
    expect(outcome).toEqual({
      type: "result",
      result: {
        accepted: false,
        actionId: "invalid",
        code: "INVALID_COMBAT_INTENTION",
      },
    });
  });

  it("rejects a replayed actionId as staleAction", () => {
    const combat = baseCombat({ recentActionIds: ["a1"] });
    const outcome = resolveCombatAction(baseState({ combat }), {
      type: "ability",
      raw: {
        actionId: "a1",
        abilityId: damageAbility.id,
        targetEntityId: MONSTER_ENTITY_ID,
      },
    });
    expect(outcome).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "STALE_ACTION" },
    });
  });

  it("rejects an unknown abilityId as abilityNotFound", () => {
    const outcome = resolveCombatAction(baseState(), {
      type: "ability",
      raw: {
        actionId: "a1",
        abilityId: "ability:does_not_exist",
        targetEntityId: MONSTER_ENTITY_ID,
      },
    });
    expect(outcome).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "ABILITY_NOT_FOUND" },
    });
  });

  it("rejects when no target is selected as targetNotSelected", () => {
    const outcome = resolveCombatAction(baseState(), {
      type: "ability",
      raw: {
        actionId: "a1",
        abilityId: damageAbility.id,
        targetEntityId: MONSTER_ENTITY_ID,
      },
    });
    expect(outcome).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "TARGET_NOT_SELECTED" },
    });
  });

  it("rejects a target mismatch as targetNotFound", () => {
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const outcome = resolveCombatAction(baseState({ combat }), {
      type: "ability",
      raw: {
        actionId: "a1",
        abilityId: damageAbility.id,
        targetEntityId: "monster:someone_else:1",
      },
    });
    expect(outcome).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "TARGET_NOT_FOUND" },
    });
  });

  it("returns ignored when the player is not present in room state", () => {
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const outcome = resolveCombatAction(
      baseState({ combat, player: undefined }),
      {
        type: "ability",
        raw: {
          actionId: "a1",
          abilityId: damageAbility.id,
          targetEntityId: MONSTER_ENTITY_ID,
        },
      },
    );
    expect(outcome).toEqual({ type: "ignored" });
  });

  it("enforces the ability's cooldown boundary", () => {
    const cooldowns = new Map([[damageAbility.id, 10_001]]);
    const onCooldown = resolveCombatAction(
      baseState({
        combat: baseCombat({ targetEntityId: MONSTER_ENTITY_ID, cooldowns }),
      }),
      {
        type: "ability",
        raw: {
          actionId: "a1",
          abilityId: damageAbility.id,
          targetEntityId: MONSTER_ENTITY_ID,
        },
      },
    );
    expect(onCooldown).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a1", code: "ABILITY_ON_COOLDOWN" },
    });
  });

  it("enforces the ability's resource cost boundary", () => {
    const cost = damageAbility.serverOnly.resourceCost;
    const exact = resolveCombatAction(
      baseState({
        combat: baseCombat({
          targetEntityId: MONSTER_ENTITY_ID,
          resource: cost,
        }),
      }),
      {
        type: "ability",
        raw: {
          actionId: "a1",
          abilityId: damageAbility.id,
          targetEntityId: MONSTER_ENTITY_ID,
        },
      },
    );
    expect(exact.type).toBe("resolved");

    const insufficient = resolveCombatAction(
      baseState({
        combat: baseCombat({
          targetEntityId: MONSTER_ENTITY_ID,
          resource: cost - 1,
        }),
      }),
      {
        type: "ability",
        raw: {
          actionId: "a1",
          abilityId: damageAbility.id,
          targetEntityId: MONSTER_ENTITY_ID,
        },
      },
    );
    expect(insufficient).toEqual({
      type: "result",
      result: {
        accepted: false,
        actionId: "a1",
        code: "INSUFFICIENT_RESOURCE",
      },
    });
  });

  it("enforces the ability's range boundary", () => {
    const range = damageAbility.serverOnly.range;
    const combat = () => baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const atBoundary = resolveCombatAction(
      baseState({ combat: combat(), player: { x: 150 - range, y: 100 } }),
      {
        type: "ability",
        raw: {
          actionId: "a1",
          abilityId: damageAbility.id,
          targetEntityId: MONSTER_ENTITY_ID,
        },
      },
    );
    expect(atBoundary.type).toBe("resolved");

    const overBoundary = resolveCombatAction(
      baseState({ combat: combat(), player: { x: 150 - range - 1, y: 100 } }),
      {
        type: "ability",
        raw: {
          actionId: "a2",
          abilityId: damageAbility.id,
          targetEntityId: MONSTER_ENTITY_ID,
        },
      },
    );
    expect(overBoundary).toEqual({
      type: "result",
      result: { accepted: false, actionId: "a2", code: "TARGET_OUT_OF_RANGE" },
    });
  });

  it("applies a self-targeted resource-restore effect and reports feedback", () => {
    const combat = baseCombat({
      targetEntityId: MONSTER_ENTITY_ID,
      resource: 50,
    });
    const outcome = resolveCombatAction(baseState({ combat }), {
      type: "ability",
      raw: {
        actionId: "a1",
        abilityId: resourceAbility.id,
        targetEntityId: MONSTER_ENTITY_ID,
      },
    }) as CombatActionOutcome & { type: "resolved" };

    expect(outcome.type).toBe("resolved");
    expect(combat.resource).toBe(80); // 50 + 30 restore
    expect(outcome.result.effects).toEqual([{ kind: "resource", amount: 30 }]);
  });

  it("applies a target-facing status effect via the monster port", () => {
    const monster = createFakeMonster();
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const outcome = resolveCombatAction(baseState({ combat, monster }), {
      type: "ability",
      raw: {
        actionId: "a1",
        abilityId: rootAbility.id,
        targetEntityId: MONSTER_ENTITY_ID,
      },
    }) as CombatActionOutcome & { type: "resolved" };

    expect(outcome.type).toBe("resolved");
    const statusFeedback = outcome.result.effects?.find(
      (e) => e.kind === "status",
    );
    expect(statusFeedback).toMatchObject({
      kind: "status",
      statusId: "status:rooted",
    });
  });

  it("broadcasts an interrupted event when the monster's cast is interruptible", () => {
    const monster = createFakeMonster({ interruptible: true });
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const outcome = resolveCombatAction(baseState({ combat, monster }), {
      type: "ability",
      raw: {
        actionId: "a1",
        abilityId: interruptAbility.id,
        targetEntityId: MONSTER_ENTITY_ID,
      },
    }) as CombatActionOutcome & { type: "resolved" };

    expect(outcome.type).toBe("resolved");
    expect(outcome.broadcasts).toContainEqual({
      kind: "interrupted",
      entityId: MONSTER_ENTITY_ID,
    });
  });

  it("signals a monster defeat and clears the player's target", () => {
    const combat = baseCombat({ targetEntityId: MONSTER_ENTITY_ID });
    const monster = createFakeMonster({
      health:
        damageAbility.serverOnly.effects[0]!.kind === "damage"
          ? (damageAbility.serverOnly.effects[0] as { amount: number }).amount
          : 1,
    });
    const outcome = resolveCombatAction(baseState({ combat, monster }), {
      type: "ability",
      raw: {
        actionId: "a1",
        abilityId: damageAbility.id,
        targetEntityId: MONSTER_ENTITY_ID,
      },
    }) as CombatActionOutcome & { type: "resolved" };

    expect(outcome.type).toBe("resolved");
    expect(outcome.monsterDefeated).toBe(true);
    expect(outcome.defeatedEntityId).toBe(MONSTER_ENTITY_ID);
    expect(combat.targetEntityId).toBeNull();
  });
});

describe("AFK / lastActivityAtMs semantics (AC3)", () => {
  it("does not treat a freshly joined, non-attacking party member as AFK when lastActivityAtMs is initialized to join time", () => {
    const window = new ParticipationWindow({
      proximityRadius: 200,
      afkAfterMs: 2_500,
    });
    window.recordActivity({
      characterId: "character:attacker",
      partyId: "party:1",
      atMs: 0,
    });

    const joinedAtMs = 4_900;
    const defeatedAtMs = 5_000;
    window.close(defeatedAtMs);

    const eligible = window.eligibleCharacters({
      defeatedAtMs,
      monsterPosition: { x: 100, y: 100 },
      candidates: [
        {
          characterId: "character:attacker",
          partyId: "party:1",
          x: 100,
          y: 100,
          connected: true,
          joinedAtMs: 0,
          lastActivityAtMs: 0,
        },
        {
          characterId: "character:latecomer",
          partyId: "party:1",
          x: 100,
          y: 100,
          connected: true,
          joinedAtMs,
          // Explicit initial value: the join time, not 0.
          lastActivityAtMs: joinedAtMs,
        },
      ],
    });

    expect(eligible).toContain("character:latecomer");
  });

  it("would have wrongly excluded that same player as AFK under the old `?? 0` fallback", () => {
    const window = new ParticipationWindow({
      proximityRadius: 200,
      afkAfterMs: 2_500,
    });
    window.recordActivity({
      characterId: "character:attacker",
      partyId: "party:1",
      atMs: 0,
    });

    const defeatedAtMs = 5_000;
    window.close(defeatedAtMs);

    const eligible = window.eligibleCharacters({
      defeatedAtMs,
      monsterPosition: { x: 100, y: 100 },
      candidates: [
        {
          characterId: "character:attacker",
          partyId: "party:1",
          x: 100,
          y: 100,
          connected: true,
          joinedAtMs: 0,
          lastActivityAtMs: 0,
        },
        {
          characterId: "character:latecomer",
          partyId: "party:1",
          x: 100,
          y: 100,
          connected: true,
          joinedAtMs: 4_900,
          // The bug: untracked activity defaulted to epoch zero.
          lastActivityAtMs: 0,
        },
      ],
    });

    expect(eligible).not.toContain("character:latecomer");
  });
});
