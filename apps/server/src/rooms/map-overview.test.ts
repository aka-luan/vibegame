import { describe, expect, it } from "vitest";

import { buildMapOverview } from "./map-overview.js";

const logicalMaps = {
  "map:forest": {
    displayName: "Forest",
    portals: [
      {
        destinationMapId: "map:village",
        label: "Village path",
        locked: false,
      },
      {
        destinationMapId: "map:hidden",
        label: "Secret door",
        locked: false,
      },
    ],
  },
  "map:village": {
    displayName: "Village",
    portals: [
      {
        destinationMapId: "map:forest",
        label: "Forest path",
        locked: false,
      },
      {
        destinationMapId: "map:locked",
        label: "Locked road",
        locked: true,
      },
    ],
  },
} as const;

describe("buildMapOverview", () => {
  it("returns deterministic client-safe locations, connections, guidance, and recommendations", () => {
    const overview = buildMapOverview({
      logicalMaps,
      isAccessible: (mapId) => mapId !== "map:locked",
      discoveredMapIds: new Set(["map:village"]),
      currentMapId: "map:village",
      questGuidance: { logicalMapId: "map:forest", label: "Forest entrance" },
    });

    expect(overview).toEqual({
      locations: [
        {
          logicalMapId: "map:forest",
          displayName: "Forest",
          accessible: true,
          discovered: false,
        },
        {
          logicalMapId: "map:village",
          displayName: "Village",
          accessible: true,
          discovered: true,
        },
      ],
      connections: [
        {
          fromMapId: "map:forest",
          toMapId: "map:village",
          label: "Village path",
        },
        {
          fromMapId: "map:village",
          toMapId: "map:forest",
          label: "Forest path",
        },
      ],
      recommendations: [
        {
          logicalMapId: "map:forest",
          displayName: "Forest",
          reason: "quest",
        },
      ],
      guidance: { label: "Forest entrance" },
    });
    const encoded = JSON.stringify(overview);
    expect(encoded).not.toContain("room");
    expect(encoded).not.toContain("Secret door");
  });

  it("recommends an adjacent accessible map as unexplored without leaking locked destinations", () => {
    const overview = buildMapOverview({
      logicalMaps,
      isAccessible: (mapId) => mapId !== "map:locked",
      discoveredMapIds: new Set(["map:forest"]),
      currentMapId: "map:forest",
    });

    expect(overview.recommendations).toEqual([
      {
        logicalMapId: "map:village",
        displayName: "Village",
        reason: "unexplored",
      },
    ]);
    expect(overview.connections).not.toContainEqual(
      expect.objectContaining({ toMapId: "map:hidden" }),
    );
  });
});
