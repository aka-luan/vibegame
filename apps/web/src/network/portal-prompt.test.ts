import { describe, expect, it } from "vitest";

import { computeActivePortalPrompt } from "./portal-prompt.js";

const portalHints = [
  { id: "portal_forest_gate", label: "Travel to the forest", x: 1476, y: 328 },
  { id: "portal_other_gate", label: "Travel elsewhere", x: 100, y: 100 },
];

describe("computeActivePortalPrompt", () => {
  it("returns null when the player is outside every portal's radius", () => {
    expect(
      computeActivePortalPrompt(portalHints, { x: 700, y: 328 }, 64),
    ).toBeNull();
  });

  it("returns the portal the player is within radius of", () => {
    expect(
      computeActivePortalPrompt(portalHints, { x: 1480, y: 330 }, 64),
    ).toEqual({
      portalId: "portal_forest_gate",
      label: "Travel to the forest",
    });
  });

  it("is exactly inclusive at the radius boundary", () => {
    expect(
      computeActivePortalPrompt(portalHints, { x: 1476 + 64, y: 328 }, 64),
    ).toEqual({
      portalId: "portal_forest_gate",
      label: "Travel to the forest",
    });
    expect(
      computeActivePortalPrompt(portalHints, { x: 1476 + 64.01, y: 328 }, 64),
    ).toBeNull();
  });

  it("picks the nearest portal when two are both in range", () => {
    const closeHints = [
      { id: "near", label: "Near", x: 0, y: 0 },
      { id: "far", label: "Far", x: 10, y: 0 },
    ];
    expect(computeActivePortalPrompt(closeHints, { x: 3, y: 0 }, 64)).toEqual({
      portalId: "near",
      label: "Near",
    });
  });

  it("returns null when there are no portal hints on the map", () => {
    expect(computeActivePortalPrompt([], { x: 0, y: 0 }, 64)).toBeNull();
  });
});
