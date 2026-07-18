import { describe, expect, it } from "vitest";

import { rewardGrantId } from "./grants.js";

describe("reward grant identity", () => {
  it("is stable for retries and unique per room, character, and defeat", () => {
    expect(
      rewardGrantId("room:one", "monster:mossback", 1, "character:one"),
    ).toBe("reward:room:one:monster:mossback:1:character:one");
    expect(
      rewardGrantId("room:two", "monster:mossback", 1, "character:one"),
    ).not.toBe(
      rewardGrantId("room:one", "monster:mossback", 1, "character:one"),
    );
    expect(
      rewardGrantId("room:one", "monster:mossback", 1, "character:two"),
    ).not.toBe(
      rewardGrantId("room:one", "monster:mossback", 1, "character:one"),
    );
    expect(
      rewardGrantId("room:one", "monster:mossback", 2, "character:one"),
    ).not.toBe(
      rewardGrantId("room:one", "monster:mossback", 1, "character:one"),
    );
  });
});
