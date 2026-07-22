import { z } from "zod";

import { formatValidationPath, type ContentValidationIssue } from "./index.js";

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

const pointSchema = z.object({ x: z.number(), y: z.number() });
const animationSchema = z.object({
  frames: z.array(z.number().int().nonnegative()).min(1),
  frameDurationMs: z.number().int().positive(),
  loop: z.boolean(),
});

export const characterManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^rig:[a-z][a-z0-9_]*$/),
    rigVersion: z.string().min(1),
    canvas: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    displayScale: z.number().positive(),
    footOrigin: pointSchema,
    collision: z.object({
      offsetX: z.number(),
      offsetY: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    facings: z.object({
      east: z.object({ row: z.number().int().nonnegative() }),
      west: z.union([
        z.object({ row: z.number().int().nonnegative() }),
        z.object({ mirror: z.literal("east") }),
      ]),
    }),
    animations: z.record(z.string(), animationSchema),
    attachments: z.record(z.string(), pointSchema),
    layers: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9_]*$/),
          depth: z.number(),
          fallback: z.string().nullable(),
          source: z
            .object({
              kind: z.literal("embedded_png"),
              dataUri: z
                .string()
                .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
              frameColumns: z.number().int().positive(),
              frameRows: z.number().int().positive(),
            })
            .nullable(),
        }),
      )
      .min(1),
    provenance: z.object({
      license: z.string().min(1),
      creator: z.string().min(1),
      source: z.string().min(1),
      exportTool: z.string().min(1),
      exportToolVersion: z.string().min(1),
      rigVersion: z.string().min(1),
      dimensions: z.string().min(1),
      frameArrangement: z.string().min(1),
      replacementCompatibility: z.string().min(1),
    }),
  })
  .superRefine((manifest, context) => {
    if (
      manifest.footOrigin.x < 0 ||
      manifest.footOrigin.y < 0 ||
      manifest.footOrigin.x > manifest.canvas.width ||
      manifest.footOrigin.y > manifest.canvas.height
    ) {
      context.addIssue({
        code: "custom",
        path: ["footOrigin"],
        message: "Foot origin must be inside the logical canvas",
      });
    }

    for (const animation of requiredAnimations) {
      if (!(animation in manifest.animations)) {
        context.addIssue({
          code: "custom",
          path: ["animations", animation],
          message: "Required animation is missing",
        });
      }
    }

    const layerIds = new Set(manifest.layers.map((layer) => layer.id));
    if (layerIds.size !== manifest.layers.length) {
      context.addIssue({
        code: "custom",
        path: ["layers"],
        message: "Layer identifiers must be unique",
      });
    }
    manifest.layers.forEach((layer, index) => {
      if (layer.fallback !== null && !layerIds.has(layer.fallback)) {
        context.addIssue({
          code: "custom",
          path: ["layers", index, "fallback"],
          message: `Fallback layer does not exist: ${layer.fallback}`,
        });
      }
      if (layer.source === null && layer.fallback === null) {
        context.addIssue({
          code: "custom",
          path: ["layers", index, "source"],
          message: "A layer without a source must declare a fallback",
        });
      }
    });

    for (const [index, layer] of manifest.layers.entries()) {
      const visited = new Set([layer.id]);
      let fallback = layer.fallback;
      while (fallback !== null) {
        if (visited.has(fallback)) {
          context.addIssue({
            code: "custom",
            path: ["layers", index, "fallback"],
            message: "Layer fallbacks must not contain a cycle",
          });
          break;
        }
        visited.add(fallback);
        fallback =
          manifest.layers.find((candidate) => candidate.id === fallback)
            ?.fallback ?? null;
      }
    }

    const resolveSource = (layerId: string) => {
      const visited = new Set<string>();
      let current = manifest.layers.find((layer) => layer.id === layerId);
      while (current && !visited.has(current.id)) {
        if (current.source) return current.source;
        visited.add(current.id);
        current = manifest.layers.find(
          (layer) => layer.id === current?.fallback,
        );
      }
      return undefined;
    };
    const effectiveSources = manifest.layers.map((layer) =>
      resolveSource(layer.id),
    );
    const expectedSource = effectiveSources.find(
      (source) => source !== undefined,
    );
    effectiveSources.forEach((source, index) => {
      if (!source || !expectedSource) return;
      const hasInvalidFacing = Object.values(manifest.facings).some(
        (definition) =>
          "row" in definition && definition.row >= source.frameRows,
      );
      const hasInvalidAnimation = Object.values(manifest.animations).some(
        (animation) =>
          animation.frames.some((frame) => frame >= source.frameColumns),
      );
      if (
        hasInvalidFacing ||
        hasInvalidAnimation ||
        source.frameColumns !== expectedSource.frameColumns ||
        source.frameRows !== expectedSource.frameRows
      ) {
        context.addIssue({
          code: "custom",
          path: ["layers", index, "source"],
          message: "Layer sprite sheet is incompatible with the canonical rig",
        });
      }
    });

    if (manifest.provenance.rigVersion !== manifest.rigVersion) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "rigVersion"],
        message: "Provenance rig version must match the manifest",
      });
    }
  });

export type CharacterManifest = z.infer<typeof characterManifestSchema>;

export interface CharacterAppearanceSelection {
  rigId: string;
  baseLayerId: string;
  armorLayerId: string;
}

/**
 * Resolve the same ordered layer selection for previews and world entities.
 * Unknown optional armor is treated as unequipped so a stale or missing asset
 * cannot take down the renderer. The manifest's layer fallback still decides
 * which source supplies the pixels.
 */
export function resolveAppearanceLayerIds(
  manifest: {
    id: string;
    layers: readonly { id: string; depth: number }[];
  },
  appearance: CharacterAppearanceSelection,
): string[] {
  if (appearance.rigId !== manifest.id) return [];
  const baseLayer = manifest.layers.find(
    (layer) => layer.id === appearance.baseLayerId,
  );
  const fallbackBase =
    baseLayer ?? manifest.layers.find((layer) => layer.id === "base");
  if (!fallbackBase) return [];

  const requested = [fallbackBase.id];
  if (
    appearance.armorLayerId &&
    appearance.armorLayerId !== fallbackBase.id &&
    manifest.layers.some((layer) => layer.id === appearance.armorLayerId)
  ) {
    requested.push(appearance.armorLayerId);
  }
  return requested.sort((first, second) => {
    const firstDepth = manifest.layers.find(
      (layer) => layer.id === first,
    )?.depth;
    const secondDepth = manifest.layers.find(
      (layer) => layer.id === second,
    )?.depth;
    return (firstDepth ?? 0) - (secondDepth ?? 0);
  });
}

export type CharacterManifestValidationResult =
  { success: true } | { success: false; issues: ContentValidationIssue[] };

export function validateCharacterManifest(
  input: unknown,
): CharacterManifestValidationResult {
  const result = characterManifestSchema.safeParse(input);
  if (result.success) return { success: true };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: formatValidationPath(issue.path),
      message: issue.message,
    })),
  };
}
