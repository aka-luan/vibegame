import { describe, expect, it } from "vitest";

import { InMemoryQuestPersistence } from "./persistence.js";

const objective = {
  kind: "kill" as const,
  targetId: "monster:mossback",
  requiredCount: 1,
};

describe("quest persistence boundary", () => {
  it("persists transitions and makes objective and completion retries idempotent", async () => {
    const persistence = new InMemoryQuestPersistence("quest:forest_mossbacks");
    const base = {
      characterId: "character:one",
      questId: "quest:forest_mossbacks",
      objective,
    };

    await persistence.transitionQuest({
      ...base,
      transition: { kind: "accept" },
    });
    const progress = await persistence.transitionQuest({
      ...base,
      transition: {
        kind: "objective",
        eventId: "room:one:defeat:1",
        targetId: objective.targetId,
      },
    });
    expect(progress).toMatchObject({
      applied: true,
      snapshot: { status: "ready", progress: 1 },
    });

    const duplicateProgress = await persistence.transitionQuest({
      ...base,
      transition: {
        kind: "objective",
        eventId: "room:one:defeat:1",
        targetId: objective.targetId,
      },
    });
    expect(duplicateProgress).toMatchObject({
      applied: false,
      reason: "already_applied",
    });

    const completion = await persistence.transitionQuest({
      ...base,
      completionId: "complete:character:one:quest:forest_mossbacks",
      transition: { kind: "complete" },
      reward: {
        itemId: "item:mossback_scale",
        quantity: 1,
        experience: 100,
        currency: 10,
      },
    });
    expect(completion).toMatchObject({
      applied: true,
      snapshot: { status: "completed" },
    });

    const duplicateCompletion = await persistence.transitionQuest({
      ...base,
      completionId: "complete:character:one:quest:forest_mossbacks",
      transition: { kind: "complete" },
      reward: {
        itemId: "item:mossback_scale",
        quantity: 1,
        experience: 100,
        currency: 10,
      },
    });
    expect(duplicateCompletion).toMatchObject({
      applied: false,
      reason: "already_applied",
    });
    expect(persistence.snapshotFor("character:one")).toMatchObject({
      status: "completed",
      revision: 3,
    });
  });
});
