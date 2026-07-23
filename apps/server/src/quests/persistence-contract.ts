import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { QuestPersistence, QuestReward } from "./persistence.js";
import type { QuestObjective, QuestTransition } from "./state.js";

/**
 * Shared behavioral contract for {@link QuestPersistence} implementations.
 * Run the same set of cases against every adapter (in-memory, Postgres, ...)
 * so the decider-driven transition rules in `state.ts` behave identically
 * regardless of storage.
 */
export interface QuestPersistenceContractHarness {
  persistence: QuestPersistence;
  /** A character identifier valid for every transition issued by this suite. */
  characterId: string;
  /** Torn down once after every case in this suite has run. */
  cleanup?: () => Promise<void>;
  /**
   * Returns how many units of {@link CONTRACT_REWARD_ITEM_ID} have been
   * granted to `characterId` so far. Optional: adapters that cannot cheaply
   * observe reward grants through their own surface may omit it, in which
   * case the reward-is-not-double-granted assertion is skipped.
   */
  countRewards?: () => Promise<number>;
}

/** Reward item id used by the "does not grant twice" case. */
export const CONTRACT_REWARD_ITEM_ID = "item:quest_persistence_contract_reward";

const objective: QuestObjective = {
  kind: "kill",
  targetId: "monster:quest_persistence_contract_target",
  requiredCount: 2,
};

const reward: QuestReward = {
  itemId: CONTRACT_REWARD_ITEM_ID,
  quantity: 1,
  experience: 10,
  currency: 5,
};

export function runQuestPersistenceContract(
  name: string,
  makePersistence: () => Promise<QuestPersistenceContractHarness>,
): void {
  describe(`QuestPersistence contract: ${name}`, () => {
    let harness: QuestPersistenceContractHarness;
    let questSequence = 0;

    beforeAll(async () => {
      harness = await makePersistence();
    });

    afterAll(async () => {
      await harness.cleanup?.();
    });

    function nextQuestId(label: string): string {
      questSequence += 1;
      return `quest:contract_${label}_${String(questSequence)}`;
    }

    function transition(
      questId: string,
      questTransition: QuestTransition,
      extra?: { reward?: QuestReward },
    ) {
      return harness.persistence.transitionQuest({
        characterId: harness.characterId,
        questId,
        objective,
        transition: questTransition,
        ...extra,
      });
    }

    it("accepts from available, moving to active at revision 1", async () => {
      const questId = nextQuestId("accept");
      const result = await transition(questId, { kind: "accept" });
      expect(result).toMatchObject({
        applied: true,
        snapshot: { status: "active", progress: 0, revision: 1 },
      });
    });

    it("rejects accept while already active as illegal_transition", async () => {
      const questId = nextQuestId("accept-active");
      await transition(questId, { kind: "accept" });

      const result = await transition(questId, { kind: "accept" });
      expect(result.applied).toBe(false);
      expect(result).toMatchObject({ reason: "illegal_transition" });
      expect(result.snapshot.revision).toBe(1);
    });

    it("increments objective progress, becomes ready exactly at requiredCount, then stays capped", async () => {
      const questId = nextQuestId("progress");
      await transition(questId, { kind: "accept" });

      const first = await transition(questId, {
        kind: "objective",
        eventId: `${questId}:event:1`,
        targetId: objective.targetId,
      });
      expect(first).toMatchObject({
        applied: true,
        snapshot: { status: "active", progress: 1 },
      });

      const second = await transition(questId, {
        kind: "objective",
        eventId: `${questId}:event:2`,
        targetId: objective.targetId,
      });
      expect(second).toMatchObject({
        applied: true,
        snapshot: { status: "ready", progress: objective.requiredCount },
      });

      const third = await transition(questId, {
        kind: "objective",
        eventId: `${questId}:event:3`,
        targetId: objective.targetId,
      });
      expect(third.applied).toBe(false);
      expect(third).toMatchObject({ reason: "illegal_transition" });
      expect(third.snapshot.progress).toBe(objective.requiredCount);
    });

    it("rejects a duplicate objective eventId as already_applied without changing progress", async () => {
      const questId = nextQuestId("duplicate-event");
      await transition(questId, { kind: "accept" });
      const eventId = `${questId}:event:1`;

      const first = await transition(questId, {
        kind: "objective",
        eventId,
        targetId: objective.targetId,
      });
      expect(first).toMatchObject({
        applied: true,
        snapshot: { progress: 1 },
      });

      const duplicate = await transition(questId, {
        kind: "objective",
        eventId,
        targetId: objective.targetId,
      });
      expect(duplicate).toMatchObject({
        applied: false,
        reason: "already_applied",
        snapshot: { progress: 1 },
      });
    });

    it("rejects objective transitions while not active as illegal_transition, and wrong targetId as objective_mismatch", async () => {
      const notActiveQuestId = nextQuestId("objective-not-active");
      const notActive = await transition(notActiveQuestId, {
        kind: "objective",
        eventId: `${notActiveQuestId}:event:1`,
        targetId: objective.targetId,
      });
      expect(notActive.applied).toBe(false);
      expect(notActive).toMatchObject({ reason: "illegal_transition" });

      const mismatchQuestId = nextQuestId("objective-mismatch");
      await transition(mismatchQuestId, { kind: "accept" });
      const mismatch = await transition(mismatchQuestId, {
        kind: "objective",
        eventId: `${mismatchQuestId}:event:1`,
        targetId: "monster:not_the_contract_target",
      });
      expect(mismatch.applied).toBe(false);
      expect(mismatch).toMatchObject({ reason: "objective_mismatch" });
    });

    it("completes from ready, but rejects complete from active as illegal_transition", async () => {
      const activeQuestId = nextQuestId("complete-active");
      await transition(activeQuestId, { kind: "accept" });
      const fromActive = await transition(activeQuestId, {
        kind: "complete",
        completionId: `quest-completion:${harness.characterId}:${activeQuestId}`,
      });
      expect(fromActive.applied).toBe(false);
      expect(fromActive).toMatchObject({ reason: "illegal_transition" });

      const readyQuestId = nextQuestId("complete-ready");
      await transition(readyQuestId, { kind: "accept" });
      for (let index = 1; index <= objective.requiredCount; index += 1) {
        await transition(readyQuestId, {
          kind: "objective",
          eventId: `${readyQuestId}:event:${String(index)}`,
          targetId: objective.targetId,
        });
      }
      const fromReady = await transition(readyQuestId, {
        kind: "complete",
        completionId: `quest-completion:${harness.characterId}:${readyQuestId}`,
      });
      expect(fromReady).toMatchObject({
        applied: true,
        snapshot: { status: "completed" },
      });
    });

    it("rejects a repeated completionId as already_applied and does not grant the reward twice", async () => {
      const questId = nextQuestId("complete-duplicate");
      await transition(questId, { kind: "accept" });
      for (let index = 1; index <= objective.requiredCount; index += 1) {
        await transition(questId, {
          kind: "objective",
          eventId: `${questId}:event:${String(index)}`,
          targetId: objective.targetId,
        });
      }
      const completionId = `quest-completion:${harness.characterId}:${questId}`;

      const first = await transition(
        questId,
        { kind: "complete", completionId },
        { reward },
      );
      expect(first).toMatchObject({
        applied: true,
        snapshot: { status: "completed" },
      });

      const duplicate = await transition(
        questId,
        { kind: "complete", completionId },
        { reward },
      );
      expect(duplicate).toMatchObject({
        applied: false,
        reason: "already_applied",
        snapshot: { status: "completed" },
      });

      if (harness.countRewards) {
        await expect(harness.countRewards()).resolves.toBe(reward.quantity);
      }
    });

    it("increments revision by exactly 1 per applied transition and leaves it unchanged on rejection", async () => {
      const questId = nextQuestId("revision");

      const accept = await transition(questId, { kind: "accept" });
      expect(accept.snapshot.revision).toBe(1);

      const rejectedAccept = await transition(questId, { kind: "accept" });
      expect(rejectedAccept.applied).toBe(false);
      expect(rejectedAccept.snapshot.revision).toBe(1);

      const eventId = `${questId}:event:1`;
      const progress = await transition(questId, {
        kind: "objective",
        eventId,
        targetId: objective.targetId,
      });
      expect(progress.snapshot.revision).toBe(2);

      const duplicate = await transition(questId, {
        kind: "objective",
        eventId,
        targetId: objective.targetId,
      });
      expect(duplicate.applied).toBe(false);
      expect(duplicate.snapshot.revision).toBe(2);
    });
  });
}
