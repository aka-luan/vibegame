export type QuestStatus = "available" | "active" | "ready" | "completed";

export interface QuestSnapshot {
  questId: string;
  status: QuestStatus;
  progress: number;
  appliedEventIds: readonly string[];
  revision: number;
}

export interface QuestObjective {
  kind: "kill";
  targetId: string;
  requiredCount: number;
}

export interface QuestTransitionContext {
  objective: { kind: string; targetId: string; requiredCount: number };
}

export type QuestTransition =
  | { kind: "accept" }
  | { kind: "objective"; eventId: string; targetId: string }
  | { kind: "complete"; completionId: string };

export type QuestTransitionResult =
  | { applied: true; snapshot: QuestSnapshot }
  | {
      applied: false;
      reason: "already_applied" | "illegal_transition" | "objective_mismatch";
      snapshot: QuestSnapshot;
    };

export function transitionQuest(
  snapshot: QuestSnapshot,
  context: QuestTransitionContext,
  transition: QuestTransition,
): QuestTransitionResult {
  if (transition.kind === "accept") {
    if (snapshot.status !== "available") {
      return rejected(snapshot, "illegal_transition");
    }
    return applied(snapshot, {
      status: "active",
      progress: 0,
    });
  }

  if (transition.kind === "complete") {
    if (snapshot.status !== "ready") {
      return rejected(snapshot, "illegal_transition");
    }
    return applied(snapshot, { status: "completed" });
  }

  if (snapshot.appliedEventIds.includes(transition.eventId)) {
    return rejected(snapshot, "already_applied");
  }
  if (
    snapshot.status !== "active" ||
    context.objective.kind !== "kill" ||
    transition.targetId !== context.objective.targetId
  ) {
    return rejected(
      snapshot,
      transition.targetId === context.objective.targetId
        ? "illegal_transition"
        : "objective_mismatch",
    );
  }

  const progress = Math.min(
    context.objective.requiredCount,
    snapshot.progress + 1,
  );
  return applied(snapshot, {
    status: progress >= context.objective.requiredCount ? "ready" : "active",
    progress,
    appliedEventIds: [...snapshot.appliedEventIds, transition.eventId],
  });
}

function applied(
  snapshot: QuestSnapshot,
  changes: Partial<QuestSnapshot>,
): QuestTransitionResult {
  return {
    applied: true,
    snapshot: {
      ...snapshot,
      ...changes,
      revision: snapshot.revision + 1,
    },
  };
}

function rejected(
  snapshot: QuestSnapshot,
  reason: Extract<QuestTransitionResult, { applied: false }>["reason"],
): QuestTransitionResult {
  return { applied: false, reason, snapshot };
}
