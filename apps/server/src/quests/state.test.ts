import { describe, expect, it } from "vitest";

import { transitionQuest, type QuestSnapshot } from "./state.js";

const objective = {
  kind: "kill" as const,
  targetId: "monster:mossback",
  requiredCount: 1,
};

const available = (): QuestSnapshot => ({
  questId: "quest:forest_mossbacks",
  status: "available",
  progress: 0,
  appliedEventIds: [],
  revision: 0,
});

describe("quest state machine", () => {
  it.each([
    ["available", { kind: "accept" as const }, "active"],
    [
      "active",
      {
        kind: "objective" as const,
        eventId: "defeat:1",
        targetId: objective.targetId,
      },
      "ready",
    ],
    ["ready", { kind: "complete" as const }, "completed"],
  ] as const)("allows %s to transition to %s", (status, event, nextStatus) => {
    const snapshot = { ...available(), status } as QuestSnapshot;
    const result = transitionQuest(snapshot, { objective }, event);
    expect(result).toMatchObject({
      applied: true,
      snapshot: { status: nextStatus },
    });
  });

  it("rejects completion before the kill objective is ready", () => {
    const result = transitionQuest(
      available(),
      { objective },
      { kind: "complete" },
    );
    expect(result).toMatchObject({
      applied: false,
      reason: "illegal_transition",
    });
  });

  it.each([
    [
      "available",
      {
        kind: "objective" as const,
        eventId: "defeat:1",
        targetId: objective.targetId,
      },
    ],
    ["active", { kind: "complete" as const }],
    ["completed", { kind: "accept" as const }],
  ] as const)("rejects the illegal %s transition", (status, transition) => {
    const result = transitionQuest(
      { ...available(), status },
      { objective },
      transition,
    );
    expect(result).toMatchObject({
      applied: false,
      reason: "illegal_transition",
    });
  });

  it("does not apply a duplicate or out-of-order objective event", () => {
    const active = { ...available(), status: "active" as const, revision: 1 };
    const first = transitionQuest(
      active,
      { objective },
      {
        kind: "objective",
        eventId: "defeat:1",
        targetId: objective.targetId,
      },
    );
    expect(first).toMatchObject({
      applied: true,
      snapshot: { status: "ready", progress: 1 },
    });

    const duplicate = transitionQuest(
      first.snapshot,
      { objective },
      {
        kind: "objective",
        eventId: "defeat:1",
        targetId: objective.targetId,
      },
    );
    expect(duplicate).toMatchObject({
      applied: false,
      reason: "already_applied",
    });

    const wrongTarget = transitionQuest(
      active,
      { objective },
      {
        kind: "objective",
        eventId: "defeat:2",
        targetId: "monster:other",
      },
    );
    expect(wrongTarget).toMatchObject({
      applied: false,
      reason: "objective_mismatch",
    });
  });
});
