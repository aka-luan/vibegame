import { describe, expect, it } from "vitest";

import foundationContent from "../../../../packages/content/content/foundation.json" with { type: "json" };
import { combatCatalogSchema } from "@gameish/content/combat";

import { resolveBasicAttack } from "./resolver.js";

const attack = combatCatalogSchema.parse(foundationContent.combat).attacks[0]!;
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
