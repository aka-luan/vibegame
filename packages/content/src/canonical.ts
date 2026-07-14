import { readFile } from "node:fs/promises";

import { validateContent } from "./index.js";

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
}
