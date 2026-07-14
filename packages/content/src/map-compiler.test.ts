import { describe, expect, it } from "vitest";

import { compileTiledMap } from "./maps.js";

const renderLayerNames = [
  "background",
  "ground",
  "below_entities",
  "entities",
  "foreground",
  "effects",
] as const;
const logicalLayerNames = [
  "collision",
  "navigation",
  "interactives",
  "spawns",
  "portals",
] as const;

function tileLayer(name: string, id: number) {
  return {
    id,
    name,
    type: "tilelayer",
    width: 4,
    height: 3,
    data: Array.from({ length: 12 }, () => 0),
    opacity: 1,
    visible: true,
    x: 0,
    y: 0,
  };
}

function objectLayer(name: string, id: number, objects: unknown[] = []) {
  return {
    id,
    name,
    type: "objectgroup",
    objects,
    opacity: 1,
    visible: true,
    x: 0,
    y: 0,
  };
}

function validMap() {
  return {
    type: "map",
    version: "1.10",
    tiledversion: "1.11.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: 4,
    height: 3,
    tilewidth: 16,
    tileheight: 16,
    layers: [
      ...renderLayerNames.map(tileLayer),
      objectLayer("collision", 7, [
        {
          id: 1,
          name: "fence",
          type: "collision",
          x: 32,
          y: 16,
          width: 16,
          height: 16,
        },
      ]),
      objectLayer("navigation", 8, [
        {
          id: 6,
          name: "walkable",
          type: "navigation",
          x: 0,
          y: 0,
          width: 64,
          height: 48,
        },
      ]),
      objectLayer("interactives", 9, [
        {
          id: 2,
          name: "notice_board",
          type: "interaction",
          x: 16,
          y: 16,
          width: 8,
          height: 8,
          properties: [{ name: "label", type: "string", value: "Read notice" }],
        },
      ]),
      objectLayer("spawns", 10, [
        {
          id: 3,
          name: "village_square",
          type: "player",
          x: 8,
          y: 8,
          width: 0,
          height: 0,
        },
      ]),
      objectLayer("portals", 11),
    ],
    tilesets: [
      {
        firstgid: 1,
        name: "village_placeholder",
        tilewidth: 16,
        tileheight: 16,
        tilecount: 3,
        columns: 3,
        image: "village-placeholder.png",
        imagewidth: 48,
        imageheight: 16,
      },
    ],
  };
}

describe("Tiled map compiler", () => {
  const compileVillage = (input: unknown) =>
    compileTiledMap("map:village", "content:test_v1", input, {
      offsetX: 0,
      offsetY: -3,
      width: 10,
      height: 7,
    });

  it("separates rendering data from authoritative geometry", () => {
    const result = compileVillage(validMap());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.client.layers.map((layer) => layer.name)).toEqual(
      renderLayerNames,
    );
    expect(JSON.stringify(result.client)).not.toContain("collision");
    expect(result.client.movement.obstacles).toEqual([
      { x: 32, y: 16, width: 16, height: 16 },
    ]);
    expect(result.server.collision).toEqual([
      { x: 32, y: 16, width: 16, height: 16 },
    ]);
    expect(result.server.spawns).toEqual([
      { entranceId: "village_square", kind: "player", x: 8, y: 8 },
    ]);
    expect(result.client.interactionHints).toEqual([
      { id: "notice_board", label: "Read notice", x: 20, y: 20 },
    ]);
    expect(JSON.stringify(result.server)).not.toContain("tilesets");
    expect(JSON.stringify(result.server)).not.toContain("Read notice");
  });

  it.each([...renderLayerNames, ...logicalLayerNames])(
    "rejects a missing required %s layer",
    (missingLayer) => {
      const input = validMap();
      input.layers = input.layers.filter(
        (layer) => layer.name !== missingLayer,
      );
      const result = compileVillage(input);
      expect(result).toEqual({
        success: false,
        issues: [
          {
            path: "layers",
            message: `Missing required layer: ${missingLayer}`,
          },
        ],
      });
    },
  );

  it("rejects malformed portal destinations", () => {
    const input = validMap();
    const portals = input.layers.find((layer) => layer.name === "portals");
    if (!portals || !("objects" in portals)) throw new Error("fixture");
    portals.objects = [
      {
        id: 4,
        name: "forest_path",
        type: "portal",
        x: 0,
        y: 16,
        width: 8,
        height: 16,
        properties: [
          { name: "destination_map", type: "string", value: "forest" },
          { name: "destination_entrance", type: "string", value: "entry" },
        ],
      },
    ];

    expect(compileVillage(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers.portals.objects[0].destination_map",
          message: "Portal destination must be a namespaced map ID",
        },
      ],
    });
  });

  it("rejects a player spawn outside map bounds", () => {
    const input = validMap();
    const spawns = input.layers.find((layer) => layer.name === "spawns");
    if (!spawns || !("objects" in spawns)) throw new Error("fixture");
    spawns.objects[0] = {
      ...(spawns.objects[0] as Record<string, unknown>),
      x: 1_000,
    };

    const result = compileVillage(input);
    expect(result).toEqual({
      success: false,
      issues: [
        {
          path: "layers.spawns.objects[0]",
          message: "Spawn must be inside map bounds",
        },
      ],
    });
  });

  it("rejects a map without exactly one player spawn", () => {
    const input = validMap();
    const spawns = input.layers.find((layer) => layer.name === "spawns");
    if (!spawns || !("objects" in spawns)) throw new Error("fixture");
    spawns.objects = [];

    expect(compileVillage(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers.spawns",
          message: "Exactly one player spawn is required",
        },
      ],
    });
  });

  it("rejects a player spawn inside collision geometry", () => {
    const input = validMap();
    const spawns = input.layers.find((layer) => layer.name === "spawns");
    if (!spawns || !("objects" in spawns)) throw new Error("fixture");
    spawns.objects[0] = {
      ...(spawns.objects[0] as Record<string, unknown>),
      x: 36,
      y: 20,
    };

    expect(compileVillage(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers.spawns.objects[0]",
          message: "Spawn must be reachable navigation space",
        },
      ],
    });
  });

  it("rejects a spawn whose collision body crosses the map edge", () => {
    const input = validMap();
    const spawns = input.layers.find((layer) => layer.name === "spawns");
    if (!spawns || !("objects" in spawns)) throw new Error("fixture");
    spawns.objects[0] = {
      ...(spawns.objects[0] as Record<string, unknown>),
      x: 1,
      y: 8,
    };

    expect(compileVillage(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers.spawns.objects[0]",
          message: "Spawn must be reachable navigation space",
        },
      ],
    });
  });

  it("rejects a portal with invalid geometry", () => {
    const input = validMap();
    const portals = input.layers.find((layer) => layer.name === "portals");
    if (!portals || !("objects" in portals)) throw new Error("fixture");
    portals.objects = [
      {
        id: 4,
        name: "broken_portal",
        type: "portal",
        x: 0,
        y: 0,
        width: 0,
        height: 16,
      },
    ];

    expect(compileVillage(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers.portals.objects[0]",
          message: "Portal must be a positive rectangle inside map bounds",
        },
      ],
    });
  });
});
