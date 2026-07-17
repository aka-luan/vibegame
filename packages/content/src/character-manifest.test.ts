import { describe, expect, it } from "vitest";

import { validateCharacterManifest } from "./character-manifest.js";

const requiredAnimations = [
  "idle",
  "walk",
  "attack_basic",
  "ability_1",
  "ability_2",
  "ability_3",
  "ability_4",
  "hit",
  "defeated",
] as const;

function validManifest() {
  return {
    schemaVersion: 1,
    id: "rig:village_placeholder",
    rigVersion: "village-rig-v1",
    canvas: { width: 16, height: 24 },
    displayScale: 2,
    footOrigin: { x: 8, y: 22 },
    collision: { offsetX: 0, offsetY: -3, width: 10, height: 7 },
    facings: {
      east: { row: 2 },
      west: { mirror: "east" },
    },
    animations: Object.fromEntries(
      requiredAnimations.map((name) => [
        name,
        {
          frames: name === "walk" ? [0, 1, 2, 1] : [0],
          frameDurationMs: 140,
          loop: name !== "defeated",
        },
      ]),
    ),
    attachments: { hand: { x: 12, y: 14 } },
    layers: [
      {
        id: "base",
        depth: 0,
        fallback: null,
        source: {
          kind: "embedded_png",
          dataUri: "data:image/png;base64,AAAA",
          frameColumns: 3,
          frameRows: 3,
        },
      },
      {
        id: "tunic",
        depth: 1,
        fallback: "base",
        source: {
          kind: "embedded_png",
          dataUri: "data:image/png;base64,BBBB",
          frameColumns: 3,
          frameRows: 3,
        },
      },
    ],
    provenance: {
      license: "CC0-1.0",
      creator: "Gameish project",
      source: "Original generated placeholder",
      exportTool: "Phaser CanvasTexture",
      exportToolVersion: "4.2.1",
      rigVersion: "village-rig-v1",
      dimensions: "16x24 per frame",
      frameArrangement: "manifest rows and frames",
      replacementCompatibility: "village-rig-v1",
    },
  };
}

describe("character manifest validation", () => {
  it("accepts the canonical two-facing manifest with every required state", () => {
    expect(validateCharacterManifest(validManifest())).toEqual({
      success: true,
    });
  });

  it("accepts a compatible placeholder art replacement without gameplay changes", () => {
    const replacement = validManifest();
    replacement.layers[1]!.source.dataUri = "data:image/png;base64,CCCC";
    replacement.provenance.source = "Original alternate placeholder";
    expect(validateCharacterManifest(replacement)).toEqual({ success: true });
  });

  it("rejects a foot origin outside the logical canvas", () => {
    const input = validManifest();
    input.footOrigin.x = 20;
    expect(validateCharacterManifest(input)).toEqual({
      success: false,
      issues: [
        {
          path: "footOrigin",
          message: "Foot origin must be inside the logical canvas",
        },
      ],
    });
  });

  it("rejects a missing required animation", () => {
    const input = validManifest();
    delete input.animations.ability_4;
    expect(validateCharacterManifest(input)).toEqual({
      success: false,
      issues: [
        {
          path: "animations.ability_4",
          message: "Required animation is missing",
        },
      ],
    });
  });

  it("rejects an unknown layer fallback", () => {
    const input = validManifest();
    input.layers[1]!.fallback = "missing";
    expect(validateCharacterManifest(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers[1].fallback",
          message: "Fallback layer does not exist: missing",
        },
      ],
    });
  });

  it("rejects fallback cycles between appearance layers", () => {
    const input = validManifest();
    input.layers[0]!.fallback = "tunic";
    expect(validateCharacterManifest(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers[0].fallback",
          message: "Layer fallbacks must not contain a cycle",
        },
        {
          path: "layers[1].fallback",
          message: "Layer fallbacks must not contain a cycle",
        },
      ],
    });
  });

  it("rejects an appearance layer with incompatible frame geometry", () => {
    const input = validManifest();
    input.layers[1]!.source.frameColumns = 1;
    expect(validateCharacterManifest(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers[1].source",
          message: "Layer sprite sheet is incompatible with the canonical rig",
        },
      ],
    });
  });
});
