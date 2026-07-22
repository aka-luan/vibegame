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
  type MapChatMessage,
} from "../packages/protocol/src/index.js";

let runningServer: RunningFoundationServer | undefined;
const joinedRooms: Room[] = [];

afterEach(async () => {
  await Promise.all(joinedRooms.splice(0).map((room) => room.leave()));
  await runningServer?.close();
  runningServer = undefined;
});

async function startChatServer(options: {
  enabled: boolean;
  recordMapChat?: (details: Record<string, unknown>) => void;
}) {
  runningServer = await startFoundationServer({
    host: "127.0.0.1",
    port: 0,
    logger: false,
    readinessProbe: { check: () => Promise.resolve() },
    developmentLoginEnabled: true,
    mapChatEnabled: options.enabled,
    runtimeEnvironment: "test",
    now: () => 12_345,
    ...(options.recordMapChat ? { recordMapChat: options.recordMapChat } : {}),
  });
  return `http://127.0.0.1:${String(runningServer.port)}`;
}

async function issueTicket(endpoint: string, displayName: string) {
  const response = await fetch(`${endpoint}/development/play-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  return ((await response.json()) as { ticket: string }).ticket;
}

async function join(endpoint: string, displayName: string, create = false) {
  const client = new Client(endpoint);
  const ticket = await issueTicket(endpoint, displayName);
  const room = create
    ? await client.create(ROOM_NAMES.village, { ticket })
    : await client.joinOrCreate(ROOM_NAMES.village, { ticket });
  joinedRooms.push(room);
  return room;
}

describe("controlled map chat", () => {
  it("refuses production startup when chat is enabled", async () => {
    await expect(
      startFoundationServer({
        host: "127.0.0.1",
        port: 0,
        logger: false,
        readinessProbe: { check: () => Promise.resolve() },
        mapChatEnabled: true,
        runtimeEnvironment: "production",
      }),
    ).rejects.toThrow(/map chat/i);
  });

  it("is disabled by default and rejects direct message attempts", async () => {
    const endpoint = await startChatServer({ enabled: false });
    const room = await join(endpoint, "Quiet Ranger");
    let availability: { enabled: boolean } | undefined;
    let rejection: { code: string } | undefined;
    room.onMessage(SERVER_MESSAGES.chatAvailability, (message) => {
      availability = message as { enabled: boolean };
    });
    room.onMessage(SERVER_MESSAGES.chatRejected, (message) => {
      rejection = message as { code: string };
    });
    room.send(CLIENT_MESSAGES.mapChat, { text: "hidden bypass" });

    await vi.waitFor(() => {
      expect(availability).toEqual({ enabled: false });
      expect(rejection).toEqual({ code: ERROR_CODES.chatDisabled });
    });
  });

  it("delivers safe public fields only inside the current map instance", async () => {
    const endpoint = await startChatServer({ enabled: true });
    const sender = await join(endpoint, "Sender Ranger");
    const observer = await join(endpoint, "Observer Ranger");
    const isolated = await join(endpoint, "Isolated Ranger", true);
    const observed: MapChatMessage[] = [];
    const isolatedObserved: MapChatMessage[] = [];
    observer.onMessage(SERVER_MESSAGES.mapChat, (message) => {
      observed.push(message as MapChatMessage);
    });
    isolated.onMessage(SERVER_MESSAGES.mapChat, (message) => {
      isolatedObserved.push(message as MapChatMessage);
    });

    sender.send(CLIENT_MESSAGES.mapChat, { text: "Hello, map!" });
    await vi.waitFor(() => expect(observed).toHaveLength(1));

    expect(observed[0]).toEqual({
      entityId: sender.sessionId,
      displayName: "Sender Ranger",
      text: "Hello, map!",
      serverTimeMs: 12_345,
    });
    expect(JSON.stringify(observed[0])).not.toMatch(
      /userId|characterId|roomId|session|ticket|credential/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isolatedObserved).toEqual([]);
  });

  it("rejects invalid input and rate abuse without broadcasting", async () => {
    const endpoint = await startChatServer({ enabled: true });
    const sender = await join(endpoint, "Fast Ranger");
    const observer = await join(endpoint, "Watching Ranger");
    const messages: MapChatMessage[] = [];
    const rejections: string[] = [];
    observer.onMessage(SERVER_MESSAGES.mapChat, (message) => {
      messages.push(message as MapChatMessage);
    });
    sender.onMessage(SERVER_MESSAGES.chatRejected, (message) => {
      rejections.push((message as { code: string }).code);
    });

    sender.send(CLIENT_MESSAGES.mapChat, { text: "<em>markup</em>" });
    for (let index = 0; index < 5; index += 1) {
      sender.send(CLIENT_MESSAGES.mapChat, { text: `message ${index}` });
    }
    await vi.waitFor(() => {
      expect(messages).toHaveLength(4);
      expect(rejections).toContain(ERROR_CODES.invalidChatMessage);
      expect(rejections).toContain(ERROR_CODES.chatRateLimited);
    });
  });

  it("records metadata without message or identity fields", async () => {
    const records: Record<string, unknown>[] = [];
    const endpoint = await startChatServer({
      enabled: true,
      recordMapChat: (details) => records.push(details),
    });
    const sender = await join(endpoint, "Private Ranger");
    sender.send(CLIENT_MESSAGES.mapChat, { text: "secret words" });

    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toEqual({
      outcome: "accepted",
      utf8Bytes: 12,
      lineCount: 1,
    });
    expect(JSON.stringify(records)).not.toMatch(
      /secret words|Private Ranger|user|character|room|session|ticket|credential/i,
    );
  });
});
