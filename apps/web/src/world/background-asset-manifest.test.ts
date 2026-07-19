import { describe, expect, it } from "vitest";

import {
  validateBackgroundAssetManifest,
  villageBackgroundManifest,
} from "./background-asset-manifest.js";

function validManifest() {
  return {
    schemaVersion: 1 as const,
    id: "background:village",
    assetVersion: "village-background-v1",
    path: "village-background.svg",
    dimensions: { width: 1504, height: 400 },
    provenance: {
      license: "CC0-1.0",
      creator: "Gameish project",
      source: "Original Gameish placeholder",
      exportTool: "hand-authored SVG",
      exportToolVersion: "village-background-v1",
      assetVersion: "village-background-v1",
      dimensions: "1504x400",
      layout: "single full-scene image, no frame grid",
      replacementCompatibility:
        "Any production replacement must be a 1504x400 full-scene " +
        "side-view image with sky above the horizon line and walkable " +
        "ground below it.",
    },
  };
}

describe("background asset manifest validation", () => {
  it("accepts the canonical village background manifest", () => {
    expect(validateBackgroundAssetManifest(villageBackgroundManifest)).toEqual(
      { success: true },
    );
  });

  it("accepts a compatible replacement that keeps dimensions and versions in sync", () => {
    const replacement = validManifest();
    replacement.provenance.source = "Original alternate placeholder";
    expect(validateBackgroundAssetManifest(replacement)).toEqual({
      success: true,
    });
  });

  it("rejects a provenance asset version that drifts from the manifest", () => {
    const input = validManifest();
    input.provenance.assetVersion = "village-background-v2";
    expect(validateBackgroundAssetManifest(input)).toEqual({
      success: false,
      issues: ["Provenance asset version must match the manifest"],
    });
  });

  it("rejects provenance dimensions that drift from the manifest dimensions", () => {
    const input = validManifest();
    input.provenance.dimensions = "1024x400";
    expect(validateBackgroundAssetManifest(input)).toEqual({
      success: false,
      issues: ["Provenance dimensions must match the manifest dimensions"],
    });
  });

  it("rejects an id outside the background namespace", () => {
    const input = validManifest();
    input.id = "village";
    expect(validateBackgroundAssetManifest(input).success).toBe(false);
  });
});
