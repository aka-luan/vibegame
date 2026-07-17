import { describe, expect, it } from "vitest";

import foundationContent from "../../../../packages/content/content/foundation.json" with { type: "json" };
import { combatCatalogSchema } from "@gameish/content/combat";

import { resolveAbility, resolveBasicAttack } from "./resolver.js";

const canonicalCombat = combatCatalogSchema.parse(foundationContent.combat);
const attack = canonicalCombat.attacks[0]!;
const abilities = canonicalCombat.abilities;
const baseRequest = {
  nowMs: 10_000,
  lastActionAtMs: undefined,
  cooldownEndsAtMs: 0,
  attacker: { x: 100, y: 100, resource: 100, defeated: false },
  target: { x: 150, y: 100, health: 50, maxHealth: 50, defeated: false },
  attack,
};

describe("basic attack resolver", () => {
  it.each([
    {
      label: "attacker is defeated",
      overrides: { attacker: { ...baseRequest.attacker, defeated: true } },
      code: "INVALID_COMBAT_STATE",
    },
    {
      label: "target is already defeated",
      overrides: { target: { ...baseRequest.target, defeated: true } },
      code: "TARGET_DEFEATED",
    },
    {
      label: "target is out of range",
      overrides: { target: { ...baseRequest.target, x: 500 } },
      code: "TARGET_OUT_OF_RANGE",
    },
    {
      label: "attack is cooling down",
      overrides: { cooldownEndsAtMs: 10_500 },
      code: "ABILITY_ON_COOLDOWN",
    },
    {
      label: "action rate is exceeded",
      overrides: { lastActionAtMs: 9_950 },
      code: "ACTION_RATE_LIMITED",
    },
    {
      label: "resource is insufficient",
      overrides: {
        attacker: {
          ...baseRequest.attacker,
          resource: attack.serverOnly.resourceCost - 1,
        },
      },
      code: "INSUFFICIENT_RESOURCE",
    },
  ])("rejects when $label", ({ overrides, code }) => {
    const result = resolveBasicAttack({ ...baseRequest, ...overrides });

    expect(result).toEqual({ accepted: false, code });
  });

  it("computes damage, resource, cooldown, and defeat from server content", () => {
    expect(
      resolveBasicAttack({
        ...baseRequest,
        target: { ...baseRequest.target, health: attack.serverOnly.damage },
      }),
    ).toEqual({
      accepted: true,
      damage: attack.serverOnly.damage,
      remainingHealth: 0,
      remainingResource: 100 - attack.serverOnly.resourceCost,
      cooldownEndsAtMs: 10_000 + attack.serverOnly.cooldownMs,
      defeated: true,
    });
  });
});

describe("ability resolver", () => {
  it("keeps all four approved abilities distinct and server timed", () => {
    const results = abilities.map((ability) =>
      resolveAbility({
        nowMs: 10_000,
        lastActionAtMs: undefined,
        cooldownEndsAtMs: 0,
        attacker: { x: 100, y: 100, resource: 100, defeated: false },
        target: {
          x: 150,
          y: 100,
          health: 100,
          maxHealth: 100,
          defeated: false,
        },
        ability,
      }),
    );

    expect(new Set(abilities.map((ability) => ability.slot)).size).toBe(4);
    expect(results.map((result) => result.accepted)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(results[1]).toMatchObject({
      accepted: true,
      castEndsAtMs: 10_300,
      movementLockedUntilMs: 10_600,
    });
    expect(results[2]).toMatchObject({
      accepted: true,
      damage: 0,
      movementLockedUntilMs: 10_000,
    });
  });

  it.each([
    ["cooldown", { cooldownEndsAtMs: 10_001 }, "ABILITY_ON_COOLDOWN"],
    [
      "resource",
      { attacker: { x: 100, y: 100, resource: 1, defeated: false } },
      "INSUFFICIENT_RESOURCE",
    ],
    [
      "range",
      {
        target: {
          x: 500,
          y: 100,
          health: 100,
          maxHealth: 100,
          defeated: false,
        },
      },
      "TARGET_OUT_OF_RANGE",
    ],
  ])("rejects an ability when %s", (_label, overrides, code) => {
    const ability = abilities[0]!;
    const result = resolveAbility({
      nowMs: 10_000,
      lastActionAtMs: undefined,
      cooldownEndsAtMs: 0,
      attacker: { x: 100, y: 100, resource: 100, defeated: false },
      target: { x: 150, y: 100, health: 100, maxHealth: 100, defeated: false },
      ability,
      ...overrides,
    });
    expect(result).toEqual({ accepted: false, code });
  });
});
