export type QuestStatus = "available" | "active" | "ready" | "completed";

export type QuestObjectiveKind =
  "kill" | "speak" | "visit" | "interact" | "collect";

export type QuestObjective = {
  [K in QuestObjectiveKind]: {
    kind: K;
    targetId: string;
    requiredCount: number;
  };
}[QuestObjectiveKind];

export interface ObjectiveEvent {
  eventId: string;
  kind: QuestObjectiveKind;
  targetId: string;
  count?: number;
}

export interface QuestSnapshot {
  questId: string;
  status: QuestStatus;
  progress: number;
  appliedEventIds: readonly string[];
  revision: number;
  completionId?: string;
}

export interface QuestTransitionContext {
  objective: QuestObjective;
  prerequisiteQuestIds?: readonly string[];
  completedPrerequisiteQuestIds?: ReadonlySet<string>;
  completionId?: string;
}

export type QuestTransition =
  | { kind: "accept" }
  | { kind: "objective"; event: ObjectiveEvent }
  | { kind: "objective"; eventId: string; targetId: string; count?: number }
  | { kind: "complete"; completionId: string };

export type QuestTransitionRejectionReason =
  | "already_applied"
  | "illegal_transition"
  | "objective_mismatch"
  | "invalid_event"
  | "prerequisites_unmet"
  | "invalid_completion_id";

export type QuestTransitionResult =
  | { applied: true; snapshot: QuestSnapshot }
  | {
      applied: false;
      reason: QuestTransitionRejectionReason;
      snapshot: QuestSnapshot;
    };

/**
 * The single Quest Transition Decider. Persistence adapters call this
 * function and apply its result; they do not re-derive quest rules.
 */
export function transitionQuest(
  snapshot: QuestSnapshot,
  context: QuestTransitionContext,
  transition: QuestTransition,
): QuestTransitionResult {
  if (transition.kind === "accept") {
    if (snapshot.status !== "available") {
      return rejected(snapshot, "illegal_transition");
    }
    const prerequisites = context.prerequisiteQuestIds ?? [];
    const completed = context.completedPrerequisiteQuestIds ?? new Set();
    if (prerequisites.some((questId) => !completed.has(questId))) {
      return rejected(snapshot, "prerequisites_unmet");
    }
    return applied(snapshot, { status: "active", progress: 0 });
  }

  if (transition.kind === "complete") {
    if (snapshot.status === "completed") {
      return transition.completionId === snapshot.completionId
        ? rejected(snapshot, "already_applied")
        : rejected(snapshot, "illegal_transition");
    }
    if (snapshot.status !== "ready") {
      return rejected(snapshot, "illegal_transition");
    }
    if (!isIdentifier(transition.completionId)) {
      return rejected(snapshot, "invalid_completion_id");
    }
    if (
      context.completionId !== undefined &&
      transition.completionId !== context.completionId
    ) {
      return rejected(snapshot, "invalid_completion_id");
    }
    return applied(snapshot, {
      status: "completed",
      completionId: transition.completionId,
    });
  }

  if (!isObjectiveKind(context.objective.kind)) {
    return rejected(snapshot, "illegal_transition");
  }
  const event: ObjectiveEvent =
    "event" in transition
      ? transition.event
      : {
          eventId: transition.eventId,
          targetId: transition.targetId,
          kind: context.objective.kind,
          ...(transition.count === undefined
            ? {}
            : { count: transition.count }),
        };
  if (snapshot.appliedEventIds.includes(event.eventId)) {
    return rejected(snapshot, "already_applied");
  }
  if (snapshot.status !== "active") {
    return rejected(snapshot, "illegal_transition");
  }
  if (
    !isIdentifier(event.eventId) ||
    !isStableTargetId(event.targetId) ||
    !isObjectiveKind(event.kind)
  ) {
    return rejected(snapshot, "invalid_event");
  }
  if (
    event.kind !== context.objective.kind ||
    event.targetId !== context.objective.targetId
  ) {
    return rejected(snapshot, "objective_mismatch");
  }

  const count = event.count ?? 1;
  if (!Number.isInteger(count) || count <= 0 || count > 100) {
    return rejected(snapshot, "invalid_event");
  }
  const progress = Math.min(
    context.objective.requiredCount,
    snapshot.progress + count,
  );
  return applied(snapshot, {
    status: progress >= context.objective.requiredCount ? "ready" : "active",
    progress,
    appliedEventIds: [...snapshot.appliedEventIds, event.eventId],
  });
}

export function questCompletionId(
  characterId: string,
  questId: string,
): string {
  return `quest-completion:${characterId}:${questId}`;
}

function isIdentifier(value: string): boolean {
  return value.trim().length > 0 && value.length <= 160;
}

function isStableTargetId(value: string): boolean {
  return /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(value);
}

function isObjectiveKind(value: string): value is QuestObjectiveKind {
  return ["kill", "speak", "visit", "interact", "collect"].includes(value);
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
  reason: QuestTransitionRejectionReason,
): QuestTransitionResult {
  return { applied: false, reason, snapshot };
}
