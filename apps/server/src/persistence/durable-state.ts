import type {
  DurableRewardGrant,
  DurableStateRepository,
} from "@gameish/database";

import type { QuestPersistence, QuestReward } from "../quests/persistence.js";
import {
  questCompletionId,
  transitionQuest,
  type QuestTransitionContext,
  type QuestObjective,
  type QuestSnapshot,
  type QuestTransition,
} from "../quests/state.js";
import {
  DuplicateRewardGrantError,
  type RewardGrant,
  type RewardPersistence,
} from "../rewards/persistence.js";

export class PostgresQuestPersistence implements QuestPersistence {
  constructor(
    readonly repository: DurableStateRepository,
    readonly now: () => number = Date.now,
  ) {}

  async loadQuest(
    characterId: string,
    questId: string,
  ): Promise<QuestSnapshot> {
    return this.repository.loadQuest(characterId, questId);
  }

  async transitionQuest(input: {
    characterId: string;
    questId: string;
    objective: QuestObjective;
    transition: QuestTransition;
    prerequisiteQuestIds?: readonly string[];
    completedPrerequisiteQuestIds?: ReadonlySet<string>;
    reward?: QuestReward;
  }) {
    return this.repository.transitionQuest({
      ...input,
      objective: {
        kind: input.objective.kind,
        targetId: input.objective.targetId,
        requiredCount: input.objective.requiredCount,
      },
      ...(input.prerequisiteQuestIds === undefined
        ? {}
        : { prerequisiteQuestIds: input.prerequisiteQuestIds }),
      ...(input.completedPrerequisiteQuestIds === undefined
        ? {}
        : {
            completedPrerequisiteQuestIds: input.completedPrerequisiteQuestIds,
          }),
      decide: (snapshot, context, transition) =>
        transitionQuest(
          snapshot,
          {
            objective: context.objective as QuestObjective,
            ...(context.prerequisiteQuestIds === undefined
              ? {}
              : { prerequisiteQuestIds: context.prerequisiteQuestIds }),
            ...(context.completedPrerequisiteQuestIds === undefined
              ? {}
              : {
                  completedPrerequisiteQuestIds:
                    context.completedPrerequisiteQuestIds,
                }),
            completionId: questCompletionId(input.characterId, input.questId),
          } satisfies QuestTransitionContext,
          transition as QuestTransition,
        ),
      now: new Date(this.now()),
    });
  }
}

export class PostgresRewardPersistence implements RewardPersistence {
  constructor(
    readonly repository: DurableStateRepository,
    readonly now: () => number = Date.now,
  ) {}

  async grant(reward: RewardGrant): Promise<void> {
    const durableReward: DurableRewardGrant = {
      grantId: reward.grantId,
      characterId: reward.characterId,
      sourceId: reward.sourceMonsterId,
      defeatSequence: reward.defeatSequence,
      itemId: reward.itemId,
      quantity: reward.quantity,
    };
    const applied = await this.repository.grantReward(
      durableReward,
      new Date(this.now()),
    );
    if (!applied) throw new DuplicateRewardGrantError(reward.grantId);
  }
}
