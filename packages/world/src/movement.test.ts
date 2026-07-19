import { describe, expect, it } from "vitest";

import { moveBody, type MovementRequest } from "./index.js";

const openWorld: MovementRequest["world"] = {
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  obstacles: [],
};

describe("deterministic movement", () => {
  it.each([
    { label: "one 100 ms step", steps: [100] },
    { label: "five 20 ms steps", steps: [20, 20, 20, 20, 20] },
    { label: "uneven frame steps", steps: [7, 31, 12, 50] },
  ])("moves the same distance for $label", ({ steps }) => {
    const result = steps.reduce(
      (position, elapsedMs) =>
        moveBody({
          position,
          direction: { x: 1, y: 0 },
          speed: 40,
          elapsedMs,
          body: { width: 10, height: 8 },
          world: openWorld,
        }),
      { x: 20, y: 20 },
    );

    expect(result.x).toBeCloseTo(24, 10);
    expect(result.y).toBe(20);
  });

  it("normalizes diagonal input so it is not faster", () => {
    const result = moveBody({
      position: { x: 20, y: 20 },
      direction: { x: 1, y: 1 },
      speed: 50,
      elapsedMs: 100,
      body: { width: 10, height: 8 },
      world: openWorld,
    });
    expect(result.x).toBeCloseTo(23.535533905932738, 10);
    expect(result.y).toBeCloseTo(23.535533905932738, 10);
  });

  it.each([
    {
      label: "left edge",
      position: { x: 5, y: 50 },
      direction: { x: -1, y: 0 },
      expected: { x: 5, y: 50 },
    },
    {
      label: "top edge",
      position: { x: 50, y: 4 },
      direction: { x: 0, y: -1 },
      expected: { x: 50, y: 4 },
    },
    {
      label: "bottom-right corner",
      position: { x: 95, y: 96 },
      direction: { x: 1, y: 1 },
      expected: { x: 95, y: 96 },
    },
  ])("stops at the $label", ({ position, direction, expected }) => {
    expect(
      moveBody({
        position,
        direction,
        speed: 100,
        elapsedMs: 100,
        body: { width: 10, height: 8 },
        world: openWorld,
      }),
    ).toEqual(expected);
  });

  it("slides along an obstacle when one movement axis is clear", () => {
    const result = moveBody({
      position: { x: 35, y: 55 },
      direction: { x: 1, y: -1 },
      speed: 100,
      elapsedMs: 100,
      body: { width: 10, height: 10 },
      world: {
        ...openWorld,
        obstacles: [{ x: 40, y: 40, width: 20, height: 20 }],
      },
    });
    expect(result.x).toBe(35);
    expect(result.y).toBeCloseTo(47.928932188134524, 10);
  });

  it("produces the same obstacle slide across variable time steps", () => {
    const request = {
      direction: { x: 1, y: -1 },
      speed: 100,
      body: { width: 10, height: 10 },
      world: {
        ...openWorld,
        obstacles: [{ x: 40, y: 40, width: 20, height: 20 }],
      },
    };
    const oneStep = moveBody({
      ...request,
      position: { x: 35, y: 46 },
      elapsedMs: 200,
    });
    const splitSteps = [40, 40, 40, 40, 40].reduce(
      (position, elapsedMs) => moveBody({ ...request, position, elapsedMs }),
      { x: 35, y: 46 },
    );

    expect(splitSteps.x).toBeCloseTo(oneStep.x, 10);
    expect(splitSteps.y).toBeCloseTo(oneStep.y, 10);
  });
});

describe("movement within a walkable ground region", () => {
  // Mirrors the geometry a compiled side-view map hands to movement: a
  // horizontal band bounding vertical positioning (see ADR-0011 and the
  // compiled village map's `server.bounds` in
  // packages/content/src/map-compiler.test.ts). The map spans the full
  // width; the walkable ground region is the shallow vertical band within
  // it, so the same `world.bounds` rectangle clamps horizontal movement at
  // the map edges and vertical movement at the ground region's edges.
  const groundRegionWorld: MovementRequest["world"] = {
    bounds: { x: 0, y: 256, width: 1504, height: 128 },
    obstacles: [],
  };
  const body = { width: 16, height: 24 };

  it("integrates unclamped while inside the walkable ground region's interior", () => {
    const result = moveBody({
      position: { x: 700, y: 320 },
      direction: { x: 1, y: -1 },
      speed: 100,
      elapsedMs: 100,
      body,
      world: groundRegionWorld,
    });

    const distance = (100 * 100) / 1_000;
    expect(result.x).toBeCloseTo(700 + distance / Math.sqrt(2), 10);
    expect(result.y).toBeCloseTo(320 - distance / Math.sqrt(2), 10);
  });

  it.each([
    {
      label: "top edge",
      position: { x: 700, y: 280 },
      direction: { x: 0, y: -1 },
      expected: { x: 700, y: 256 + body.height / 2 },
    },
    {
      label: "bottom edge",
      position: { x: 700, y: 360 },
      direction: { x: 0, y: 1 },
      expected: { x: 700, y: 384 - body.height / 2 },
    },
  ])(
    "clamps vertical movement at the walkable ground region's $label",
    ({ position, direction, expected }) => {
      const result = moveBody({
        position,
        direction,
        speed: 100,
        elapsedMs: 1_000,
        body,
        world: groundRegionWorld,
      });

      expect(result).toEqual(expected);
    },
  );

  it.each([
    {
      label: "left map edge",
      position: { x: 20, y: 320 },
      direction: { x: -1, y: 0 },
      expected: { x: body.width / 2, y: 320 },
    },
    {
      label: "right map edge",
      position: { x: 1480, y: 320 },
      direction: { x: 1, y: 0 },
      expected: { x: 1504 - body.width / 2, y: 320 },
    },
  ])(
    "clamps horizontal movement at the $label",
    ({ position, direction, expected }) => {
      const result = moveBody({
        position,
        direction,
        speed: 100,
        elapsedMs: 1_000,
        body,
        world: groundRegionWorld,
      });

      expect(result).toEqual(expected);
    },
  );
});
