import {
  transitionQuest,
  type QuestObjective,
  type QuestSnapshot,
  type QuestTransition,
  type QuestTransitionResult,
  questCompletionId,
} from "./state.js";

export interface QuestReward {
  itemId: string;
  quantity: number;
  experience: number;
  currency: number;
}

export interface QuestPersistence {
  loadQuest(characterId: string, questId: string): Promise<QuestSnapshot>;
  transitionQuest(input: {
    characterId: string;
    questId: string;
    objective: QuestObjective;
    transition: QuestTransition;
    prerequisiteQuestIds?: readonly string[];
    completedPrerequisiteQuestIds?: ReadonlySet<string>;
    reward?: QuestReward;
  }): Promise<QuestTransitionResult>;
}

export class InMemoryQuestPersistence implements QuestPersistence {
  readonly #quests = new Map<string, QuestSnapshot>();
  readonly #completionIds = new Set<string>();
  readonly #rewards = new Map<string, QuestReward>();

  constructor(readonly questId: string) {}

  loadQuest(characterId: string, questId: string): Promise<QuestSnapshot> {
    return Promise.resolve(this.#get(characterId, questId));
  }

  transitionQuest(input: {
    characterId: string;
    questId: string;
    objective: QuestObjective;
    transition: QuestTransition;
    prerequisiteQuestIds?: readonly string[];
    completedPrerequisiteQuestIds?: ReadonlySet<string>;
    reward?: QuestReward;
  }): Promise<QuestTransitionResult> {
    return Promise.resolve().then(() => {
      const current = this.#get(input.characterId, input.questId);
      const completedPrerequisiteQuestIds =
        input.completedPrerequisiteQuestIds ??
        new Set(
          [...this.#quests.entries()]
            .filter(
              ([key, snapshot]) =>
                key.startsWith(`${input.characterId}:`) &&
                snapshot.status === "completed",
            )
            .map(([key]) => key.slice(input.characterId.length + 1)),
        );
      if (
        input.transition.kind === "complete" &&
        this.#completionIds.has(
          this.#completionKey(input.characterId, input.transition.completionId),
        )
      ) {
        return { applied: false, reason: "already_applied", snapshot: current };
      }

      const result = transitionQuest(
        current,
        {
          objective: input.objective,
          ...(input.prerequisiteQuestIds === undefined
            ? {}
            : { prerequisiteQuestIds: input.prerequisiteQuestIds }),
          completedPrerequisiteQuestIds,
          ...(input.transition.kind === "complete"
            ? {
                completionId: questCompletionId(
                  input.characterId,
                  input.questId,
                ),
              }
            : {}),
        },
        input.transition,
      );
      if (!result.applied) return result;

      this.#quests.set(this.#key(input.characterId, input.questId), {
        ...result.snapshot,
        appliedEventIds: [...result.snapshot.appliedEventIds],
      });
      if (input.transition.kind === "complete") {
        this.#completionIds.add(
          this.#completionKey(input.characterId, input.transition.completionId),
        );
        if (input.reward)
          this.#rewards.set(
            this.#completionKey(
              input.characterId,
              input.transition.completionId,
            ),
            {
              ...input.reward,
            },
          );
      }
      return result;
    });
  }

  snapshotFor(characterId: string): QuestSnapshot {
    return this.#get(characterId, this.questId);
  }

  rewards(): QuestReward[] {
    return [...this.#rewards.values()].map((reward) => ({ ...reward }));
  }

  #get(characterId: string, questId: string): QuestSnapshot {
    const key = this.#key(characterId, questId);
    const snapshot = this.#quests.get(key);
    if (snapshot) {
      return { ...snapshot, appliedEventIds: [...snapshot.appliedEventIds] };
    }
    return {
      questId,
      status: "available",
      progress: 0,
      appliedEventIds: [],
      revision: 0,
    };
  }

  #key(characterId: string, questId: string): string {
    return `${characterId}:${questId}`;
  }

  #completionKey(characterId: string, completionId: string): string {
    return `${characterId}:${completionId}`;
  }
}
