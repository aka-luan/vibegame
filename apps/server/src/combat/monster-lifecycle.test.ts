import { describe, expect, it } from "vitest";

import foundationContent from "../../../../packages/content/content/foundation.json" with { type: "json" };
import { combatCatalogSchema } from "@gameish/content/combat";

import { MonsterLifecycle } from "./monster-lifecycle.js";

const canonicalCombat = combatCatalogSchema.parse(foundationContent.combat);
const monster = canonicalCombat.monsters[0]!;
const encounter = canonicalCombat.encounters[0]!;
const bossAction = canonicalCombat.monsterActions.find(
  (action) => action.id === monster.serverOnly.bossActionId,
)!;
const rooted = canonicalCombat.statuses.find(
  (status) => status.id === "status:rooted",
)!;
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
    lifecycle.tick(100, [{ id: "player:one", x: 40, y: 384 }]);

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

  it("telegraphs a boss cast and permits an interruptible hit", () => {
    const lifecycle = new MonsterLifecycle({
      entityId: "monster:village_mossback:1",
      monster,
      encounter,
      world,
      rng: () => 0,
      bossAction,
    });
    const target = { id: "player:one", x: 350, y: 256 };

    lifecycle.tick(0, [target]);
    const telegraph = lifecycle.tick(50, [target]);
    expect(telegraph).toEqual([
      {
        type: "cast_started",
        targetId: "player:one",
        abilityId: bossAction.id,
        startTimeMs: 50,
        durationMs: bossAction.serverOnly.telegraphDurationMs,
        interruptible: true,
      },
    ]);
    expect(lifecycle.state.cast?.endsAtMs).toBe(
      50 + bossAction.serverOnly.castTimeMs,
    );
    expect(lifecycle.interrupt()).toEqual({
      type: "interrupted",
      abilityId: bossAction.id,
    });
    expect(lifecycle.tick(100, [target])).toEqual([]);
  });

  it("applies a validated root status without allowing movement", () => {
    const lifecycle = new MonsterLifecycle({
      entityId: "monster:village_mossback:1",
      monster,
      encounter,
      world,
      rng: () => 0,
    });
    lifecycle.applyStatus(rooted, 0);
    lifecycle.tick(0, [{ id: "player:one", x: 400, y: 256 }]);
    lifecycle.tick(50, [{ id: "player:one", x: 400, y: 256 }]);
    expect(lifecycle.state.x).toBe(encounter.spawn.x);
  });
});
