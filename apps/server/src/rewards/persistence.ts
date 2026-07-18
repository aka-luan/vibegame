export interface RewardGrant {
  grantId: string;
  characterId: string;
  sourceMonsterId: string;
  defeatSequence: number;
  itemId: string;
  quantity: number;
}

export interface RewardPersistence {
  grant(reward: RewardGrant): Promise<void>;
}

export class DuplicateRewardGrantError extends Error {
  constructor(grantId: string) {
    super(`Reward grant already exists: ${grantId}`);
    this.name = "DuplicateRewardGrantError";
  }
}

export class InMemoryRewardPersistence implements RewardPersistence {
  readonly #grants = new Map<string, RewardGrant>();

  grant(reward: RewardGrant): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.#grants.has(reward.grantId)) {
        throw new DuplicateRewardGrantError(reward.grantId);
      }
      this.#grants.set(reward.grantId, { ...reward });
    });
  }

  grantsFor(characterId: string): RewardGrant[] {
    return [...this.#grants.values()]
      .filter((reward) => reward.characterId === characterId)
      .map((reward) => ({ ...reward }));
  }
}
