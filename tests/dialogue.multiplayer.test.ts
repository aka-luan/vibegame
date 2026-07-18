import { Client, type Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startFoundationServer,
  type RunningFoundationServer,
} from "../apps/server/src/server.js";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  ROOM_NAMES,
  SERVER_MESSAGES,
  type DialogueNodeMessage,
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
  const body = (await response.json()) as { ticket: string };
  const room = await new Client(endpoint).joinOrCreate(ROOM_NAMES.village, {
    ticket: body.ticket,
  });
  joinedRooms.push(room);
  return room;
}

describe("authoritative NPC dialogue boundary", () => {
  it("resolves a nearby conversation privately and evaluates choices on the server", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinVillage(endpoint, "Dialogue Ranger");
    const observer = await joinVillage(endpoint, "Dialogue Observer");
    const playerNodes: DialogueNodeMessage[] = [];
    const observerNodes: DialogueNodeMessage[] = [];
    const errors: string[] = [];
    player.onMessage<DialogueNodeMessage>(
      SERVER_MESSAGES.dialogueNode,
      (node) => playerNodes.push(node),
    );
    observer.onMessage<DialogueNodeMessage>(
      SERVER_MESSAGES.dialogueNode,
      (node) => observerNodes.push(node),
    );
    player.onMessage<{ code: string }>(
      SERVER_MESSAGES.dialogueRejected,
      ({ code }) => errors.push(code),
    );

    player.send(CLIENT_MESSAGES.interaction, {
      actionId: "open-dialogue",
      interactiveId: "notice_board",
    });
    await vi.waitFor(() => expect(playerNodes).toHaveLength(1));
    expect(playerNodes[0]).toMatchObject({
      npcId: "npc:elmira",
      nodeId: "welcome",
      speaker: "Elmira",
      choices: [
        { id: "ask_need", label: "What happened in the forest?" },
        { id: "say_goodbye" },
      ],
    });
    expect(observerNodes).toEqual([]);

    player.send(CLIENT_MESSAGES.dialogueChoice, {
      actionId: "ask-need",
      npcId: "npc:elmira",
      nodeId: "welcome",
      choiceId: "ask_need",
    });
    await vi.waitFor(() => expect(playerNodes).toHaveLength(2));
    expect(playerNodes[1]).toMatchObject({ nodeId: "forest_need" });

    await new Promise((resolve) => setTimeout(resolve, 150));
    player.send(CLIENT_MESSAGES.dialogueChoice, {
      actionId: "ready-to-help",
      npcId: "npc:elmira",
      nodeId: "forest_need",
      choiceId: "ready_to_help",
    });
    await vi.waitFor(() => expect(playerNodes).toHaveLength(3));
    expect(playerNodes[2]).toMatchObject({ nodeId: "farewell" });
    expect(errors).toEqual([]);
    expect(JSON.stringify(observer.state)).not.toContain("Elmira");
  });

  it("rejects missing, out-of-range, malformed, and rate-abusive interactions safely", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinVillage(endpoint, "Interaction Ranger");
    const errors: string[] = [];
    player.onMessage<{ code: string }>(
      SERVER_MESSAGES.dialogueRejected,
      ({ code }) => errors.push(code),
    );

    for (let sequence = 1; sequence <= 20; sequence += 1) {
      player.send(CLIENT_MESSAGES.movement, { x: -1, y: 0, sequence });
    }
    await vi.waitFor(() => {
      const state = JSON.parse(JSON.stringify(player.state)) as {
        players: Record<string, { x: number }>;
      };
      expect(state.players[player.sessionId]?.x).toBeLessThan(100);
    });
    player.send(CLIENT_MESSAGES.interaction, {
      actionId: "out-of-range",
      interactiveId: "notice_board",
    });
    await vi.waitFor(() =>
      expect(errors).toContain(ERROR_CODES.interactionOutOfRange),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    player.send(CLIENT_MESSAGES.interaction, {
      actionId: "missing-interaction",
      interactiveId: "missing",
    });
    await vi.waitFor(() =>
      expect(errors).toContain(ERROR_CODES.interactionNotFound),
    );
    player.send(CLIENT_MESSAGES.interaction, null);
    await vi.waitFor(() =>
      expect(errors).toContain(ERROR_CODES.invalidInteraction),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    player.send(CLIENT_MESSAGES.interaction, {
      actionId: "valid-dialogue",
      interactiveId: "notice_board",
    });
    player.send(CLIENT_MESSAGES.interaction, {
      actionId: "rate-abuse",
      interactiveId: "notice_board",
    });
    await vi.waitFor(() =>
      expect(errors).toContain(ERROR_CODES.interactionRateLimited),
    );
  });
});
