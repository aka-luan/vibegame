import { readFile } from "node:fs/promises";

import { characterManifestSchema } from "./character-manifest.js";
import {
  equipmentCatalogSchema,
  validateEquipmentManifestCompatibility,
} from "./equipment.js";
import { contentSchema, validateContent } from "./index.js";

const canonicalContentUrl = new URL(
  "../content/foundation.json",
  import.meta.url,
);

export async function assertCanonicalContent(): Promise<void> {
  const input: unknown = JSON.parse(
    await readFile(canonicalContentUrl, "utf8"),
  );
  const result = validateContent(input);
  if (!result.success) {
    const details = result.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n");
    throw new Error(`Canonical content validation failed:\n${details}`);
  }
  const equipment = equipmentCatalogSchema.parse(
    contentSchema.parse(input).equipment,
  );
  const manifest = characterManifestSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../manifests/village-character.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const compatibilityIssues = validateEquipmentManifestCompatibility(
    equipment,
    manifest,
  );
  if (compatibilityIssues.length > 0) {
    const details = compatibilityIssues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n");
    throw new Error(`Canonical equipment validation failed:\n${details}`);
  }
}
