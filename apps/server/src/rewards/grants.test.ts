import { describe, expect, it } from "vitest";

import { rewardGrantId } from "./grants.js";

describe("reward grant identity", () => {
  it("is stable for retries and unique per character and defeat", () => {
    expect(rewardGrantId("monster:mossback", 1, "character:one")).toBe(
      "reward:monster:mossback:1:character:one",
    );
    expect(rewardGrantId("monster:mossback", 1, "character:two")).not.toBe(
      rewardGrantId("monster:mossback", 1, "character:one"),
    );
    expect(rewardGrantId("monster:mossback", 2, "character:one")).not.toBe(
      rewardGrantId("monster:mossback", 1, "character:one"),
    );
  });
});
