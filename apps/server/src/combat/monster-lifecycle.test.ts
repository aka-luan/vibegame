import { describe, expect, it } from "vitest";

import foundationContent from "../../../../packages/content/content/foundation.json" with { type: "json" };
import { combatCatalogSchema } from "@gameish/content/combat";

import { MonsterLifecycle } from "./monster-lifecycle.js";

const canonicalCombat = combatCatalogSchema.parse(foundationContent.combat);
const monster = canonicalCombat.monsters[0]!;
const encounter = canonicalCombat.encounters[0]!;
const world = {
  bounds: { x: 0, y: 192, width: 512, height: 192 },
  obstacles: [],
};

describe("server monster lifecycle", () => {
  it("acquires the nearest active player and chases into attack range", () => {
    const lifecycle = new MonsterLifecycle({
      entityId: "monster:village_mossback:1",
      monster,
      encounter,
      world,
      rng: () => 0,
    });

    const target = { id: "player:one", x: 360, y: 256 };
    expect(lifecycle.tick(0, [target])).toEqual([
      { type: "aggro", targetId: "player:one" },
    ]);
    expect(lifecycle.state.targetId).toBe("player:one");
    expect(lifecycle.state.state).toBe("chasing");
    lifecycle.tick(50, [target]);
    expect(lifecycle.state.x).toBeGreaterThan(encounter.spawn.x);
    expect(lifecycle.state.state).toBe("chasing");

    const events = Array.from({ length: 40 }, (_, index) =>
      lifecycle.tick((index + 2) * 50, [target]),
    ).flat();
    expect(events).toContainEqual({ type: "attack", targetId: "player:one" });
  });

  it("leashes to its spawn when its target escapes the leash range", () => {
    const lifecycle = new MonsterLifecycle({
      entityId: "monster:village_mossback:1",
      monster,
      encounter,
      world,
      rng: () => 0,
    });

    lifecycle.tick(0, [{ id: "player:one", x: 330, y: 256 }]);
    lifecycle.tick(100, [{ id: "player:one", x: 500, y: 384 }]);

    expect(lifecycle.state.targetId).toBeNull();
    expect(lifecycle.state.state).toBe("leashing");
    expect(lifecycle.state.health).toBe(monster.serverOnly.maxHealth);
  });

  it("defeats and respawns with an injected clock", () => {
    const lifecycle = new MonsterLifecycle({
      entityId: "monster:village_mossback:1",
      monster,
      encounter,
      world,
      rng: () => 0,
    });

    expect(lifecycle.applyDamage(monster.serverOnly.maxHealth, 200)).toEqual({
      type: "defeated",
    });
    expect(lifecycle.state.state).toBe("defeated");

    expect(lifecycle.tick(200 + monster.serverOnly.respawnMs - 1, [])).toEqual(
      [],
    );
    expect(lifecycle.tick(200 + monster.serverOnly.respawnMs, [])).toEqual([
      { type: "respawned" },
    ]);
    expect(lifecycle.state.state).toBe("idle");
    expect(lifecycle.state.health).toBe(monster.serverOnly.maxHealth);
  });
});
