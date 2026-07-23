import { describe, expect, it } from "vitest";

import {
  transitionQuest,
  type QuestObjective,
  type QuestSnapshot,
} from "./state.js";

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

describe("Quest Transition Decider", () => {
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
    [
      "ready",
      { kind: "complete" as const, completionId: "quest-completion:1" },
      "completed",
    ],
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
      { kind: "complete", completionId: "quest-completion:1" },
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
    [
      "active",
      { kind: "complete" as const, completionId: "quest-completion:1" },
    ],
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

  it("rejects an objective transition whose objective kind is not kill even when the target matches", () => {
    const active = { ...available(), status: "active" as const };
    const nonKillObjective = {
      kind: "other",
      targetId: objective.targetId,
      requiredCount: 1,
    } as unknown as QuestObjective;
    const result = transitionQuest(
      active,
      { objective: nonKillObjective },
      {
        kind: "objective",
        eventId: "defeat:1",
        targetId: objective.targetId,
      },
    );
    expect(result).toMatchObject({
      applied: false,
      reason: "illegal_transition",
    });
  });

  it.each([
    ["kill", "monster:mossback"],
    ["speak", "npc:elmira"],
    ["visit", "map:forest"],
    ["interact", "interactive:notice_board"],
    ["collect", "item:mossback_scale"],
  ] as const)(
    "advances a %s objective from its stable event",
    (kind, targetId) => {
      const typedObjective = {
        kind,
        targetId,
        requiredCount: 2,
      } as QuestObjective;
      const active: QuestSnapshot = {
        ...available(),
        status: "active",
        revision: 1,
      };
      const result = transitionQuest(
        active,
        { objective: typedObjective },
        {
          kind: "objective",
          event: { eventId: `event:${kind}:1`, kind, targetId },
        },
      );
      expect(result).toMatchObject({
        applied: true,
        snapshot: { status: "active", progress: 1, revision: 2 },
      });
    },
  );

  it("requires every prerequisite to be completed before acceptance", () => {
    const result = transitionQuest(
      available(),
      {
        objective,
        prerequisiteQuestIds: ["quest:first", "quest:second"],
        completedPrerequisiteQuestIds: new Set(["quest:first"]),
      },
      { kind: "accept" },
    );
    expect(result).toMatchObject({
      applied: false,
      reason: "prerequisites_unmet",
      snapshot: { status: "available", revision: 0 },
    });
  });

  it("rejects invalid counts and an out-of-order event without changing the snapshot", () => {
    const active: QuestSnapshot = {
      ...available(),
      status: "active",
      revision: 1,
    };
    const invalid = transitionQuest(
      active,
      { objective },
      {
        kind: "objective",
        event: {
          eventId: "event:invalid",
          kind: "kill",
          targetId: objective.targetId,
          count: 0,
        },
      },
    );
    expect(invalid).toMatchObject({ applied: false, reason: "invalid_event" });

    const ready = transitionQuest(
      active,
      { objective },
      {
        kind: "objective",
        event: {
          eventId: "event:ready",
          kind: "kill",
          targetId: objective.targetId,
        },
      },
    );
    if (!ready.applied) throw new Error("expected ready objective");
    const outOfOrder = transitionQuest(
      ready.snapshot,
      { objective },
      {
        kind: "objective",
        event: {
          eventId: "event:late",
          kind: "kill",
          targetId: objective.targetId,
        },
      },
    );
    expect(outOfOrder).toMatchObject({
      applied: false,
      reason: "illegal_transition",
      snapshot: { progress: 1, revision: 2 },
    });
  });

  it("accepts only the deterministic completion id and replays it safely", () => {
    const ready: QuestSnapshot = {
      ...available(),
      status: "ready",
      progress: 1,
      revision: 2,
    };
    const context = {
      objective,
      completionId: "quest-completion:character:test:quest:forest_mossbacks",
    };
    const wrong = transitionQuest(ready, context, {
      kind: "complete",
      completionId: "quest-completion:wrong",
    });
    expect(wrong).toMatchObject({
      applied: false,
      reason: "invalid_completion_id",
    });
    const first = transitionQuest(ready, context, {
      kind: "complete",
      completionId: context.completionId,
    });
    expect(first).toMatchObject({
      applied: true,
      snapshot: { status: "completed", completionId: context.completionId },
    });
    if (!first.applied) throw new Error("expected completion");
    expect(
      transitionQuest(first.snapshot, context, {
        kind: "complete",
        completionId: context.completionId,
      }),
    ).toMatchObject({ applied: false, reason: "already_applied" });
  });
});
