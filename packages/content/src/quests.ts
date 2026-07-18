import { z } from "zod";

const namespacedId = (namespace: string) =>
  z.string().regex(new RegExp(`^${namespace}:[a-z][a-z0-9_]*$`));

const questObjectiveSchema = z.object({
  kind: z.literal("kill"),
  targetId: namespacedId("monster"),
  requiredCount: z.number().int().positive().max(100),
});

const questRewardSchema = z.object({
  itemId: namespacedId("item"),
  quantity: z.number().int().positive().max(100),
  experience: z.number().int().nonnegative().max(1_000_000),
  currency: z.number().int().nonnegative().max(1_000_000),
});

const questDefinitionSchema = z.object({
  id: namespacedId("quest"),
  clientVisible: z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    requiredCount: z.number().int().positive().max(100),
    guidance: z.object({
      label: z.string().trim().min(1).max(120),
      targetId: z.string().trim().min(1).max(120),
    }),
  }),
  serverOnly: z.object({
    objective: questObjectiveSchema,
    reward: questRewardSchema,
  }),
});

export const questCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    quests: z.array(questDefinitionSchema).min(1),
  })
  .superRefine((catalog, context) => {
    const identifiers = new Set<string>();
    catalog.quests.forEach((quest, index) => {
      if (identifiers.has(quest.id)) {
        context.addIssue({
          code: "custom",
          path: ["quests", index, "id"],
          message: `Duplicate quest identifier: ${quest.id}`,
        });
      }
      identifiers.add(quest.id);
    });
  });

export type QuestCatalog = z.infer<typeof questCatalogSchema>;
export type QuestDefinition = QuestCatalog["quests"][number];
export type QuestObjective = QuestDefinition["serverOnly"]["objective"];
export type QuestReward = QuestDefinition["serverOnly"]["reward"];

export interface ClientQuestCatalog {
  schemaVersion: 1;
  quests: {
    id: string;
    title: string;
    description: string;
    guidance: { label: string; targetId: string };
    requiredCount: number;
  }[];
}

export function compileClientQuestCatalog(
  catalog: QuestCatalog,
): ClientQuestCatalog {
  return {
    schemaVersion: 1,
    quests: catalog.quests.map((quest) => ({
      id: quest.id,
      title: quest.clientVisible.title,
      description: quest.clientVisible.description,
      guidance: quest.clientVisible.guidance,
      requiredCount: quest.clientVisible.requiredCount,
    })),
  };
}

export function validateQuestCatalog(
  input: unknown,
):
  | { success: true; data: QuestCatalog }
  | { success: false; issues: { path: string; message: string }[] } {
  const result = questCatalogSchema.safeParse(input);
  if (result.success) return result;
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}
