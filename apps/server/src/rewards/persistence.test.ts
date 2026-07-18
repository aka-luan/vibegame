import { describe, expect, it } from "vitest";

import {
  DuplicateRewardGrantError,
  InMemoryRewardPersistence,
  type RewardGrant,
} from "./persistence.js";

const grant: RewardGrant = {
  grantId: "reward:monster:mossback:1:character:one",
  characterId: "character:one",
  sourceMonsterId: "monster:mossback",
  defeatSequence: 1,
  itemId: "item:mossback_scale",
  quantity: 1,
};

describe("reward persistence boundary", () => {
  it("stores a grant and rejects a duplicate idempotency identity", async () => {
    const persistence = new InMemoryRewardPersistence();

    await persistence.grant(grant);
    await expect(persistence.grant(grant)).rejects.toBeInstanceOf(
      DuplicateRewardGrantError,
    );
    expect(persistence.grantsFor("character:one")).toEqual([grant]);
  });
});
