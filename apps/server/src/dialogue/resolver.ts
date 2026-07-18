import type {
  DialogueCatalog,
  DialogueCondition,
  DialogueGraph,
  DialogueQuestAction,
} from "@gameish/content/dialogue";
import type { DialogueNodeMessage } from "@gameish/protocol";
import type { QuestStatus } from "../quests/state.js";

export interface DialogueCharacterState {
  level: number;
  flags: ReadonlySet<string>;
  completedQuestIds: ReadonlySet<string>;
  questStatuses?: ReadonlyMap<string, QuestStatus>;
}

export type DialogueResolution =
  | {
      success: true;
      graph: DialogueGraph;
      node: DialogueNodeMessage;
      action?: DialogueQuestAction;
    }
  | {
      success: true;
      graph: DialogueGraph;
      closed: true;
      action?: DialogueQuestAction;
    }
  | { success: false; reason: "not_found" | "blocked" };

type DialogueNodeResolution =
  | {
      success: true;
      graph: DialogueGraph;
      node: DialogueNodeMessage;
    }
  | { success: false; reason: "not_found" | "blocked" };

export function evaluateDialogueCondition(
  condition: DialogueCondition,
  character: DialogueCharacterState,
): boolean {
  switch (condition.kind) {
    case "always":
      return true;
    case "minimum_level":
      return character.level >= condition.level;
    case "has_flag":
      return character.flags.has(condition.flag);
    case "completed_quest":
      return character.completedQuestIds.has(condition.questId);
    case "quest_status":
      return (
        character.questStatuses?.get(condition.questId) === condition.status
      );
  }
}

export function resolveDialogueNode(
  catalog: DialogueCatalog,
  npcId: string,
  nodeId: string,
  character: DialogueCharacterState,
): DialogueNodeResolution {
  const npc = catalog.npcs.find((candidate) => candidate.id === npcId);
  const graph = npc
    ? catalog.graphs.find((candidate) => candidate.id === npc.graphId)
    : undefined;
  const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
  if (!graph || !node) return { success: false, reason: "not_found" };
  if (!evaluateDialogueCondition(node.condition, character)) {
    return { success: false, reason: "blocked" };
  }
  return {
    success: true,
    graph,
    node: {
      dialogueId: graph.id,
      npcId,
      nodeId: node.id,
      speaker: node.speaker,
      text: node.text,
      choices: node.choices
        .filter((choice) =>
          evaluateDialogueCondition(choice.condition, character),
        )
        .map((choice) => ({ id: choice.id, label: choice.label })),
    },
  };
}

export function resolveDialogueChoice(
  catalog: DialogueCatalog,
  npcId: string,
  nodeId: string,
  choiceId: string,
  character: DialogueCharacterState,
): DialogueResolution | { success: false; reason: "choice_not_found" } {
  const current = resolveDialogueNode(catalog, npcId, nodeId, character);
  if (!current.success) return current;
  const currentDefinition = current.graph.nodes.find(
    (node) => node.id === nodeId,
  );
  const choice = currentDefinition?.choices.find(
    (candidate) => candidate.id === choiceId,
  );
  if (!choice || !evaluateDialogueCondition(choice.condition, character)) {
    return { success: false, reason: "choice_not_found" };
  }
  if (choice.nextNodeId === undefined) {
    return choice.questAction
      ? {
          success: true,
          graph: current.graph,
          closed: true,
          action: choice.questAction,
        }
      : { success: true, graph: current.graph, closed: true };
  }
  const next = resolveDialogueNode(
    catalog,
    npcId,
    choice.nextNodeId,
    character,
  );
  return next.success && choice.questAction
    ? { ...next, action: choice.questAction }
    : next;
}
