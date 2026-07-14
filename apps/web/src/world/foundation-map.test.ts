import { describe, expect, it } from "vitest";

import foundationMap from "./foundation-map.json";

const requiredLayers = [
  "background",
  "ground",
  "below_entities",
  "entities",
  "foreground",
  "effects",
  "collision",
  "navigation",
  "interactives",
  "spawns",
  "portals",
];

describe("foundation Tiled compatibility fixture", () => {
  it("has every required logical layer and complete tile data", () => {
    expect(foundationMap.layers.map((layer) => layer.name)).toEqual(
      requiredLayers,
    );

    const tileLayers = foundationMap.layers.filter(
      (layer) => layer.type === "tilelayer",
    );
    expect(tileLayers).toHaveLength(6);
    for (const layer of tileLayers) {
      expect(layer.data).toHaveLength(
        foundationMap.width * foundationMap.height,
      );
    }
  });
});
