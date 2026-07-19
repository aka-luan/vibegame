import { z } from "zod";

// Structured provenance record for the village side-view background image,
// following the same asset-conventions pattern as the character rig manifest
// (see `@gameish/content`'s `character-manifest.ts` for prior art). The SVG
// itself carries the same facts in its `<metadata>` element for humans
// opening the file directly; this manifest is the canonical, machine-checked
// record required by AGENTS.md's asset conventions.

export const backgroundAssetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^background:[a-z][a-z0-9_]*$/),
  assetVersion: z.string().min(1),
  path: z.string().min(1),
  dimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  provenance: z.object({
    license: z.string().min(1),
    creator: z.string().min(1),
    source: z.string().min(1),
    exportTool: z.string().min(1),
    exportToolVersion: z.string().min(1),
    assetVersion: z.string().min(1),
    dimensions: z.string().min(1),
    layout: z.string().min(1),
    replacementCompatibility: z.string().min(1),
  }),
});

export type BackgroundAssetManifest = z.infer<
  typeof backgroundAssetManifestSchema
>;

export type BackgroundAssetManifestValidationResult =
  | { success: true }
  | { success: false; issues: string[] };

export function validateBackgroundAssetManifest(
  input: unknown,
): BackgroundAssetManifestValidationResult {
  const result = backgroundAssetManifestSchema.safeParse(input);
  if (result.success) {
    if (result.data.provenance.assetVersion !== result.data.assetVersion) {
      return {
        success: false,
        issues: ["Provenance asset version must match the manifest"],
      };
    }
    if (
      result.data.provenance.dimensions !==
      `${String(result.data.dimensions.width)}x${String(result.data.dimensions.height)}`
    ) {
      return {
        success: false,
        issues: ["Provenance dimensions must match the manifest dimensions"],
      };
    }
    return { success: true };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => issue.message),
  };
}

// Canonical provenance record for `public/assets/village-background.svg`.
// Update this alongside the SVG's own `<metadata>` element if the asset
// changes.
export const villageBackgroundManifest: BackgroundAssetManifest = {
  schemaVersion: 1,
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
      "Any production replacement must be a 1504x400 full-scene side-view " +
      "image with sky above the horizon line and walkable ground below it, " +
      "matching the village map's compiled client dimensions.",
  },
};
