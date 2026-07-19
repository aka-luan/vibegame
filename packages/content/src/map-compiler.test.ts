import { describe, expect, it } from "vitest";

import villageMapSource from "../maps/village.tiled.json" with { type: "json" };
import { compileTiledMap } from "./maps.js";

type FixtureObject = {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  properties?: { name: string; type: string; value: unknown }[];
};

type FixtureLayer = {
  id: number;
  name: string;
  type: string;
  objects?: FixtureObject[];
  [key: string]: unknown;
};

type FixtureMap = {
  layers: FixtureLayer[];
  [key: string]: unknown;
};

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

function validMap(): FixtureMap {
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
  } as FixtureMap;
}

describe("Tiled map compiler", () => {
  const compileVillage = (input: unknown) =>
    compileTiledMap("map:village", "content:test_v1", input, {
      offsetX: 0,
      offsetY: -3,
      width: 10,
      height: 7,
    });

  it("compiles the re-authored village as a wide side-view scene", () => {
    const result = compileVillage(villageMapSource);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.client.width * result.client.tilewidth).toBe(1504);
    expect(result.client.height * result.client.tileheight).toBe(400);
    expect(result.client.layers[0]).toMatchObject({
      name: "background",
      type: "imagelayer",
      image: "village-background.svg",
    });
    expect(result.server.bounds).toEqual({
      x: 0,
      y: 256,
      width: 1504,
      height: 128,
    });
    expect(result.server.spawns).toEqual([
      { entranceId: "village_square", kind: "player", x: 128, y: 320 },
      {
        entranceId: "mossback_encounter",
        kind: "monster",
        x: 300,
        y: 320,
      },
    ]);
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

  it("keeps a painted image background in the client artifact", () => {
    const input = validMap();
    input.layers[0] = {
      id: 1,
      name: "background",
      type: "imagelayer",
      image: "village-background.svg",
      opacity: 1,
      visible: true,
      x: 0,
      y: 0,
    };

    const result = compileVillage(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.client.layers[0]).toMatchObject({
      name: "background",
      type: "imagelayer",
      image: "village-background.svg",
    });
    expect(JSON.stringify(result.server)).not.toContain(
      "village-background.svg",
    );
  });

  it("rejects a background image whose declared size does not match the map", () => {
    const input = validMap();
    input.layers[0] = {
      id: 1,
      name: "background",
      type: "imagelayer",
      image: "village-background.svg",
      imagewidth: 999,
      imageheight: 999,
      opacity: 1,
      visible: true,
      x: 0,
      y: 0,
    };

    expect(compileVillage(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers.background",
          message: "Background image dimensions must match the map pixel size",
        },
      ],
    });
  });

  it("accepts a background image whose declared size matches the map", () => {
    const input = validMap();
    input.layers[0] = {
      id: 1,
      name: "background",
      type: "imagelayer",
      image: "village-background.svg",
      imagewidth: 64,
      imageheight: 48,
      opacity: 1,
      visible: true,
      x: 0,
      y: 0,
    };

    const result = compileVillage(input);
    expect(result.success).toBe(true);
  });

  it("rejects an image layer outside the background role", () => {
    const input = validMap();
    input.layers[1] = {
      id: 2,
      name: "ground",
      type: "imagelayer",
      image: "village-background.svg",
      opacity: 1,
      visible: true,
      x: 0,
      y: 0,
    };

    expect(compileVillage(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers.ground",
          message: "Layer must be a tilelayer",
        },
      ],
    });
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
      ...spawns.objects[0]!,
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
      ...spawns.objects[0]!,
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
      ...spawns.objects[0]!,
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

  it.each(["interactives", "portals"] as const)(
    "rejects a %s placement outside the walkable ground region",
    (layerName) => {
      const input = validMap();
      const navigation = input.layers.find(
        (candidate) => candidate.name === "navigation",
      );
      if (!navigation || !("objects" in navigation)) throw new Error("fixture");
      navigation.objects[0]!.height = 24;
      const layer = input.layers.find(
        (candidate) => candidate.name === layerName,
      );
      if (!layer || !("objects" in layer)) throw new Error("fixture");
      layer.objects.push(
        layerName === "interactives"
          ? {
              id: 20,
              name: "sky_notice",
              type: "interaction",
              x: 16,
              y: 32,
              width: 8,
              height: 8,
            }
          : {
              id: 21,
              name: "sky_exit",
              type: "portal",
              x: 16,
              y: 32,
              width: 8,
              height: 8,
              properties: [
                {
                  name: "destination_map",
                  type: "string",
                  value: "map:forest",
                },
                {
                  name: "destination_entrance",
                  type: "string",
                  value: "forest_entry",
                },
              ],
            },
      );

      const result = compileVillage(input);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.issues[0]?.message).toBe(
        layerName === "interactives"
          ? "Interactive must be inside walkable ground region"
          : "Portal must be inside walkable ground region",
      );
    },
  );

  it("rejects a non-player spawn outside the walkable ground region", () => {
    const input = validMap();
    const navigation = input.layers.find(
      (candidate) => candidate.name === "navigation",
    );
    const spawns = input.layers.find(
      (candidate) => candidate.name === "spawns",
    );
    if (!navigation || !navigation.objects || !spawns || !spawns.objects) {
      throw new Error("fixture");
    }
    navigation.objects[0]!.height = 24;
    spawns.objects.push({
      id: 22,
      name: "sky_monster",
      type: "monster",
      x: 16,
      y: 32,
      width: 0,
      height: 0,
    });

    expect(compileVillage(input)).toEqual({
      success: false,
      issues: [
        {
          path: "layers.spawns.objects[1]",
          message: "Spawn must be inside walkable ground region",
        },
      ],
    });
  });

  it("accepts a placement straddling the seam between two abutting navigation rectangles", () => {
    const input = validMap();
    const navigation = input.layers.find(
      (candidate) => candidate.name === "navigation",
    );
    if (!navigation || !("objects" in navigation)) throw new Error("fixture");
    navigation.objects = [
      {
        id: 6,
        name: "walkable_west",
        type: "navigation",
        x: 0,
        y: 0,
        width: 32,
        height: 48,
      },
      {
        id: 23,
        name: "walkable_east",
        type: "navigation",
        x: 32,
        y: 0,
        width: 32,
        height: 48,
      },
    ];
    const interactives = input.layers.find(
      (candidate) => candidate.name === "interactives",
    );
    if (!interactives || !("objects" in interactives)) {
      throw new Error("fixture");
    }
    interactives.objects[0] = {
      ...interactives.objects[0]!,
      x: 24,
      y: 16,
      width: 16,
      height: 8,
    };

    const result = compileVillage(input);
    expect(result.success).toBe(true);
  });
});
