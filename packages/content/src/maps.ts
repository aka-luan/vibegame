import { z } from "zod";

import { formatValidationPath, type ContentValidationIssue } from "./index.js";

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

const propertySchema = z.object({
  name: z.string(),
  type: z.string(),
  value: z.unknown(),
});

const tiledObjectSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  type: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  properties: z.array(propertySchema).optional(),
});

const tileLayerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.literal("tilelayer"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.array(z.number().int().nonnegative()),
  opacity: z.number(),
  visible: z.boolean(),
  x: z.number(),
  y: z.number(),
});

const objectLayerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.literal("objectgroup"),
  objects: z.array(tiledObjectSchema),
  opacity: z.number(),
  visible: z.boolean(),
  x: z.number(),
  y: z.number(),
});

const tilesetSchema = z.object({
  firstgid: z.number().int().positive(),
  name: z.string().min(1),
  tilewidth: z.number().int().positive(),
  tileheight: z.number().int().positive(),
  tilecount: z.number().int().positive(),
  columns: z.number().int().positive(),
  image: z.string().min(1),
  imagewidth: z.number().int().positive(),
  imageheight: z.number().int().positive(),
});

const tiledMapSchema = z.object({
  type: z.literal("map"),
  version: z.string(),
  tiledversion: z.string(),
  orientation: z.literal("orthogonal"),
  renderorder: z.literal("right-down"),
  infinite: z.literal(false),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tilewidth: z.number().int().positive(),
  tileheight: z.number().int().positive(),
  layers: z.array(z.union([tileLayerSchema, objectLayerSchema])),
  tilesets: z.array(tilesetSchema).min(1),
});

type TileLayer = z.infer<typeof tileLayerSchema>;
type ObjectLayer = z.infer<typeof objectLayerSchema>;

export interface ClientMapArtifact {
  contentVersion: string;
  id: string;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TileLayer[];
  tilesets: z.infer<typeof tilesetSchema>[];
  movement: {
    bounds: { x: number; y: number; width: number; height: number };
    obstacles: { x: number; y: number; width: number; height: number }[];
    start: { x: number; y: number };
  };
  interactionHints: { id: string; label: string; x: number; y: number }[];
}

export interface ServerMapArtifact {
  contentVersion: string;
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  collision: { x: number; y: number; width: number; height: number }[];
  navigation: { x: number; y: number; width: number; height: number }[];
  interactives: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  spawns: { entranceId: string; kind: string; x: number; y: number }[];
  portals: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    destinationMapId: string;
    destinationEntranceId: string;
  }[];
}

export type MapCompilationResult =
  | { success: true; client: ClientMapArtifact; server: ServerMapArtifact }
  | { success: false; issues: ContentValidationIssue[] };

function property(object: z.infer<typeof tiledObjectSchema>, name: string) {
  return object.properties?.find((candidate) => candidate.name === name)?.value;
}

function center(object: z.infer<typeof tiledObjectSchema>) {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2,
  };
}

function containsRectangle(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function rectanglesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

export function compileTiledMap(
  mapId: string,
  contentVersion: string,
  input: unknown,
  playerCollision: {
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  },
): MapCompilationResult {
  if (!/^map:[a-z][a-z0-9_]*$/.test(mapId)) {
    return {
      success: false,
      issues: [{ path: "id", message: "Map ID must be namespaced" }],
    };
  }
  if (!/^content:[a-z][a-z0-9_]*$/.test(contentVersion)) {
    return {
      success: false,
      issues: [
        {
          path: "contentVersion",
          message: "Content version must be namespaced",
        },
      ],
    };
  }

  const parsed = tiledMapSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        path: formatValidationPath(issue.path),
        message: issue.message,
      })),
    };
  }

  const map = parsed.data;
  const requiredLayers = [...renderLayerNames, ...logicalLayerNames];
  for (const layerName of requiredLayers) {
    const matchingLayers = map.layers.filter(
      (layer) => layer.name === layerName,
    );
    if (matchingLayers.length === 0) {
      return {
        success: false,
        issues: [
          { path: "layers", message: `Missing required layer: ${layerName}` },
        ],
      };
    }
    if (matchingLayers.length > 1) {
      return {
        success: false,
        issues: [
          { path: "layers", message: `Duplicate required layer: ${layerName}` },
        ],
      };
    }
    const expectedType = renderLayerNames.includes(
      layerName as (typeof renderLayerNames)[number],
    )
      ? "tilelayer"
      : "objectgroup";
    if (matchingLayers[0]?.type !== expectedType) {
      return {
        success: false,
        issues: [
          {
            path: `layers.${layerName}`,
            message: `Layer must be a ${expectedType}`,
          },
        ],
      };
    }
  }

  for (const layer of map.layers) {
    if (
      layer.type === "tilelayer" &&
      layer.data.length !== map.width * map.height
    ) {
      return {
        success: false,
        issues: [
          {
            path: `layers.${layer.name}.data`,
            message: "Tile data length must match map dimensions",
          },
        ],
      };
    }
  }

  const objectLayer = (name: (typeof logicalLayerNames)[number]): ObjectLayer =>
    map.layers.find((layer) => layer.name === name) as ObjectLayer;
  for (const layerName of logicalLayerNames) {
    const names = new Set<string>();
    for (const object of objectLayer(layerName).objects) {
      if (names.has(object.name)) {
        return {
          success: false,
          issues: [
            {
              path: `layers.${layerName}`,
              message: `Duplicate logical object ID: ${object.name}`,
            },
          ],
        };
      }
      names.add(object.name);
    }
  }
  const logicalObjects = logicalLayerNames.flatMap(
    (name) => objectLayer(name).objects,
  );
  const objectIds = new Set<number>();
  for (const object of logicalObjects) {
    if (objectIds.has(object.id)) {
      return {
        success: false,
        issues: [
          {
            path: "layers",
            message: `Duplicate Tiled object ID: ${String(object.id)}`,
          },
        ],
      };
    }
    objectIds.add(object.id);
  }
  const mapPixelWidth = map.width * map.tilewidth;
  const mapPixelHeight = map.height * map.tileheight;
  const spawns = objectLayer("spawns").objects;
  const playerSpawns = spawns.filter((spawn) => spawn.type === "player");
  if (playerSpawns.length !== 1) {
    return {
      success: false,
      issues: [
        {
          path: "layers.spawns",
          message: "Exactly one player spawn is required",
        },
      ],
    };
  }
  for (const [index, spawn] of spawns.entries()) {
    if (
      spawn.x < 0 ||
      spawn.y < 0 ||
      spawn.x >= mapPixelWidth ||
      spawn.y >= mapPixelHeight
    ) {
      return {
        success: false,
        issues: [
          {
            path: `layers.spawns.objects[${String(index)}]`,
            message: "Spawn must be inside map bounds",
          },
        ],
      };
    }
  }
  const collisionObjects = objectLayer("collision").objects;
  const navigationObjects = objectLayer("navigation").objects;
  for (const [index, spawn] of spawns.entries()) {
    const spawnBody = {
      x: spawn.x + playerCollision.offsetX - playerCollision.width / 2,
      y: spawn.y + playerCollision.offsetY - playerCollision.height / 2,
      width: playerCollision.width,
      height: playerCollision.height,
    };
    if (
      !containsRectangle(
        { x: 0, y: 0, width: mapPixelWidth, height: mapPixelHeight },
        spawnBody,
      ) ||
      collisionObjects.some((collision) =>
        rectanglesOverlap(collision, spawnBody),
      ) ||
      !navigationObjects.some((navigation) =>
        containsRectangle(navigation, spawnBody),
      )
    ) {
      return {
        success: false,
        issues: [
          {
            path: `layers.spawns.objects[${String(index)}]`,
            message: "Spawn must be reachable navigation space",
          },
        ],
      };
    }
  }

  const portals = objectLayer("portals").objects;
  for (const [index, portal] of portals.entries()) {
    if (
      portal.type !== "portal" ||
      portal.width <= 0 ||
      portal.height <= 0 ||
      portal.x < 0 ||
      portal.y < 0 ||
      portal.x + portal.width > mapPixelWidth ||
      portal.y + portal.height > mapPixelHeight
    ) {
      return {
        success: false,
        issues: [
          {
            path: `layers.portals.objects[${String(index)}]`,
            message: "Portal must be a positive rectangle inside map bounds",
          },
        ],
      };
    }
    const destinationMap = property(portal, "destination_map");
    if (
      typeof destinationMap !== "string" ||
      !/^map:[a-z][a-z0-9_]*$/.test(destinationMap)
    ) {
      return {
        success: false,
        issues: [
          {
            path: `layers.portals.objects[${String(index)}].destination_map`,
            message: "Portal destination must be a namespaced map ID",
          },
        ],
      };
    }
    const destinationEntrance = property(portal, "destination_entrance");
    if (
      typeof destinationEntrance !== "string" ||
      !/^[a-z][a-z0-9_]*$/.test(destinationEntrance)
    ) {
      return {
        success: false,
        issues: [
          {
            path: `layers.portals.objects[${String(index)}].destination_entrance`,
            message: "Portal destination entrance must be a stable logical ID",
          },
        ],
      };
    }
    if (
      destinationMap === mapId &&
      !spawns.some((spawn) => spawn.name === destinationEntrance)
    ) {
      return {
        success: false,
        issues: [
          {
            path: `layers.portals.objects[${String(index)}].destination_entrance`,
            message: "Portal destination entrance does not exist",
          },
        ],
      };
    }
  }

  const interactions = objectLayer("interactives").objects;
  const rectangles = (layer: ObjectLayer) =>
    layer.objects.map(({ x, y, width, height }) => ({ x, y, width, height }));
  const bounds = { x: 0, y: 0, width: mapPixelWidth, height: mapPixelHeight };
  const client: ClientMapArtifact = {
    contentVersion,
    id: mapId,
    width: map.width,
    height: map.height,
    tilewidth: map.tilewidth,
    tileheight: map.tileheight,
    layers: renderLayerNames.map(
      (name) => map.layers.find((layer) => layer.name === name) as TileLayer,
    ),
    tilesets: map.tilesets,
    movement: {
      bounds,
      obstacles: rectangles(objectLayer("collision")),
      start: { x: playerSpawns[0]!.x, y: playerSpawns[0]!.y },
    },
    interactionHints: interactions.map((interactive) => ({
      id: interactive.name,
      label: String(property(interactive, "label")),
      ...center(interactive),
    })),
  };

  const server: ServerMapArtifact = {
    contentVersion,
    id: mapId,
    bounds,
    collision: rectangles(objectLayer("collision")),
    navigation: rectangles(objectLayer("navigation")),
    interactives: interactions.map(({ name: id, x, y, width, height }) => ({
      id,
      x,
      y,
      width,
      height,
    })),
    spawns: spawns.map((spawn) => ({
      entranceId: spawn.name,
      kind: spawn.type,
      x: spawn.x,
      y: spawn.y,
    })),
    portals: portals.map((portal) => ({
      id: portal.name,
      x: portal.x,
      y: portal.y,
      width: portal.width,
      height: portal.height,
      destinationMapId: String(property(portal, "destination_map")),
      destinationEntranceId: String(property(portal, "destination_entrance")),
    })),
  };

  return { success: true, client, server };
}
