import { z } from "zod";

const itemId = z.string().regex(/^item:[a-z][a-z0-9_]*$/);

const equipmentItemSchema = z.object({
  id: itemId,
  slot: z.literal("body"),
  clientVisible: z.object({
    displayName: z.string().trim().min(1),
    layerId: z.string().regex(/^[a-z][a-z0-9_]*$/),
  }),
  serverOnly: z.object({
    rigId: z.string().regex(/^rig:[a-z][a-z0-9_]*$/),
    requirements: z
      .object({
        minimumLevel: z.number().int().positive().optional(),
        classId: z
          .string()
          .regex(/^class:[a-z][a-z0-9_]*$/)
          .optional(),
      })
      .strict(),
  }),
});

export const equipmentCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(equipmentItemSchema).min(1),
  })
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    catalog.items.forEach((item, index) => {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: `Duplicate equipment item identifier: ${item.id}`,
        });
      }
      ids.add(item.id);
    });
  });

export type EquipmentCatalog = z.infer<typeof equipmentCatalogSchema>;
export type EquipmentItemDefinition = EquipmentCatalog["items"][number];

export interface EquipmentManifestReference {
  id: string;
  layers: readonly { id: string }[];
}

export interface ClientEquipmentCatalog {
  schemaVersion: 1;
  items: {
    id: string;
    slot: "body";
    displayName: string;
    layerId: string;
  }[];
}

export type EquipmentRequirements = NonNullable<
  EquipmentItemDefinition["serverOnly"]["requirements"]
>;

export function compileClientEquipmentCatalog(
  catalog: EquipmentCatalog,
): ClientEquipmentCatalog {
  return {
    schemaVersion: 1,
    items: catalog.items.map((item) => ({
      id: item.id,
      slot: item.slot,
      displayName: item.clientVisible.displayName,
      layerId: item.clientVisible.layerId,
    })),
  };
}

export function validateEquipmentCatalog(
  input: unknown,
):
  | { success: true; data: EquipmentCatalog }
  | { success: false; issues: { path: string; message: string }[] } {
  const result = equipmentCatalogSchema.safeParse(input);
  if (result.success) return result;
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

export function validateEquipmentManifestCompatibility(
  catalog: { items: readonly EquipmentItemDefinition[] },
  manifest: EquipmentManifestReference,
): { path: string; message: string }[] {
  const layerIds = new Set(manifest.layers.map((layer) => layer.id));
  const issues: { path: string; message: string }[] = [];
  catalog.items.forEach((item, index) => {
    if (item.serverOnly.rigId !== manifest.id) {
      issues.push({
        path: `items.${index}.serverOnly.rigId`,
        message: `Equipment rig does not match the canonical character manifest: ${item.serverOnly.rigId}`,
      });
    }
    if (!layerIds.has(item.clientVisible.layerId)) {
      issues.push({
        path: `items.${index}.clientVisible.layerId`,
        message: `Equipment layer does not exist in the canonical character manifest: ${item.clientVisible.layerId}`,
      });
    }
  });
  return issues;
}
