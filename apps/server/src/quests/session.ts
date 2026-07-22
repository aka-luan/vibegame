import type {
  DialogueCatalog,
  DialogueQuestAction,
} from "@gameish/content/dialogue";
import type { QuestDefinition } from "@gameish/content/quests";
import {
  ERROR_CODES,
  type DialogueNodeMessage,
  type ErrorCode,
  type QuestRewardMessage,
  type QuestStateMessage,
} from "@gameish/protocol";

import {
  resolveDialogueChoice,
  resolveDialogueNode,
  type DialogueCharacterState,
} from "../dialogue/resolver.js";
import type { QuestPersistence, QuestReward } from "./persistence.js";
import type { QuestSnapshot, QuestTransitionResult } from "./state.js";

export interface QuestDialogueCharacter {
  level: number;
  flags: ReadonlySet<string>;
  completedQuestIds?: ReadonlySet<string>;
}

export type QuestTransitionRequest = Parameters<
  QuestPersistence["transitionQuest"]
>[0];

export type QuestDialogueMessage =
  | { type: "dialogueNode"; payload: DialogueNodeMessage }
  | { type: "dialogueClosed"; payload: { npcId: string } }
  | { type: "dialogueRejected"; payload: { code: ErrorCode } }
  | { type: "questState"; payload: QuestStateMessage }
  | { type: "questReward"; payload: QuestRewardMessage }
  | { type: "questRejected"; payload: { code: ErrorCode } };

interface DialogueContinuation {
  kind: "node";
  node: DialogueNodeMessage;
}

interface ClosedDialogueContinuation {
  kind: "closed";
  npcId: string;
}

type QuestDialogueContinuation =
  DialogueContinuation | ClosedDialogueContinuation;

export interface DialogueQuestTransitionDecision {
  kind: "transition";
  source: "dialogue";
  request: QuestTransitionRequest;
  continuation: QuestDialogueContinuation;
}

export interface ObjectiveProgressDecision {
  kind: "transition";
  source: "objective";
  request: QuestTransitionRequest;
}

export type QuestDialogueDecision =
  | { kind: "messages"; messages: QuestDialogueMessage[] }
  | DialogueQuestTransitionDecision
  | ObjectiveProgressDecision;

export interface QuestDialogueSessionOptions {
  characterId: string;
  character: QuestDialogueCharacter;
  snapshot: QuestSnapshot;
  definition: QuestDefinition;
  dialogue: DialogueCatalog;
}

/**
 * Owns one character's quest snapshot and the dialogue context that reads it.
 * Persistence is deliberately not a dependency: callers apply the returned
 * transition through QuestPersistence, then commit its result here.
 */
export class QuestDialogueSession {
  readonly #characterId: string;
  readonly #character: QuestDialogueCharacter;
  readonly #definition: QuestDefinition;
  readonly #dialogue: DialogueCatalog;
  #snapshot: QuestSnapshot;
  #dialogueContext: { npcId: string; nodeId: string } | undefined;

  constructor(options: QuestDialogueSessionOptions) {
    this.#characterId = options.characterId;
    this.#character = options.character;
    this.#snapshot = copySnapshot(options.snapshot);
    this.#definition = options.definition;
    this.#dialogue = options.dialogue;
  }

  questStateMessage(): QuestDialogueMessage {
    return {
      type: "questState",
      payload: {
        questId: this.#definition.id,
        status: this.#snapshot.status,
        progress: this.#snapshot.progress,
        requiredCount: this.#definition.serverOnly.objective.requiredCount,
        title: this.#definition.clientVisible.title,
        description: this.#definition.clientVisible.description,
        guidance: this.#definition.clientVisible.guidance,
      },
    };
  }

  closeDialogue(): void {
    this.#dialogueContext = undefined;
  }

  interact(input: { interactiveId: string }): QuestDialogueDecision {
    const npc = this.#dialogue.npcs.find(
      (candidate) => candidate.interactiveId === input.interactiveId,
    );
    if (!npc) return dialogueRejected(ERROR_CODES.interactionNotFound);

    const graph = this.#dialogue.graphs.find(
      (candidate) => candidate.id === npc.graphId,
    );
    if (!graph) return dialogueRejected(ERROR_CODES.dialogueBlocked);

    const resolved = resolveDialogueNode(
      this.#dialogue,
      npc.id,
      graph.rootNodeId,
      this.#dialogueCharacterState(),
    );
    if (!resolved.success) {
      return dialogueRejected(
        resolved.reason === "blocked"
          ? ERROR_CODES.dialogueBlocked
          : ERROR_CODES.interactionNotFound,
      );
    }

    this.#dialogueContext = {
      npcId: npc.id,
      nodeId: resolved.node.nodeId,
    };
    return messages({ type: "dialogueNode", payload: resolved.node });
  }

  chooseDialogue(input: {
    npcId: string;
    nodeId: string;
    choiceId: string;
  }): QuestDialogueDecision {
    const context = this.#dialogueContext;
    if (!context) return dialogueRejected(ERROR_CODES.dialogueNotActive);
    if (context.npcId !== input.npcId || context.nodeId !== input.nodeId) {
      return dialogueRejected(ERROR_CODES.dialogueChoiceInvalid);
    }

    const resolved = resolveDialogueChoice(
      this.#dialogue,
      context.npcId,
      context.nodeId,
      input.choiceId,
      this.#dialogueCharacterState(),
    );
    if (!resolved.success) {
      return dialogueRejected(
        resolved.reason === "blocked"
          ? ERROR_CODES.dialogueBlocked
          : ERROR_CODES.dialogueChoiceInvalid,
      );
    }

    const continuation: QuestDialogueContinuation =
      "closed" in resolved
        ? { kind: "closed", npcId: context.npcId }
        : { kind: "node", node: resolved.node };
    if (resolved.action) {
      const transition = this.#transitionForAction(resolved.action);
      if (!transition)
        return messages(questRejected(ERROR_CODES.questNotFound));
      return {
        kind: "transition",
        source: "dialogue",
        request: transition,
        continuation,
      };
    }

    if (continuation.kind === "closed") {
      this.#dialogueContext = undefined;
      return messages({
        type: "dialogueClosed",
        payload: { npcId: continuation.npcId },
      });
    }
    this.#dialogueContext = {
      npcId: continuation.node.npcId,
      nodeId: continuation.node.nodeId,
    };
    return messages({ type: "dialogueNode", payload: continuation.node });
  }

  objectiveProgress(input: {
    eventId: string;
    targetId: string;
  }): ObjectiveProgressDecision | undefined {
    if (this.#snapshot.status !== "active") return undefined;
    return {
      kind: "transition",
      source: "objective",
      request: {
        characterId: this.#characterId,
        questId: this.#definition.id,
        objective: this.#definition.serverOnly.objective,
        transition: {
          kind: "objective",
          eventId: input.eventId,
          targetId: input.targetId,
        },
      },
    };
  }

  applyTransition(
    decision: DialogueQuestTransitionDecision | ObjectiveProgressDecision,
    result: QuestTransitionResult,
  ): QuestDialogueMessage[] {
    if (!result.applied) {
      return decision.source === "objective"
        ? []
        : [questRejected(transitionErrorCode(result.reason))];
    }

    this.#snapshot = copySnapshot(result.snapshot);
    if (decision.source === "objective") {
      return [this.questStateMessage()];
    }

    const messages: QuestDialogueMessage[] = [this.questStateMessage()];
    if (decision.request.transition.kind === "complete") {
      messages.push({
        type: "questReward",
        payload: {
          questId: this.#definition.id,
          ...this.#definition.serverOnly.reward,
        },
      });
    }
    if (decision.continuation.kind === "closed") {
      this.#dialogueContext = undefined;
      messages.push({
        type: "dialogueClosed",
        payload: { npcId: decision.continuation.npcId },
      });
    } else {
      this.#dialogueContext = {
        npcId: decision.continuation.node.npcId,
        nodeId: decision.continuation.node.nodeId,
      };
      messages.push({
        type: "dialogueNode",
        payload: decision.continuation.node,
      });
    }
    return messages;
  }

  persistenceFailure(
    decision: QuestDialogueDecision | ObjectiveProgressDecision,
  ): QuestDialogueMessage[] {
    if (decision.kind !== "transition") return [];
    return [questRejected(ERROR_CODES.questPersistenceUnavailable)];
  }

  #transitionForAction(
    action: DialogueQuestAction,
  ): QuestTransitionRequest | undefined {
    if (action.questId !== this.#definition.id) return undefined;
    const transition =
      action.kind === "accept_quest"
        ? { kind: "accept" as const }
        : {
            kind: "complete" as const,
            completionId: `quest-completion:${this.#characterId}:${this.#definition.id}`,
          };
    const reward: QuestReward | undefined =
      action.kind === "complete_quest"
        ? this.#definition.serverOnly.reward
        : undefined;
    return {
      characterId: this.#characterId,
      questId: this.#definition.id,
      objective: this.#definition.serverOnly.objective,
      transition,
      ...(reward === undefined ? {} : { reward }),
    };
  }

  #dialogueCharacterState(): DialogueCharacterState {
    const completedQuestIds = new Set(this.#character.completedQuestIds ?? []);
    if (this.#snapshot.status === "completed") {
      completedQuestIds.add(this.#snapshot.questId);
    }
    return {
      level: this.#character.level,
      flags: this.#character.flags,
      completedQuestIds,
      questStatuses: new Map([[this.#snapshot.questId, this.#snapshot.status]]),
    };
  }
}

function copySnapshot(snapshot: QuestSnapshot): QuestSnapshot {
  return { ...snapshot, appliedEventIds: [...snapshot.appliedEventIds] };
}

function messages(...message: QuestDialogueMessage[]): QuestDialogueDecision {
  return { kind: "messages", messages: [...message] };
}

function dialogueRejected(code: ErrorCode): QuestDialogueDecision {
  return messages({ type: "dialogueRejected", payload: { code } });
}

function questRejected(code: ErrorCode): QuestDialogueMessage {
  return { type: "questRejected", payload: { code } };
}

function transitionErrorCode(
  reason: Extract<QuestTransitionResult, { applied: false }>["reason"],
): ErrorCode {
  return reason === "objective_mismatch"
    ? ERROR_CODES.questObjectiveInvalid
    : ERROR_CODES.questTransitionInvalid;
}
