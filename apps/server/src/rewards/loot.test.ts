import { describe, expect, it } from "vitest";

import type { LootDefinition } from "@gameish/content/combat";

import { rollPersonalLoot } from "./loot.js";

const loot: LootDefinition = {
  id: "loot:test_cache",
  monsterId: "monster:test",
  entries: [
    { id: "item:common_scale", weight: 1 },
    { id: "item:rare_scale", weight: 3 },
  ],
};

describe("personal loot rolls", () => {
  it("uses only the server-supplied seeded roll", () => {
    expect(rollPersonalLoot(loot, () => 0.1)).toBe("item:common_scale");
    expect(rollPersonalLoot(loot, () => 0.9)).toBe("item:rare_scale");
  });

  it("makes independent rolls for independent recipients", () => {
    const rolls = [0.1, 0.9];
    expect(
      [0, 1].map(() => rollPersonalLoot(loot, () => rolls.shift() ?? 0)),
    ).toEqual(["item:common_scale", "item:rare_scale"]);
  });
});
