import {
  transitionQuest,
  type QuestObjective,
  type QuestSnapshot,
  type QuestTransition,
  type QuestTransitionResult,
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
    reward?: QuestReward;
    completionId?: string;
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
    reward?: QuestReward;
    completionId?: string;
  }): Promise<QuestTransitionResult> {
    return Promise.resolve().then(() => {
      const current = this.#get(input.characterId, input.questId);
      if (
        input.transition.kind === "complete" &&
        input.completionId !== undefined &&
        this.#completionIds.has(input.completionId)
      ) {
        return { applied: false, reason: "already_applied", snapshot: current };
      }

      const result = transitionQuest(current, input, input.transition);
      if (!result.applied) return result;

      this.#quests.set(this.#key(input.characterId, input.questId), {
        ...result.snapshot,
        appliedEventIds: [...result.snapshot.appliedEventIds],
      });
      if (input.transition.kind === "complete" && input.completionId) {
        this.#completionIds.add(input.completionId);
        if (input.reward)
          this.#rewards.set(input.completionId, { ...input.reward });
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
}
