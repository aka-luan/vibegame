import { assertCanonicalContent } from "./canonical.js";

try {
  await assertCanonicalContent();
  console.log("Content validation passed: content/foundation.json");
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Canonical content validation failed",
  );
  process.exitCode = 1;
}
