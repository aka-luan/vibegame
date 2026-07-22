import { describe, expect, it } from "vitest";

import {
  selectMapInstance,
  type MapInstanceCandidate,
  type MapPlacementConfig,
} from "./placement.js";

const config: MapPlacementConfig = {
  softPopulationTarget: 2,
  hardCapacity: 4,
};

function candidate(
  overrides: Partial<MapInstanceCandidate> = {},
): MapInstanceCandidate {
  return {
    roomId: "room:village:1",
    clients: 0,
    maxClients: config.hardCapacity,
    locked: false,
    instanceRole: "public",
    logicalMapId: "map:village",
    createdAt: 1,
    ...overrides,
  };
}

describe("map placement matrix", () => {
  it("creates a new public instance when there are no candidates", () => {
    expect(selectMapInstance([], "map:village", config)).toBeUndefined();
  });

  it("selects an instance below the soft population target", () => {
    expect(
      selectMapInstance(
        [candidate({ roomId: "room:village:1", clients: 1 })],
        "map:village",
        config,
      ),
    ).toBe("room:village:1");
  });

  it("creates a new instance when every candidate reaches the soft target", () => {
    expect(
      selectMapInstance(
        [candidate({ roomId: "room:village:1", clients: 2 })],
        "map:village",
        config,
      ),
    ).toBeUndefined();
  });

  it("uses an over-target instance as overflow while it remains below hard capacity", () => {
    expect(
      selectMapInstance(
        [candidate({ roomId: "room:village:1", clients: 3 })],
        "map:village",
        config,
      ),
    ).toBe("room:village:1");
  });

  it("excludes locked, full, disposing, non-public, and wrong-map candidates", () => {
    expect(
      selectMapInstance(
        [
          candidate({ roomId: "room:locked", locked: true }),
          candidate({ roomId: "room:full", clients: 4 }),
          candidate({ roomId: "room:capacity-limited", clients: 2, maxClients: 2 }),
          candidate({ roomId: "room:disposing", locked: true }),
          candidate({ roomId: "room:private", instanceRole: "private" }),
          candidate({ roomId: "room:forest", logicalMapId: "map:forest" }),
          candidate({ roomId: "room:village:valid", clients: 1 }),
        ],
        "map:village",
        config,
      ),
    ).toBe("room:village:valid");
  });

  it("breaks ties by fewest clients and then oldest creation time", () => {
    expect(
      selectMapInstance(
        [
          candidate({ roomId: "room:more-populated", clients: 1, createdAt: 1 }),
          candidate({ roomId: "room:less-populated", clients: 0, createdAt: 100 }),
        ],
        "map:village",
        config,
      ),
    ).toBe("room:less-populated");
    expect(
      selectMapInstance(
        [
          candidate({ roomId: "room:newer", clients: 1, createdAt: 2 }),
          candidate({ roomId: "room:older", clients: 1, createdAt: 1 }),
        ],
        "map:village",
        config,
      ),
    ).toBe("room:older");
  });
});
