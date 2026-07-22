import type { CombatCatalog } from "@gameish/content/combat";

import { rewardGrantId } from "./grants.js";
import { rollPersonalLoot } from "./loot.js";
import {
  ParticipationWindow,
  type ParticipationCandidate,
} from "./participation.js";
import type { RewardGrant } from "./persistence.js";

const DEFAULT_WINDOW_OPTIONS = {
  proximityRadius: 180,
  afkAfterMs: 5_000,
} as const;

export interface RewardCandidate extends Omit<
  ParticipationCandidate,
  "lastActivityAtMs"
> {
  recipientSessionId: string;
}

export interface DefeatedMonsterIdentity {
  entityId: string;
  sourceMonsterId: string;
  position: { x: number; y: number };
}

export interface CharacterRewardSettlement {
  characterId: string;
  recipientSessionId: string;
  objectiveEventId: string;
  reward: RewardGrant | undefined;
}

export interface RewardSettlement {
  grants: CharacterRewardSettlement[];
}

export class RewardSettlementWindow {
  readonly #options: { proximityRadius: number; afkAfterMs: number };
  #participation: ParticipationWindow;
  readonly #lastActivityAtMs = new Map<string, number>();

  constructor(
    options: {
      proximityRadius: number;
      afkAfterMs: number;
    } = DEFAULT_WINDOW_OPTIONS,
  ) {
    this.#options = options;
    this.#participation = new ParticipationWindow(options);
  }

  open(): void {
    this.#participation = new ParticipationWindow(this.#options);
  }

  recordActivity(input: {
    characterId: string;
    partyId?: string | undefined;
    atMs: number;
  }): boolean {
    const recorded = this.#participation.recordActivity(input);
    if (recorded) this.#lastActivityAtMs.set(input.characterId, input.atMs);
    return recorded;
  }

  close(atMs: number): void {
    this.#participation.close(atMs);
  }

  eligibleCharacters(input: {
    defeatedAtMs: number;
    monsterPosition: { x: number; y: number };
    candidates: readonly RewardCandidate[];
  }): string[] {
    return this.#participation.eligibleCharacters({
      ...input,
      candidates: input.candidates.map((candidate) => ({
        ...candidate,
        lastActivityAtMs:
          this.#lastActivityAtMs.get(candidate.characterId) ??
          candidate.joinedAtMs,
      })),
    });
  }
}

export function settleDefeat(input: {
  participationWindow: RewardSettlementWindow;
  defeatedMonster: DefeatedMonsterIdentity;
  roomInstanceId: string;
  defeatSequence: number;
  candidates: readonly RewardCandidate[];
  combatCatalog: Pick<CombatCatalog, "loot">;
  clock: () => number;
  random: () => number;
}): RewardSettlement {
  const defeatedAtMs = input.clock();
  input.participationWindow.close(defeatedAtMs);
  const eligibleCharacters = input.participationWindow.eligibleCharacters({
    defeatedAtMs,
    monsterPosition: input.defeatedMonster.position,
    candidates: input.candidates,
  });
  const loot = input.combatCatalog.loot.find(
    (definition) =>
      definition.monsterId === input.defeatedMonster.sourceMonsterId,
  );
  const objectiveEventId = `quest-event:${input.roomInstanceId}:${input.defeatedMonster.entityId}:${String(input.defeatSequence)}`;

  return {
    grants: eligibleCharacters.map((characterId) => {
      const recipientSessionId = input.candidates.find(
        (candidate) => candidate.characterId === characterId,
      )!.recipientSessionId;
      return {
        characterId,
        recipientSessionId,
        objectiveEventId,
        reward: loot
          ? {
              grantId: rewardGrantId(
                input.roomInstanceId,
                input.defeatedMonster.entityId,
                input.defeatSequence,
                characterId,
              ),
              characterId,
              sourceMonsterId: input.defeatedMonster.sourceMonsterId,
              defeatSequence: input.defeatSequence,
              itemId: rollPersonalLoot(loot, input.random),
              quantity: 1,
            }
          : undefined,
      };
    }),
  };
}
