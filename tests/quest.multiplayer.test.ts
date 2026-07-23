import { Client, type Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startFoundationServer,
  type RunningFoundationServer,
} from "../apps/server/src/server.js";
import {
  CLIENT_MESSAGES,
  ROOM_NAMES,
  SERVER_MESSAGES,
  type QuestRewardMessage,
  type QuestStateMessage,
} from "../packages/protocol/src/index.js";

let runningServer: RunningFoundationServer | undefined;
const joinedRooms: Room[] = [];

afterEach(async () => {
  await Promise.all(joinedRooms.splice(0).map((room) => room.leave()));
  await runningServer?.close();
  runningServer = undefined;
});

async function startDevelopmentServer() {
  runningServer = await startFoundationServer({
    host: "127.0.0.1",
    port: 0,
    logger: false,
    readinessProbe: { check: () => Promise.resolve() },
    developmentLoginEnabled: true,
    runtimeEnvironment: "test",
  });
  return `http://127.0.0.1:${String(runningServer.port)}`;
}

async function joinVillage(endpoint: string, displayName: string) {
  const response = await fetch(`${endpoint}/development/play-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { ticket: string };
  const room = await new Client(endpoint).joinOrCreate(ROOM_NAMES.village, {
    ticket: body.ticket,
  });
  joinedRooms.push(room);
  return room;
}

function monsterId(room: Room): string {
  const state = JSON.parse(JSON.stringify(room.state)) as {
    monsters: Record<string, unknown>;
  };
  const id = Object.keys(state.monsters)[0];
  if (!id) throw new Error("Monster did not spawn");
  return id;
}

async function moveToMonster(room: Room, direction: 1 | -1, start = 1) {
  for (let sequence = start; sequence < start + 120; sequence += 1) {
    room.send(CLIENT_MESSAGES.movement, { x: direction, y: 0, sequence });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const state = JSON.parse(JSON.stringify(room.state)) as {
      players: Record<string, { x: number; y: number }>;
      monsters: Record<string, { x: number; y: number }>;
    };
    const player = state.players[room.sessionId];
    const monster = state.monsters[monsterId(room)];
    if (
      player &&
      monster &&
      Math.hypot(player.x - monster.x, player.y - monster.y) <= 84
    ) {
      return;
    }
  }
  throw new Error("Player did not reach the mossback");
}

async function moveAwayFromMonster(room: Room) {
  for (let sequence = 1; sequence <= 32; sequence += 1) {
    room.send(CLIENT_MESSAGES.movement, { x: -1, y: 0, sequence });
  }
  await vi.waitFor(() => {
    const state = JSON.parse(JSON.stringify(room.state)) as {
      players: Record<string, { x: number }>;
    };
    expect(state.players[room.sessionId]?.x).toBeLessThan(100);
  });
}

// Walks back into notice-board interaction range (center 168,312, radius 56).
// Movement sequences must stay gap-free: the server only processes the next
// consecutive sequence, so this continues at 33 after the 1..32 return walk.
async function moveToNoticeBoard(room: Room) {
  for (let sequence = 33; sequence < 273; sequence += 1) {
    const state = JSON.parse(JSON.stringify(room.state)) as {
      players: Record<string, { x: number; y: number }>;
    };
    const player = state.players[room.sessionId];
    if (player && Math.hypot(player.x - 168, player.y - 312) <= 30) return;
    const direction = player && player.x < 168 ? 1 : -1;
    room.send(CLIENT_MESSAGES.movement, { x: direction, y: 0, sequence });
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("Player did not reach the notice board");
}

async function acceptQuest(room: Room, questStates: QuestStateMessage[]) {
  const dialogueNodes: { nodeId: string }[] = [];
  room.onMessage<{ nodeId: string }>(SERVER_MESSAGES.dialogueNode, (node) =>
    dialogueNodes.push(node),
  );
  room.send(CLIENT_MESSAGES.interaction, {
    actionId: `open-${room.sessionId}`,
    interactiveId: "notice_board",
  });
  await vi.waitFor(() => expect(dialogueNodes).toHaveLength(1));
  room.send(CLIENT_MESSAGES.dialogueChoice, {
    actionId: `need-${room.sessionId}`,
    npcId: "npc:elmira",
    nodeId: "welcome",
    choiceId: "ask_need",
  });
  await vi.waitFor(() => expect(dialogueNodes).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 150));
  room.send(CLIENT_MESSAGES.dialogueChoice, {
    actionId: `accept-${room.sessionId}`,
    npcId: "npc:elmira",
    nodeId: "forest_need",
    choiceId: "ready_to_help",
  });
  await vi.waitFor(() => expect(questStates.at(-1)?.status).toBe("active"));
}

async function basicAttack(room: Room, targetEntityId: string, count: number) {
  room.send(CLIENT_MESSAGES.targetSelection, { targetEntityId });
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 650));
    room.send(CLIENT_MESSAGES.basicAttack, {
      actionId: `${room.sessionId}-strike-${String(index)}`,
      targetEntityId,
    });
  }
}

describe("authoritative first quest loop", () => {
  it("accepts, shares eligible kill progress, completes once, and keeps state private", async () => {
    const endpoint = await startDevelopmentServer();
    const first = await joinVillage(endpoint, "First Quest Ranger");
    const second = await joinVillage(endpoint, "Second Quest Ranger");
    const distant = await joinVillage(endpoint, "Distant Quest Ranger");
    const firstStates: QuestStateMessage[] = [];
    const secondStates: QuestStateMessage[] = [];
    const distantStates: QuestStateMessage[] = [];
    const firstRewards: QuestRewardMessage[] = [];
    const secondRewards: QuestRewardMessage[] = [];
    first.onMessage<QuestStateMessage>(SERVER_MESSAGES.questState, (state) =>
      firstStates.push(state),
    );
    second.onMessage<QuestStateMessage>(SERVER_MESSAGES.questState, (state) =>
      secondStates.push(state),
    );
    distant.onMessage<QuestStateMessage>(SERVER_MESSAGES.questState, (state) =>
      distantStates.push(state),
    );
    first.onMessage<QuestRewardMessage>(SERVER_MESSAGES.questReward, (reward) =>
      firstRewards.push(reward),
    );
    second.onMessage<QuestRewardMessage>(
      SERVER_MESSAGES.questReward,
      (reward) => secondRewards.push(reward),
    );

    first.send(CLIENT_MESSAGES.questStateRequest);
    second.send(CLIENT_MESSAGES.questStateRequest);
    distant.send(CLIENT_MESSAGES.questStateRequest);
    await vi.waitFor(() => {
      expect(firstStates.at(-1)?.status).toBe("available");
      expect(secondStates.at(-1)?.status).toBe("available");
      expect(distantStates.at(-1)?.status).toBe("available");
    });
    await Promise.all([
      acceptQuest(first, firstStates),
      acceptQuest(second, secondStates),
    ]);
    await moveToMonster(first, 1);
    await moveToMonster(second, 1);
    await moveAwayFromMonster(distant);

    const targetEntityId = monsterId(first);
    await basicAttack(first, targetEntityId, 2);
    await basicAttack(second, targetEntityId, 1);
    await vi.waitFor(() => {
      expect(firstStates.at(-1)?.status).toBe("ready");
      expect(secondStates.at(-1)?.status).toBe("ready");
    });
    const secondReadyStateCount = secondStates.length;
    expect(distantStates.at(-1)?.status).toBe("available");

    for (let sequence = 1; sequence <= 32; sequence += 1) {
      first.send(CLIENT_MESSAGES.movement, { x: -1, y: 0, sequence });
    }
    await vi.waitFor(() => {
      const state = JSON.parse(JSON.stringify(first.state)) as {
        players: Record<string, { x: number }>;
      };
      expect(state.players[first.sessionId]?.x).toBeLessThan(180);
    });
    const completionNodes: { nodeId: string }[] = [];
    first.onMessage<{ nodeId: string }>(SERVER_MESSAGES.dialogueNode, (node) =>
      completionNodes.push(node),
    );
    first.send(CLIENT_MESSAGES.interaction, {
      actionId: "complete-open",
      interactiveId: "notice_board",
    });
    await vi.waitFor(() => expect(completionNodes).toHaveLength(1));
    first.send(CLIENT_MESSAGES.dialogueChoice, {
      actionId: "complete-need",
      npcId: "npc:elmira",
      nodeId: "welcome",
      choiceId: "ask_need",
    });
    await vi.waitFor(() => expect(completionNodes).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 150));
    first.send(CLIENT_MESSAGES.dialogueChoice, {
      actionId: "complete-quest",
      npcId: "npc:elmira",
      nodeId: "forest_need",
      choiceId: "report_success",
    });
    await vi.waitFor(() =>
      expect(firstStates.at(-1)?.status).toBe("completed"),
    );
    await vi.waitFor(() => expect(firstRewards).toHaveLength(1));
    expect(firstRewards[0]).toMatchObject({
      questId: "quest:forest_mossbacks",
      itemId: "item:mossback_scale",
      experience: 100,
      currency: 10,
    });
    expect(secondStates).toHaveLength(secondReadyStateCount);
    first.send(CLIENT_MESSAGES.dialogueChoice, {
      actionId: "duplicate-complete",
      npcId: "npc:elmira",
      nodeId: "forest_need",
      choiceId: "report_success",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(firstRewards).toHaveLength(1);
    expect(firstStates.at(-1)?.status).toBe("completed");
    expect(secondRewards).toHaveLength(0);

    // Private speak objective: only the speaking character progresses, and a
    // repeated interaction replays the same Objective Event id without
    // advancing progress or revision again.
    await moveToNoticeBoard(first);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const nodesBeforeSpeakOpen = completionNodes.length;
    // Retried because a loaded scheduler can delay the room's server clock
    // past the interaction rate-limit window.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      first.send(CLIENT_MESSAGES.interaction, {
        actionId: `speak-open-${String(attempt)}`,
        interactiveId: "notice_board",
      });
      try {
        await vi.waitFor(
          () =>
            expect(completionNodes.length).toBeGreaterThan(
              nodesBeforeSpeakOpen,
            ),
          2_000,
        );
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    expect(completionNodes.length).toBeGreaterThan(nodesBeforeSpeakOpen);
    const nodesBeforeSpeakNeed = completionNodes.length;
    first.send(CLIENT_MESSAGES.dialogueChoice, {
      actionId: "speak-need",
      npcId: "npc:elmira",
      nodeId: "welcome",
      choiceId: "ask_need",
    });
    await vi.waitFor(
      () =>
        expect(completionNodes.length).toBeGreaterThan(nodesBeforeSpeakNeed),
      5_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    first.send(CLIENT_MESSAGES.dialogueChoice, {
      actionId: "speak-accept",
      npcId: "npc:elmira",
      nodeId: "forest_need",
      choiceId: "accept_elmira_greeting",
    });
    await vi.waitFor(() => {
      const latest = firstStates.at(-1);
      expect(latest?.questId).toBe("quest:elmira_greeting");
      expect(latest?.status).toBe("active");
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    first.send(CLIENT_MESSAGES.interaction, {
      actionId: "speak-progress",
      interactiveId: "notice_board",
    });
    await vi.waitFor(() => {
      const latest = firstStates.at(-1);
      expect(latest?.questId).toBe("quest:elmira_greeting");
      expect(latest?.status).toBe("ready");
      expect(latest?.progress).toBe(1);
    });
    const readyRevision = firstStates.at(-1)?.revision;

    await new Promise((resolve) => setTimeout(resolve, 300));
    first.send(CLIENT_MESSAGES.interaction, {
      actionId: "speak-repeat",
      interactiveId: "notice_board",
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(firstStates.at(-1)?.questId).toBe("quest:elmira_greeting");
    expect(firstStates.at(-1)?.status).toBe("ready");
    expect(firstStates.at(-1)?.progress).toBe(1);
    expect(firstStates.at(-1)?.revision).toBe(readyRevision);
    // The other character's private quest state never advanced past its own.
    expect(secondStates.at(-1)?.questId).toBe("quest:forest_mossbacks");
    expect(secondStates.at(-1)?.status).toBe("ready");
  }, 60_000);
});
