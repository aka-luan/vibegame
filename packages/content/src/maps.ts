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

const imageLayerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.literal("imagelayer"),
  image: z.string().min(1),
  imagewidth: z.number().int().positive().optional(),
  imageheight: z.number().int().positive().optional(),
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
  layers: z.array(
    z.union([tileLayerSchema, imageLayerSchema, objectLayerSchema]),
  ),
  tilesets: z.array(tilesetSchema).min(1),
});

type TileLayer = z.infer<typeof tileLayerSchema>;
type ImageLayer = z.infer<typeof imageLayerSchema>;
type ObjectLayer = z.infer<typeof objectLayerSchema>;
type RenderLayer = TileLayer | ImageLayer;

export interface ClientMapArtifact {
  contentVersion: string;
  id: string;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: RenderLayer[];
  tilesets: z.infer<typeof tilesetSchema>[];
  movement: {
    bounds: { x: number; y: number; width: number; height: number };
    obstacles: { x: number; y: number; width: number; height: number }[];
    start: { x: number; y: number };
  };
  interactionHints: { id: string; label: string; x: number; y: number }[];
  portalHints: { id: string; label: string; x: number; y: number }[];
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
    label: string;
    locked: boolean;
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

function boundingBox(
  rectangles: { x: number; y: number; width: number; height: number }[],
): { x: number; y: number; width: number; height: number } {
  const minX = Math.min(...rectangles.map((rectangle) => rectangle.x));
  const minY = Math.min(...rectangles.map((rectangle) => rectangle.y));
  const maxX = Math.max(
    ...rectangles.map((rectangle) => rectangle.x + rectangle.width),
  );
  const maxY = Math.max(
    ...rectangles.map((rectangle) => rectangle.y + rectangle.height),
  );
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Whether the union of `regions` fully covers `target`, so a placement
 * straddling the seam between two abutting rectangles still counts as
 * inside. Splits `target` into a coordinate-compressed grid of cells and
 * requires each cell to be contained by at least one region.
 */
function coversRectangle(
  regions: { x: number; y: number; width: number; height: number }[],
  target: { x: number; y: number; width: number; height: number },
): boolean {
  if (target.width === 0 || target.height === 0) {
    return regions.some((region) => containsRectangle(region, target));
  }

  const targetRight = target.x + target.width;
  const targetBottom = target.y + target.height;
  const xs = new Set<number>([target.x, targetRight]);
  const ys = new Set<number>([target.y, targetBottom]);
  for (const region of regions) {
    const regionRight = region.x + region.width;
    const regionBottom = region.y + region.height;
    if (region.x > target.x && region.x < targetRight) xs.add(region.x);
    if (regionRight > target.x && regionRight < targetRight) {
      xs.add(regionRight);
    }
    if (region.y > target.y && region.y < targetBottom) ys.add(region.y);
    if (regionBottom > target.y && regionBottom < targetBottom) {
      ys.add(regionBottom);
    }
  }
  const sortedXs = [...xs].sort((first, second) => first - second);
  const sortedYs = [...ys].sort((first, second) => first - second);

  for (let i = 0; i < sortedXs.length - 1; i += 1) {
    const cellLeft = sortedXs[i]!;
    const cellRight = sortedXs[i + 1]!;
    for (let j = 0; j < sortedYs.length - 1; j += 1) {
      const cellTop = sortedYs[j]!;
      const cellBottom = sortedYs[j + 1]!;
      const cellCovered = regions.some(
        (region) =>
          region.x <= cellLeft &&
          region.x + region.width >= cellRight &&
          region.y <= cellTop &&
          region.y + region.height >= cellBottom,
      );
      if (!cellCovered) return false;
    }
  }
  return true;
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
  const mapPixelWidth = map.width * map.tilewidth;
  const mapPixelHeight = map.height * map.tileheight;
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
    const isRenderLayer = renderLayerNames.includes(
      layerName as (typeof renderLayerNames)[number],
    );
    const isBackgroundLayer = layerName === "background";
    const actualType = matchingLayers[0]?.type;
    const validRenderLayer = isBackgroundLayer
      ? actualType === "tilelayer" || actualType === "imagelayer"
      : actualType === "tilelayer";
    const validLogicalLayer = actualType === "objectgroup";
    if (
      (isRenderLayer && !validRenderLayer) ||
      (!isRenderLayer && !validLogicalLayer)
    ) {
      return {
        success: false,
        issues: [
          {
            path: `layers.${layerName}`,
            message: isRenderLayer
              ? isBackgroundLayer
                ? "Layer must be a tilelayer or imagelayer"
                : "Layer must be a tilelayer"
              : "Layer must be a objectgroup",
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
    if (layer.type === "imagelayer") {
      const { imagewidth, imageheight } = layer;
      const dimensionsDeclared =
        imagewidth !== undefined || imageheight !== undefined;
      const dimensionsMatchMap =
        imagewidth === mapPixelWidth && imageheight === mapPixelHeight;
      if (dimensionsDeclared && !dimensionsMatchMap) {
        return {
          success: false,
          issues: [
            {
              path: `layers.${layer.name}`,
              message:
                "Background image dimensions must match the map pixel size",
            },
          ],
        };
      }
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
  if (navigationObjects.length === 0) {
    return {
      success: false,
      issues: [
        {
          path: "layers.navigation",
          message: "At least one navigation rectangle is required",
        },
      ],
    };
  }
  const insideWalkableGroundRegion = (rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => coversRectangle(navigationObjects, rectangle);
  const requireInsideWalkableGroundRegion = (
    object: { x: number; y: number; width: number; height: number },
    path: string,
    message: string,
  ): ContentValidationIssue[] | null =>
    insideWalkableGroundRegion(object) ? null : [{ path, message }];
  for (const [index, spawn] of spawns.entries()) {
    const requiresReachability =
      spawn.type === "player" || spawn.type === "entrance";
    if (!requiresReachability) {
      const regionIssues = requireInsideWalkableGroundRegion(
        spawn,
        `layers.spawns.objects[${String(index)}]`,
        "Spawn must be inside walkable ground region",
      );
      if (regionIssues) return { success: false, issues: regionIssues };
      continue;
    }
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
      !insideWalkableGroundRegion(spawnBody)
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
    const portalRegionIssues = requireInsideWalkableGroundRegion(
      portal,
      `layers.portals.objects[${String(index)}]`,
      "Portal must be inside walkable ground region",
    );
    if (portalRegionIssues) {
      return { success: false, issues: portalRegionIssues };
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
    const label = property(portal, "label");
    if (typeof label !== "string" || label.length === 0) {
      return {
        success: false,
        issues: [
          {
            path: `layers.portals.objects[${String(index)}].label`,
            message: "Portal must declare a non-empty label",
          },
        ],
      };
    }
    const locked = property(portal, "locked");
    if (locked !== undefined && typeof locked !== "boolean") {
      return {
        success: false,
        issues: [
          {
            path: `layers.portals.objects[${String(index)}].locked`,
            message: "Portal locked property must be a boolean",
          },
        ],
      };
    }
  }

  const interactions = objectLayer("interactives").objects;
  for (const [index, interactive] of interactions.entries()) {
    const interactiveRegionIssues = requireInsideWalkableGroundRegion(
      interactive,
      `layers.interactives.objects[${String(index)}]`,
      "Interactive must be inside walkable ground region",
    );
    if (interactiveRegionIssues) {
      return { success: false, issues: interactiveRegionIssues };
    }
  }
  const rectangles = (layer: ObjectLayer) =>
    layer.objects.map(({ x, y, width, height }) => ({ x, y, width, height }));
  const bounds = boundingBox(rectangles(objectLayer("navigation")));
  const client: ClientMapArtifact = {
    contentVersion,
    id: mapId,
    width: map.width,
    height: map.height,
    tilewidth: map.tilewidth,
    tileheight: map.tileheight,
    layers: renderLayerNames.map(
      (name) => map.layers.find((layer) => layer.name === name) as RenderLayer,
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
    portalHints: portals.map((portal) => ({
      id: portal.name,
      label: String(property(portal, "label")),
      ...center(portal),
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
      label: String(property(portal, "label")),
      locked: property(portal, "locked") === true,
      destinationMapId: String(property(portal, "destination_map")),
      destinationEntranceId: String(property(portal, "destination_entrance")),
    })),
  };

  return { success: true, client, server };
}

/**
 * Cross-map validation for portal destinations: the in-map entrance check in
 * `compileTiledMap` only fires when a portal's destination map is the map
 * currently being compiled, since a single-map compile cannot see other
 * maps' spawns. This validates every portal's destination map is known, its
 * destination entrance exists on that map, and both maps share the same
 * content version (so a transition ticket bound to the source's content
 * version stays valid on arrival).
 */
export function validatePortalDestinations(
  maps: ServerMapArtifact[],
): ContentValidationIssue[] {
  const byId = new Map(maps.map((map) => [map.id, map]));
  const issues: ContentValidationIssue[] = [];
  for (const map of maps) {
    for (const portal of map.portals) {
      const destination = byId.get(portal.destinationMapId);
      if (!destination) {
        issues.push({
          path: `${map.id}.portals.${portal.id}.destinationMapId`,
          message: `Unknown destination map: ${portal.destinationMapId}`,
        });
        continue;
      }
      if (destination.contentVersion !== map.contentVersion) {
        issues.push({
          path: `${map.id}.portals.${portal.id}.destinationMapId`,
          message: `Destination map content version mismatch: ${destination.contentVersion} !== ${map.contentVersion}`,
        });
      }
      if (
        !destination.spawns.some(
          (spawn) => spawn.entranceId === portal.destinationEntranceId,
        )
      ) {
        issues.push({
          path: `${map.id}.portals.${portal.id}.destinationEntranceId`,
          message: `Destination entrance does not exist: ${portal.destinationEntranceId}`,
        });
      }
    }
  }
  return issues;
}
