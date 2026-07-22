import villageCombat from "@gameish/content/village-combat-server";
import { describe, expect, it } from "vitest";

import {
  RewardSettlementWindow,
  settleDefeat,
  type RewardCandidate,
} from "./settlement.js";

const monster = villageCombat.monsters[0]!;
const loot = villageCombat.loot.find(
  (definition) => definition.monsterId === monster.id,
)!;

function candidate(
  characterId: string,
  overrides: Partial<RewardCandidate> = {},
): RewardCandidate {
  return {
    characterId,
    recipientSessionId: `session:${characterId}`,
    partyId: undefined,
    x: 10,
    y: 20,
    connected: true,
    joinedAtMs: 0,
    ...overrides,
  };
}

function settlement(options: {
  participants: readonly { characterId: string; atMs: number }[];
  candidates: readonly RewardCandidate[];
  now?: number;
  random?: () => number;
}) {
  const window = new RewardSettlementWindow({
    proximityRadius: 100,
    afkAfterMs: 5_000,
  });
  for (const participant of options.participants) {
    window.recordActivity(participant);
  }
  return settleDefeat({
    participationWindow: window,
    defeatedMonster: {
      entityId: "monster:mossback:1",
      sourceMonsterId: monster.id,
      position: { x: 10, y: 20 },
    },
    roomInstanceId: "room:1",
    defeatSequence: 2,
    candidates: options.candidates,
    combatCatalog: villageCombat,
    clock: () => options.now ?? 5_000,
    random: options.random ?? (() => 0),
  });
}

describe("reward settlement", () => {
  it("grants loot to a single participant", () => {
    const result = settlement({
      participants: [{ characterId: "character:a", atMs: 1_000 }],
      candidates: [candidate("character:a")],
    });

    expect(result.grants.map((grant) => grant.characterId)).toEqual([
      "character:a",
    ]);
    expect(result.grants[0]?.reward?.quantity).toBe(1);
  });

  it("orders grants for multiple participants by character id", () => {
    const result = settlement({
      participants: [
        { characterId: "character:z", atMs: 1_000 },
        { characterId: "character:a", atMs: 1_000 },
      ],
      candidates: [candidate("character:z"), candidate("character:a")],
    });

    expect(result.grants.map((grant) => grant.characterId)).toEqual([
      "character:a",
      "character:z",
    ]);
  });

  it("excludes a non-participant", () => {
    const result = settlement({
      participants: [{ characterId: "character:a", atMs: 1_000 }],
      candidates: [candidate("character:a"), candidate("character:idle")],
    });

    expect(result.grants.map((grant) => grant.characterId)).toEqual([
      "character:a",
    ]);
  });

  it("uses an inclusive expiry boundary", () => {
    const atBoundary = settlement({
      participants: [{ characterId: "character:a", atMs: 1_000 }],
      candidates: [candidate("character:a")],
      now: 6_000,
    });
    const beyondBoundary = settlement({
      participants: [{ characterId: "character:a", atMs: 999 }],
      candidates: [candidate("character:a")],
      now: 6_000,
    });

    expect(atBoundary.grants).toHaveLength(1);
    expect(beyondBoundary.grants).toHaveLength(0);
  });

  it("keeps recent activity while opening the next participation window", () => {
    const window = new RewardSettlementWindow({
      proximityRadius: 100,
      afkAfterMs: 5_000,
    });
    window.recordActivity({
      characterId: "character:a",
      partyId: "party:1",
      atMs: 4_900,
    });
    window.open();
    window.recordActivity({
      characterId: "character:b",
      partyId: "party:1",
      atMs: 5_000,
    });

    const result = settleDefeat({
      participationWindow: window,
      defeatedMonster: {
        entityId: "monster:mossback:1",
        sourceMonsterId: monster.id,
        position: { x: 10, y: 20 },
      },
      roomInstanceId: "room:1",
      defeatSequence: 2,
      candidates: [
        candidate("character:a", { partyId: "party:1" }),
        candidate("character:b", { partyId: "party:1" }),
      ],
      combatCatalog: villageCombat,
      clock: () => 5_000,
      random: () => 0,
    });

    expect(result.grants.map((grant) => grant.characterId)).toEqual([
      "character:a",
      "character:b",
    ]);
  });

  it("pins the personal loot roll", () => {
    const rolls = [0, 0.999];
    const result = settlement({
      participants: [
        { characterId: "character:a", atMs: 1_000 },
        { characterId: "character:b", atMs: 1_000 },
      ],
      candidates: [candidate("character:a"), candidate("character:b")],
      random: () => rolls.shift()!,
    });

    expect(result.grants.map((grant) => grant.reward?.itemId)).toEqual([
      loot.entries[0]!.id,
      loot.entries.at(-1)!.id,
    ]);
  });

  it("constructs deterministic grant and objective event ids", () => {
    const run = () =>
      settlement({
        participants: [{ characterId: "character:a", atMs: 1_000 }],
        candidates: [candidate("character:a")],
      }).grants[0];

    expect(run()).toEqual(run());
    expect(run()).toMatchObject({
      objectiveEventId: "quest-event:room:1:monster:mossback:1:2",
      reward: {
        grantId: "reward:room:1:monster:mossback:1:2:character:a",
      },
    });
  });
});
