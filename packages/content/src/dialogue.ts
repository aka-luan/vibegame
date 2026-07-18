import { z } from "zod";

const namespacedId = (namespace: string) =>
  z.string().regex(new RegExp(`^${namespace}:[a-z][a-z0-9_]*$`));

const localId = z.string().regex(/^[a-z][a-z0-9_]*$/);

const questStatusSchema = z.enum(["available", "active", "ready", "completed"]);

const questActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("accept_quest"),
    questId: namespacedId("quest"),
  }),
  z.object({
    kind: z.literal("complete_quest"),
    questId: namespacedId("quest"),
  }),
]);

export const dialogueConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }),
  z.object({
    kind: z.literal("minimum_level"),
    level: z.number().int().min(1),
  }),
  z.object({ kind: z.literal("has_flag"), flag: namespacedId("flag") }),
  z.object({
    kind: z.literal("completed_quest"),
    questId: namespacedId("quest"),
  }),
  z.object({
    kind: z.literal("quest_status"),
    questId: namespacedId("quest"),
    status: questStatusSchema,
  }),
]);

const dialogueChoiceSchema = z.object({
  id: localId,
  label: z.string().trim().min(1).max(160),
  nextNodeId: localId.optional(),
  condition: dialogueConditionSchema.default({ kind: "always" }),
  questAction: questActionSchema.optional(),
});

const dialogueNodeSchema = z.object({
  id: localId,
  speaker: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(1_000),
  condition: dialogueConditionSchema.default({ kind: "always" }),
  choices: z.array(dialogueChoiceSchema).max(4),
});

const dialogueNpcSchema = z.object({
  id: namespacedId("npc"),
  interactiveId: localId,
  graphId: namespacedId("dialogue"),
  clientVisible: z.object({ displayName: z.string().trim().min(1).max(80) }),
});

const dialogueGraphSchema = z.object({
  id: namespacedId("dialogue"),
  npcId: namespacedId("npc"),
  rootNodeId: localId,
  nodes: z.array(dialogueNodeSchema).min(1),
});

export const dialogueCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    npcs: z.array(dialogueNpcSchema).min(1),
    graphs: z.array(dialogueGraphSchema).min(1),
  })
  .superRefine((catalog, context) => {
    const npcIds = new Set<string>();
    const interactiveIds = new Set<string>();
    const graphIds = new Set<string>();

    catalog.npcs.forEach((npc, index) => {
      if (npcIds.has(npc.id)) {
        context.addIssue({
          code: "custom",
          path: ["npcs", index, "id"],
          message: `Duplicate NPC identifier: ${npc.id}`,
        });
      }
      if (interactiveIds.has(npc.interactiveId)) {
        context.addIssue({
          code: "custom",
          path: ["npcs", index, "interactiveId"],
          message: `Duplicate interactive identifier: ${npc.interactiveId}`,
        });
      }
      npcIds.add(npc.id);
      interactiveIds.add(npc.interactiveId);
      if (!catalog.graphs.some((graph) => graph.id === npc.graphId)) {
        context.addIssue({
          code: "custom",
          path: ["npcs", index, "graphId"],
          message: `NPC references an unknown dialogue graph: ${npc.graphId}`,
        });
      } else {
        const graph = catalog.graphs.find(
          (candidate) => candidate.id === npc.graphId,
        );
        if (graph?.npcId !== npc.id) {
          context.addIssue({
            code: "custom",
            path: ["npcs", index, "graphId"],
            message: `Dialogue graph belongs to ${graph?.npcId ?? "an unknown NPC"}, not ${npc.id}`,
          });
        }
      }
    });

    catalog.graphs.forEach((graph, graphIndex) => {
      if (graphIds.has(graph.id)) {
        context.addIssue({
          code: "custom",
          path: ["graphs", graphIndex, "id"],
          message: `Duplicate dialogue graph identifier: ${graph.id}`,
        });
      }
      graphIds.add(graph.id);

      if (!npcIds.has(graph.npcId)) {
        context.addIssue({
          code: "custom",
          path: ["graphs", graphIndex, "npcId"],
          message: `Dialogue graph references an unknown NPC: ${graph.npcId}`,
        });
      }

      const nodeIds = new Set<string>();
      graph.nodes.forEach((node, nodeIndex) => {
        if (nodeIds.has(node.id)) {
          context.addIssue({
            code: "custom",
            path: ["graphs", graphIndex, "nodes", nodeIndex, "id"],
            message: `Duplicate dialogue node identifier: ${node.id}`,
          });
        }
        nodeIds.add(node.id);
      });

      if (!nodeIds.has(graph.rootNodeId)) {
        context.addIssue({
          code: "custom",
          path: ["graphs", graphIndex, "rootNodeId"],
          message: `Dialogue graph root does not exist: ${graph.rootNodeId}`,
        });
      }

      const reachable = new Set<string>();
      const visit = (nodeId: string) => {
        if (reachable.has(nodeId)) return;
        const node = graph.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return;
        reachable.add(nodeId);
        node.choices.forEach((choice) => {
          if (choice.nextNodeId !== undefined) visit(choice.nextNodeId);
        });
      };
      visit(graph.rootNodeId);

      graph.nodes.forEach((node, nodeIndex) => {
        if (!reachable.has(node.id)) {
          context.addIssue({
            code: "custom",
            path: ["graphs", graphIndex, "nodes", nodeIndex, "id"],
            message: `Dialogue node is unreachable: ${node.id}`,
          });
        }
        node.choices.forEach((choice, choiceIndex) => {
          if (
            choice.nextNodeId !== undefined &&
            !nodeIds.has(choice.nextNodeId)
          ) {
            context.addIssue({
              code: "custom",
              path: [
                "graphs",
                graphIndex,
                "nodes",
                nodeIndex,
                "choices",
                choiceIndex,
                "nextNodeId",
              ],
              message: `Dialogue choice references an unknown node: ${choice.nextNodeId}`,
            });
          }
        });
      });
    });
  });

export type DialogueCatalog = z.infer<typeof dialogueCatalogSchema>;
export type DialogueNpc = DialogueCatalog["npcs"][number];
export type DialogueGraph = DialogueCatalog["graphs"][number];
export type DialogueNode = DialogueGraph["nodes"][number];
export type DialogueChoice = DialogueNode["choices"][number];
export type DialogueCondition = z.infer<typeof dialogueConditionSchema>;
export type DialogueQuestAction = z.infer<typeof questActionSchema>;

export interface ClientDialogueCatalog {
  schemaVersion: 1;
  npcs: { id: string; interactiveId: string; displayName: string }[];
}

export function validateDialogueCatalog(
  input: unknown,
):
  | { success: true; data: DialogueCatalog }
  | { success: false; issues: { path: string; message: string }[] } {
  const result = dialogueCatalogSchema.safeParse(input);
  if (result.success) return result;
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

export function compileClientDialogueCatalog(
  catalog: DialogueCatalog,
): ClientDialogueCatalog {
  return {
    schemaVersion: 1,
    npcs: catalog.npcs.map((npc) => ({
      id: npc.id,
      interactiveId: npc.interactiveId,
      displayName: npc.clientVisible.displayName,
    })),
  };
}

export function validateDialogueInteractiveBindings(
  catalog: DialogueCatalog,
  interactiveIds: readonly string[],
): { path: string; message: string }[] {
  const available = new Set(interactiveIds);
  return catalog.npcs.flatMap((npc, index) =>
    available.has(npc.interactiveId)
      ? []
      : [
          {
            path: `npcs[${String(index)}].interactiveId`,
            message: `NPC interaction is missing from the map: ${npc.interactiveId}`,
          },
        ],
  );
}
