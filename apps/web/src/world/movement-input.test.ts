import { describe, expect, it } from "vitest";

import { normalizeMovementDirection } from "./movement-input.js";

describe("movement input", () => {
  it("normalizes diagonal directions without changing their heading", () => {
    const diagonal = normalizeMovementDirection({ x: 1, y: -1 });

    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.y).toBeCloseTo(-Math.SQRT1_2);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
  });

  it("leaves cardinal and idle directions unchanged", () => {
    expect(normalizeMovementDirection({ x: 1, y: 0 })).toEqual({ x: 1, y: 0 });
    expect(normalizeMovementDirection({ x: 0, y: -1 })).toEqual({
      x: 0,
      y: -1,
    });
    expect(normalizeMovementDirection({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});
