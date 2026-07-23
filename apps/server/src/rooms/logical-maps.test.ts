import { describe, expect, it } from "vitest";

import { isLogicalMapAccessible } from "./logical-maps.js";

describe("logical map access policy", () => {
  it("allows current unlocked destinations and rejects unknown maps", () => {
    expect(isLogicalMapAccessible("map:village")).toBe(true);
    expect(isLogicalMapAccessible("map:forest")).toBe(true);
    expect(isLogicalMapAccessible("map:internal-secret")).toBe(false);
  });
});
