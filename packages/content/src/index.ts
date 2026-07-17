import { z } from "zod";

import { combatCatalogSchema } from "./combat.js";

const namespacedId = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/,
    "Must be a namespaced lowercase identifier such as objective:sample",
  );

const contentDefinition = z.object({
  id: namespacedId,
  tags: z.array(z.string().trim().min(1)),
  references: z.array(namespacedId),
  clientVisible: z.object({
    displayName: z.string().trim().min(1),
  }),
  serverOnly: z.object({
    developmentOnly: z.boolean(),
  }),
});

export const contentSchema = z
  .object({
    schemaVersion: z.literal(1),
    definitions: z.array(contentDefinition),
    combat: combatCatalogSchema.optional(),
  })
  .superRefine((content, context) => {
    const identifiers = new Set(
      content.definitions.map((definition) => definition.id),
    );
    const encounteredIdentifiers = new Set<string>();
    content.definitions.forEach((definition, index) => {
      if (encounteredIdentifiers.has(definition.id)) {
        context.addIssue({
          code: "custom",
          path: ["definitions", index, "id"],
          message: `Duplicate content identifier: ${definition.id}`,
        });
      }
      encounteredIdentifiers.add(definition.id);
      definition.references.forEach((reference, referenceIndex) => {
        if (!identifiers.has(reference)) {
          context.addIssue({
            code: "custom",
            path: ["definitions", index, "references", referenceIndex],
            message: `Missing content reference: ${reference}`,
          });
        }
      });
    });
    content.combat?.loot.forEach((loot, lootIndex) => {
      loot.entries.forEach((entry, entryIndex) => {
        if (!identifiers.has(entry.id)) {
          context.addIssue({
            code: "custom",
            path: ["combat", "loot", lootIndex, "entries", entryIndex, "id"],
            message: `Missing loot item reference: ${entry.id}`,
          });
        }
      });
    });
  });

export interface ContentValidationIssue {
  path: string;
  message: string;
}

export type ContentValidationResult =
  { success: true } | { success: false; issues: ContentValidationIssue[] };

export function formatValidationPath(path: PropertyKey[]): string {
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") {
      return `${formatted}[${String(segment)}]`;
    }

    return formatted.length === 0
      ? String(segment)
      : `${formatted}.${String(segment)}`;
  }, "");
}

export function validateContent(input: unknown): ContentValidationResult {
  const result = contentSchema.safeParse(input);

  if (result.success) {
    return { success: true };
  }

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: formatValidationPath(issue.path),
      message: issue.message,
    })),
  };
}
