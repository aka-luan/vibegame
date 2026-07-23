import { z } from "zod";

const namespacedId = (namespace: string) =>
  z.string().regex(new RegExp(`^${namespace}:[a-z][a-z0-9_]*$`));

export const questObjectiveKindSchema = z.enum([
  "kill",
  "speak",
  "visit",
  "interact",
  "collect",
]);

export type QuestObjectiveKind = z.infer<typeof questObjectiveKindSchema>;

const requiredCount = z.number().int().positive().max(100);

const questObjectiveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("kill"),
    targetId: namespacedId("monster"),
    requiredCount,
  }),
  z.object({
    kind: z.literal("speak"),
    targetId: namespacedId("npc"),
    requiredCount,
  }),
  z.object({
    kind: z.literal("visit"),
    targetId: namespacedId("map"),
    requiredCount,
  }),
  z.object({
    kind: z.literal("interact"),
    targetId: namespacedId("interactive"),
    requiredCount,
  }),
  z.object({
    kind: z.literal("collect"),
    targetId: namespacedId("item"),
    requiredCount,
  }),
]);

const questMarkerSchema = z.object({
  id: namespacedId("marker"),
  label: z.string().trim().min(1).max(120),
  targetId: z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/),
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
    objectiveKind: questObjectiveKindSchema,
    requiredCount,
    guidance: z
      .object({
        label: z.string().trim().min(1).max(120),
        targetId: z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/),
      })
      .optional(),
    markers: z.array(questMarkerSchema).max(8).optional(),
  }),
  serverOnly: z.object({
    objective: questObjectiveSchema,
    prerequisites: z.array(namespacedId("quest")).max(5).default([]),
    reward: questRewardSchema,
  }),
});

export const questCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    quests: z.array(questDefinitionSchema).min(1).max(5),
  })
  .superRefine((catalog, context) => {
    const identifiers = new Set(catalog.quests.map((quest) => quest.id));
    const seenIdentifiers = new Set<string>();
    const questIndexes = new Map<string, number>();
    catalog.quests.forEach((quest, index) => {
      if (seenIdentifiers.has(quest.id)) {
        context.addIssue({
          code: "custom",
          path: ["quests", index, "id"],
          message: `Duplicate quest identifier: ${quest.id}`,
        });
      }
      seenIdentifiers.add(quest.id);
      questIndexes.set(quest.id, index);

      if (
        quest.clientVisible.objectiveKind !== quest.serverOnly.objective.kind
      ) {
        context.addIssue({
          code: "custom",
          path: ["quests", index, "clientVisible", "objectiveKind"],
          message: "Client objective kind must match the server objective",
        });
      }
      if (
        quest.clientVisible.requiredCount !==
        quest.serverOnly.objective.requiredCount
      ) {
        context.addIssue({
          code: "custom",
          path: ["quests", index, "clientVisible", "requiredCount"],
          message: "Client required count must match the server objective",
        });
      }

      const prerequisites = new Set<string>();
      quest.serverOnly.prerequisites.forEach(
        (prerequisiteId, prerequisiteIndex) => {
          if (prerequisites.has(prerequisiteId)) {
            context.addIssue({
              code: "custom",
              path: [
                "quests",
                index,
                "serverOnly",
                "prerequisites",
                prerequisiteIndex,
              ],
              message: `Duplicate quest prerequisite: ${prerequisiteId}`,
            });
          }
          prerequisites.add(prerequisiteId);
          if (!identifiers.has(prerequisiteId)) {
            context.addIssue({
              code: "custom",
              path: [
                "quests",
                index,
                "serverOnly",
                "prerequisites",
                prerequisiteIndex,
              ],
              message: `Missing quest prerequisite reference: ${prerequisiteId}`,
            });
          }
          if (prerequisiteId === quest.id) {
            context.addIssue({
              code: "custom",
              path: [
                "quests",
                index,
                "serverOnly",
                "prerequisites",
                prerequisiteIndex,
              ],
              message: `Quest cannot require itself: ${quest.id}`,
            });
          }
        },
      );
    });

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (questId: string, path: string[]): void => {
      if (visited.has(questId)) return;
      if (visiting.has(questId)) {
        const cycleStart = path.indexOf(questId);
        const cycle = [...path.slice(cycleStart), questId];
        const index = questIndexes.get(questId);
        if (index !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["quests", index, "serverOnly", "prerequisites"],
            message: `Circular quest prerequisites: ${cycle.join(" -> ")}`,
          });
        }
        return;
      }
      const index = questIndexes.get(questId);
      if (index === undefined) return;
      visiting.add(questId);
      for (const prerequisiteId of catalog.quests[index]!.serverOnly
        .prerequisites) {
        visit(prerequisiteId, [...path, questId]);
      }
      visiting.delete(questId);
      visited.add(questId);
    };
    for (const quest of catalog.quests) visit(quest.id, []);
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
    objectiveKind: QuestObjectiveKind;
    requiredCount: number;
    guidance?: { label: string; targetId: string };
    markers?: { id: string; label: string; targetId: string }[];
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
      objectiveKind: quest.clientVisible.objectiveKind,
      requiredCount: quest.clientVisible.requiredCount,
      ...(quest.clientVisible.guidance === undefined
        ? {}
        : { guidance: quest.clientVisible.guidance }),
      ...(quest.clientVisible.markers === undefined
        ? {}
        : { markers: quest.clientVisible.markers }),
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

export function questTargetIds(catalog: QuestCatalog): string[] {
  return catalog.quests.map((quest) => quest.serverOnly.objective.targetId);
}
