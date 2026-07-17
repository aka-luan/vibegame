import { describe, expect, it } from "vitest";

import foundationContent from "../content/foundation.json" with { type: "json" };

import { combatCatalogSchema, validateCombatCatalog } from "./combat.js";

const canonicalCombat = combatCatalogSchema.parse(foundationContent.combat);

describe("combat content validation", () => {
  it("accepts the bounded class, attack, monster, encounter, and loot catalog", () => {
    expect(validateCombatCatalog(canonicalCombat)).toEqual({
      success: true,
    });
  });

  it("rejects a missing monster reference from an encounter", () => {
    const invalidCatalog = structuredClone(canonicalCombat);
    invalidCatalog.encounters[0]!.monsterId = "monster:missing";

    expect(validateCombatCatalog(invalidCatalog)).toEqual({
      success: false,
      issues: [
        {
          path: "encounters[0].monsterId",
          message: "Encounter references an unknown monster: monster:missing",
        },
      ],
    });
  });

  it("rejects client-visible combat outcome fields", () => {
    const invalidCatalog = structuredClone(canonicalCombat) as Record<
      string,
      unknown
    >;
    const attacks = invalidCatalog.attacks as Record<string, unknown>[];
    attacks[0]!.clientVisible = {
      displayName: "Trailward Strike",
      animation: "attack_basic",
      damage: 999,
    };

    expect(validateCombatCatalog(invalidCatalog)).toEqual({
      success: false,
      issues: [
        {
          path: "attacks[0].clientVisible",
          message: 'Unrecognized key: "damage"',
        },
      ],
    });
  });
});
