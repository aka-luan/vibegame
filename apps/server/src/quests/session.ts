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
import {
  questCompletionId,
  type ObjectiveEvent,
  type QuestSnapshot,
  type QuestTransitionResult,
} from "./state.js";

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
  questSnapshots?: ReadonlyMap<string, QuestSnapshot>;
  questDefinitions?: readonly QuestDefinition[];
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
  readonly #definitions: ReadonlyMap<string, QuestDefinition>;
  readonly #dialogue: DialogueCatalog;
  readonly #snapshots = new Map<string, QuestSnapshot>();
  #trackedQuestId: string;
  #dialogueContext: { npcId: string; nodeId: string } | undefined;

  constructor(options: QuestDialogueSessionOptions) {
    this.#characterId = options.characterId;
    this.#character = options.character;
    const definitions = options.questDefinitions ?? [options.definition];
    this.#definitions = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
    for (const definition of definitions) {
      this.#snapshots.set(
        definition.id,
        copySnapshot(
          options.questSnapshots?.get(definition.id) ??
            (definition.id === options.snapshot.questId
              ? options.snapshot
              : availableSnapshot(definition.id)),
        ),
      );
    }
    this.#trackedQuestId =
      this.#nextAvailableQuestId() ?? options.snapshot.questId;
    this.#dialogue = options.dialogue;
  }

  questStateMessage(questId = this.#trackedQuestId): QuestDialogueMessage {
    const definition = this.#definitionFor(questId);
    const snapshot = this.#snapshotFor(questId);
    return {
      type: "questState",
      payload: {
        questId: definition.id,
        status: snapshot.status,
        progress: snapshot.progress,
        requiredCount: definition.serverOnly.objective.requiredCount,
        revision: snapshot.revision,
        objectiveKind: definition.serverOnly.objective.kind,
        title: definition.clientVisible.title,
        description: definition.clientVisible.description,
        ...(definition.clientVisible.guidance === undefined
          ? {}
          : { guidance: definition.clientVisible.guidance }),
        ...(definition.clientVisible.markers === undefined
          ? {}
          : { markers: definition.clientVisible.markers }),
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

  objectiveProgress(
    input:
      ObjectiveEvent | { eventId: string; targetId: string; count?: number },
  ): ObjectiveProgressDecision | undefined {
    const eventKind = "kind" in input ? input.kind : undefined;
    const definition = [...this.#definitions.values()].find((candidate) => {
      const snapshot = this.#snapshotFor(candidate.id);
      return (
        snapshot.status === "active" &&
        (eventKind === undefined ||
          eventKind === candidate.serverOnly.objective.kind) &&
        input.targetId === candidate.serverOnly.objective.targetId
      );
    });
    if (!definition) return undefined;
    this.#trackedQuestId = definition.id;
    const event: ObjectiveEvent =
      "kind" in input
        ? input
        : {
            eventId: input.eventId,
            targetId: input.targetId,
            kind: definition.serverOnly.objective.kind,
            ...(input.count === undefined ? {} : { count: input.count }),
          };
    return {
      kind: "transition",
      source: "objective",
      request: {
        characterId: this.#characterId,
        questId: definition.id,
        objective: definition.serverOnly.objective,
        transition: {
          kind: "objective",
          event,
        },
        prerequisiteQuestIds: definition.serverOnly.prerequisites,
        completedPrerequisiteQuestIds: this.#completedQuestIds(),
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

    this.#snapshots.set(
      decision.request.questId,
      copySnapshot(result.snapshot),
    );
    this.#trackedQuestId = decision.request.questId;
    const stateMessage = this.questStateMessage();
    if (decision.request.transition.kind === "complete") {
      this.#trackedQuestId =
        this.#nextAvailableQuestId() ?? decision.request.questId;
    }
    if (decision.source === "objective") {
      return [stateMessage];
    }

    const messages: QuestDialogueMessage[] = [stateMessage];
    if (decision.request.transition.kind === "complete") {
      const definition = this.#definitionFor(decision.request.questId);
      messages.push({
        type: "questReward",
        payload: {
          questId: definition.id,
          ...definition.serverOnly.reward,
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
    const definition = this.#definitions.get(action.questId);
    if (!definition) return undefined;
    const transition =
      action.kind === "accept_quest"
        ? { kind: "accept" as const }
        : {
            kind: "complete" as const,
            completionId: questCompletionId(this.#characterId, definition.id),
          };
    const reward: QuestReward | undefined =
      action.kind === "complete_quest"
        ? definition.serverOnly.reward
        : undefined;
    return {
      characterId: this.#characterId,
      questId: definition.id,
      objective: definition.serverOnly.objective,
      transition,
      prerequisiteQuestIds: definition.serverOnly.prerequisites,
      completedPrerequisiteQuestIds: this.#completedQuestIds(),
      ...(reward === undefined ? {} : { reward }),
    };
  }

  #completedQuestIds(): ReadonlySet<string> {
    const completedQuestIds = new Set(this.#character.completedQuestIds ?? []);
    for (const snapshot of this.#snapshots.values()) {
      if (snapshot.status === "completed") {
        completedQuestIds.add(snapshot.questId);
      }
    }
    return completedQuestIds;
  }

  #dialogueCharacterState(): DialogueCharacterState {
    const completedQuestIds = this.#completedQuestIds();
    return {
      level: this.#character.level,
      flags: this.#character.flags,
      completedQuestIds,
      questStatuses: new Map(
        [...this.#snapshots.values()].map((snapshot) => [
          snapshot.questId,
          snapshot.status,
        ]),
      ),
    };
  }

  #definitionFor(questId: string): QuestDefinition {
    const definition = this.#definitions.get(questId);
    if (!definition)
      throw new Error(`Quest definition is unavailable: ${questId}`);
    return definition;
  }

  #snapshotFor(questId: string): QuestSnapshot {
    const snapshot = this.#snapshots.get(questId);
    if (!snapshot) throw new Error(`Quest snapshot is unavailable: ${questId}`);
    return snapshot;
  }

  #nextAvailableQuestId(): string | undefined {
    const completed = this.#completedQuestIds();
    return [...this.#definitions.values()].find((definition) => {
      const snapshot = this.#snapshotFor(definition.id);
      return (
        snapshot.status !== "completed" &&
        definition.serverOnly.prerequisites.every((questId) =>
          completed.has(questId),
        )
      );
    })?.id;
  }
}

function copySnapshot(snapshot: QuestSnapshot): QuestSnapshot {
  return { ...snapshot, appliedEventIds: [...snapshot.appliedEventIds] };
}

function availableSnapshot(questId: string): QuestSnapshot {
  return {
    questId,
    status: "available",
    progress: 0,
    appliedEventIds: [],
    revision: 0,
  };
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
  switch (reason) {
    case "objective_mismatch":
      return ERROR_CODES.questObjectiveInvalid;
    case "invalid_event":
      return ERROR_CODES.questObjectiveEventInvalid;
    case "prerequisites_unmet":
      return ERROR_CODES.questPrerequisitesUnmet;
    default:
      return ERROR_CODES.questTransitionInvalid;
  }
}
