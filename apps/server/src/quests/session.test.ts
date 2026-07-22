import { describe, expect, it } from "vitest";

import villageDialogue from "@gameish/content/village-dialogue-server";
import villageQuests from "@gameish/content/village-quests-server";

import { InMemoryQuestPersistence } from "./persistence.js";
import { QuestDialogueSession, type QuestDialogueMessage } from "./session.js";
import type { QuestSnapshot } from "./state.js";

const definition = villageQuests.quests[0]!;
const questId = definition.id;

function snapshot(
  status: QuestSnapshot["status"] = "available",
  progress = 0,
): QuestSnapshot {
  return {
    questId,
    status,
    progress,
    appliedEventIds: [],
    revision: status === "available" ? 0 : 1,
  };
}

function session(status: QuestSnapshot["status"] = "available", progress = 0) {
  return new QuestDialogueSession({
    characterId: "character:test",
    character: { level: 1, flags: new Set() },
    snapshot: snapshot(status, progress),
    definition,
    dialogue: villageDialogue,
  });
}

function lastMessage(messages: QuestDialogueMessage[], type: string) {
  return messages.findLast((message) => message.type === type);
}

function messagesOf(
  decision: ReturnType<QuestDialogueSession["interact"]>,
): QuestDialogueMessage[] {
  if (decision.kind !== "messages") throw new Error("expected messages");
  return decision.messages;
}

function choose(
  current: QuestDialogueSession,
  choiceId: string,
  nodeId = "forest_need",
) {
  return current.chooseDialogue({
    npcId: "npc:elmira",
    nodeId,
    choiceId,
  });
}

async function accept(current: QuestDialogueSession) {
  current.interact({ interactiveId: "notice_board" });
  current.chooseDialogue({
    npcId: "npc:elmira",
    nodeId: "welcome",
    choiceId: "ask_need",
  });
  const decision = choose(current, "ready_to_help");
  if (decision.kind !== "transition")
    throw new Error("accept was not a transition");
  const persistence = new InMemoryQuestPersistence(questId);
  const result = await persistence.transitionQuest(decision.request);
  current.applyTransition(decision, result);
  return { current, persistence };
}

describe("QuestDialogueSession", () => {
  it.each([
    ["available", ["ready_to_help", "ask_later"]],
    ["active", ["ready_to_help", "ask_later"]],
    ["ready", ["ready_to_help", "ask_later", "report_success"]],
    ["completed", ["ready_to_help", "ask_later"]],
  ] as const)(
    "gates dialogue choices for %s quest status",
    (status, choices) => {
      const result = session(status).interact({
        interactiveId: "notice_board",
      });
      expect(result.kind).toBe("messages");
      const node = lastMessage(messagesOf(result), "dialogueNode");
      expect(node).toMatchObject({
        type: "dialogueNode",
        payload: {
          nodeId: "welcome",
          choices: [{ id: "ask_need" }, { id: "say_goodbye" }],
        },
      });

      const next = session(status);
      next.interact({ interactiveId: "notice_board" });
      const need = next.chooseDialogue({
        npcId: "npc:elmira",
        nodeId: "welcome",
        choiceId: "ask_need",
      });
      expect(need.kind).toBe("messages");
      expect(lastMessage(messagesOf(need), "dialogueNode")).toMatchObject({
        payload: { choices: choices.map((id) => ({ id })) },
      });
    },
  );

  it("rejects an unknown interaction, inactive dialogue, and stale or invalid choices", () => {
    const current = session();
    expect(current.interact({ interactiveId: "missing" })).toEqual({
      kind: "messages",
      messages: [
        {
          type: "dialogueRejected",
          payload: { code: "INTERACTION_NOT_FOUND" },
        },
      ],
    });
    expect(
      current.chooseDialogue({
        npcId: "npc:elmira",
        nodeId: "welcome",
        choiceId: "ask_need",
      }),
    ).toEqual({
      kind: "messages",
      messages: [
        { type: "dialogueRejected", payload: { code: "DIALOGUE_NOT_ACTIVE" } },
      ],
    });

    current.interact({ interactiveId: "notice_board" });
    expect(
      current.chooseDialogue({
        npcId: "npc:wrong",
        nodeId: "welcome",
        choiceId: "ask_need",
      }),
    ).toEqual({
      kind: "messages",
      messages: [
        {
          type: "dialogueRejected",
          payload: { code: "DIALOGUE_CHOICE_INVALID" },
        },
      ],
    });
    expect(
      current.chooseDialogue({
        npcId: "npc:elmira",
        nodeId: "welcome",
        choiceId: "missing",
      }),
    ).toEqual({
      kind: "messages",
      messages: [
        {
          type: "dialogueRejected",
          payload: { code: "DIALOGUE_CHOICE_INVALID" },
        },
      ],
    });
  });

  it("returns an accept transition and changes status only after persistence commits", async () => {
    const current = session();
    current.interact({ interactiveId: "notice_board" });
    current.chooseDialogue({
      npcId: "npc:elmira",
      nodeId: "welcome",
      choiceId: "ask_need",
    });
    const decision = choose(current, "ready_to_help");
    expect(decision).toMatchObject({
      kind: "transition",
      source: "dialogue",
      request: { transition: { kind: "accept" } },
    });

    const persistence = new InMemoryQuestPersistence(questId);
    if (decision.kind !== "transition")
      throw new Error("accept was not a transition");
    const result = await persistence.transitionQuest(decision.request);
    expect(current.questStateMessage()).toMatchObject({
      payload: { status: "available" },
    });
    const acceptedMessages = current.applyTransition(decision, result);
    expect(acceptedMessages).toHaveLength(2);
    expect(acceptedMessages[0]).toMatchObject({
      type: "questState",
      payload: { status: "active" },
    });
    expect(acceptedMessages[1]).toMatchObject({
      type: "dialogueNode",
      payload: { nodeId: "farewell" },
    });
  });

  it("routes kill progress through the session and reaches ready, then completes", async () => {
    const { current, persistence } = await accept(session());
    const progress = current.objectiveProgress({
      eventId: "defeat:test:1",
      targetId: definition.serverOnly.objective.targetId,
    });
    expect(progress).toMatchObject({
      source: "objective",
      request: { transition: { kind: "objective" } },
    });
    if (!progress) throw new Error("progress was not returned");
    const progressResult = await persistence.transitionQuest(progress.request);
    expect(current.applyTransition(progress, progressResult)).toMatchObject([
      { type: "questState", payload: { status: "ready", progress: 1 } },
    ]);

    current.interact({ interactiveId: "notice_board" });
    current.chooseDialogue({
      npcId: "npc:elmira",
      nodeId: "welcome",
      choiceId: "ask_need",
    });
    const completion = choose(current, "report_success");
    expect(completion).toMatchObject({
      request: {
        transition: {
          kind: "complete",
          completionId:
            "quest-completion:character:test:quest:forest_mossbacks",
        },
      },
    });
    if (completion.kind !== "transition")
      throw new Error("completion was not a transition");
    const completionResult = await persistence.transitionQuest(
      completion.request,
    );
    const completionMessages = current.applyTransition(
      completion,
      completionResult,
    );
    expect(completionMessages).toHaveLength(3);
    expect(completionMessages[0]).toMatchObject({
      type: "questState",
      payload: { status: "completed" },
    });
    expect(completionMessages[1]).toMatchObject({
      type: "questReward",
      payload: { questId },
    });
    expect(completionMessages[2]).toMatchObject({
      type: "dialogueNode",
      payload: { nodeId: "farewell" },
    });
    expect(
      current.objectiveProgress({
        eventId: "defeat:test:2",
        targetId: definition.serverOnly.objective.targetId,
      }),
    ).toBeUndefined();
  });

  it("does not create a second quest-status representation", () => {
    const current = session("active");
    const state = current.questStateMessage();
    expect(state).toMatchObject({ payload: { status: "active" } });
    const dialogue = current.interact({ interactiveId: "notice_board" });
    expect(dialogue).toMatchObject({ kind: "messages" });
    const node = lastMessage(messagesOf(dialogue), "dialogueNode");
    expect(node).toMatchObject({ payload: { nodeId: "welcome" } });
  });

  it("maps rejected persistence decisions to stable quest rejection reasons", () => {
    const current = session();
    current.interact({ interactiveId: "notice_board" });
    current.chooseDialogue({
      npcId: "npc:elmira",
      nodeId: "welcome",
      choiceId: "ask_need",
    });
    const decision = choose(current, "ready_to_help");
    if (decision.kind !== "transition")
      throw new Error("accept was not a transition");
    const result = {
      applied: false as const,
      reason: "illegal_transition" as const,
      snapshot: snapshot(),
    };
    expect(current.applyTransition(decision, result)).toEqual([
      {
        type: "questRejected",
        payload: { code: "QUEST_TRANSITION_INVALID" },
      },
    ]);
    expect(current.persistenceFailure(decision)).toEqual([
      {
        type: "questRejected",
        payload: { code: "QUEST_PERSISTENCE_UNAVAILABLE" },
      },
    ]);
  });
});
