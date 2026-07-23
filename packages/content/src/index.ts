import { z } from "zod";

import { combatCatalogSchema } from "./combat.js";
import { dialogueCatalogSchema } from "./dialogue.js";
import { equipmentCatalogSchema } from "./equipment.js";
import { questCatalogSchema } from "./quests.js";

export type { ClientMapArtifact, ServerMapArtifact } from "./maps.js";
export {
  LOGICAL_MAP_DIRECTORY,
  type LogicalMapDirectoryEntry,
} from "./logical-map-directory.js";

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
    dialogue: dialogueCatalogSchema.optional(),
    equipment: equipmentCatalogSchema.optional(),
    quests: questCatalogSchema.optional(),
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

    content.equipment?.items.forEach((item, itemIndex) => {
      if (!identifiers.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["equipment", "items", itemIndex, "id"],
          message: `Missing equipment item reference: ${item.id}`,
        });
      }
      const requiredClassId = item.serverOnly.requirements.classId;
      if (
        requiredClassId !== undefined &&
        !content.combat?.classes.some(
          (classDefinition) => classDefinition.id === requiredClassId,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "equipment",
            "items",
            itemIndex,
            "serverOnly",
            "requirements",
            "classId",
          ],
          message: `Missing equipment class requirement reference: ${requiredClassId}`,
        });
      }
    });

    const dialogue = content.dialogue;
    if (dialogue) {
      dialogue.npcs.forEach((npc, npcIndex) => {
        if (!identifiers.has(npc.id)) {
          context.addIssue({
            code: "custom",
            path: ["dialogue", "npcs", npcIndex, "id"],
            message: `Missing NPC content reference: ${npc.id}`,
          });
        }
      });
      dialogue.graphs.forEach((graph, graphIndex) => {
        graph.nodes.forEach((node, nodeIndex) => {
          const validateQuestReference = (
            questId: string,
            path: (string | number)[],
          ) => {
            if (identifiers.has(questId)) return;
            context.addIssue({
              code: "custom",
              path,
              message: `Dialogue references an unknown quest: ${questId}`,
            });
          };
          const condition = node.condition;
          if (
            condition.kind === "completed_quest" ||
            condition.kind === "quest_status"
          ) {
            validateQuestReference(condition.questId, [
              "dialogue",
              "graphs",
              graphIndex,
              "nodes",
              nodeIndex,
              "condition",
              "questId",
            ]);
          }
          node.choices.forEach((choice, choiceIndex) => {
            if (
              choice.condition.kind === "completed_quest" ||
              choice.condition.kind === "quest_status"
            ) {
              validateQuestReference(choice.condition.questId, [
                "dialogue",
                "graphs",
                graphIndex,
                "nodes",
                nodeIndex,
                "choices",
                choiceIndex,
                "condition",
                "questId",
              ]);
            }
            if (choice.questAction) {
              validateQuestReference(choice.questAction.questId, [
                "dialogue",
                "graphs",
                graphIndex,
                "nodes",
                nodeIndex,
                "choices",
                choiceIndex,
                "questAction",
                "questId",
              ]);
            }
          });
        });
      });
    }

    const quests = content.quests;
    if (quests) {
      quests.quests.forEach((quest, questIndex) => {
        if (!identifiers.has(quest.id)) {
          context.addIssue({
            code: "custom",
            path: ["quests", "quests", questIndex, "id"],
            message: `Missing quest content reference: ${quest.id}`,
          });
        }
        if (!identifiers.has(quest.serverOnly.objective.targetId)) {
          context.addIssue({
            code: "custom",
            path: [
              "quests",
              "quests",
              questIndex,
              "serverOnly",
              "objective",
              "targetId",
            ],
            message: `Missing quest objective reference: ${quest.serverOnly.objective.targetId}`,
          });
        }
        quest.serverOnly.prerequisites.forEach(
          (prerequisiteId, prerequisiteIndex) => {
            if (!identifiers.has(prerequisiteId)) {
              context.addIssue({
                code: "custom",
                path: [
                  "quests",
                  "quests",
                  questIndex,
                  "serverOnly",
                  "prerequisites",
                  prerequisiteIndex,
                ],
                message: `Missing quest prerequisite reference: ${prerequisiteId}`,
              });
            }
          },
        );
        const guidance = quest.clientVisible.guidance;
        if (guidance && !identifiers.has(guidance.targetId)) {
          context.addIssue({
            code: "custom",
            path: [
              "quests",
              "quests",
              questIndex,
              "clientVisible",
              "guidance",
              "targetId",
            ],
            message: `Missing quest guidance reference: ${guidance.targetId}`,
          });
        }
        quest.clientVisible.markers?.forEach((marker, markerIndex) => {
          if (!identifiers.has(marker.targetId)) {
            context.addIssue({
              code: "custom",
              path: [
                "quests",
                "quests",
                questIndex,
                "clientVisible",
                "markers",
                markerIndex,
                "targetId",
              ],
              message: `Missing quest marker reference: ${marker.targetId}`,
            });
          }
        });
        if (!identifiers.has(quest.serverOnly.reward.itemId)) {
          context.addIssue({
            code: "custom",
            path: [
              "quests",
              "quests",
              questIndex,
              "serverOnly",
              "reward",
              "itemId",
            ],
            message: `Missing quest reward reference: ${quest.serverOnly.reward.itemId}`,
          });
        }
        if (
          quest.serverOnly.objective.kind === "collect" &&
          !content.combat?.loot.some((loot) =>
            loot.entries.some(
              (entry) => entry.id === quest.serverOnly.objective.targetId,
            ),
          )
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "quests",
              "quests",
              questIndex,
              "serverOnly",
              "objective",
              "targetId",
            ],
            message: `Impossible collect objective: ${quest.serverOnly.objective.targetId} is not droppable from any loot table`,
          });
        }
      });
    }
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
