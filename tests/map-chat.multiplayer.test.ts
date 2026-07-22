import { Client, type Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startFoundationServer,
  type RunningFoundationServer,
} from "../apps/server/src/server.js";
import type {
  PlayTicketConsumer,
  PlayTicketConsumption,
} from "../apps/server/src/identity/play-tickets.js";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  ROOM_NAMES,
  SERVER_MESSAGES,
  type MapChatMessage,
} from "../packages/protocol/src/index.js";
import { villageSlice } from "../packages/content/src/slices/village.js";

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
  playTickets?: PlayTicketConsumer;
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
    ...(options.playTickets ? { playTickets: options.playTickets } : {}),
    ...(options.recordMapChat ? { recordMapChat: options.recordMapChat } : {}),
  });
  return `http://127.0.0.1:${String(runningServer.port)}`;
}

class TestPlayTickets implements PlayTicketConsumer {
  readonly #tickets = new Map<
    string,
    Extract<PlayTicketConsumption, { success: true }>["admission"]
  >();

  issue(
    ticket: string,
    userId: string,
    characterId: string,
    displayName: string,
  ) {
    this.#tickets.set(ticket, {
      userId,
      characterId,
      displayName,
      logicalDestination: villageSlice.mapId,
      contentVersion: villageSlice.contentVersion,
      nonce: `nonce:${ticket}`,
      appearance: {
        rigId: villageSlice.rigId,
        baseLayerId: "base",
        armorLayerId: "tunic",
      },
    });
  }

  consume(ticket: string): PlayTicketConsumption {
    const admission = this.#tickets.get(ticket);
    if (!admission) {
      return { success: false, code: ERROR_CODES.invalidPlayTicket };
    }
    this.#tickets.delete(ticket);
    return { success: true, admission };
  }
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

async function joinWithTicket(
  endpoint: string,
  ticket: string,
  create = false,
) {
  const client = new Client(endpoint);
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

  it("retains one user bucket across characters and room rejoin while isolating another user", async () => {
    const tickets = new TestPlayTickets();
    tickets.issue(
      "first",
      "user:returning",
      "development:character:first",
      "First Ranger",
    );
    tickets.issue(
      "returning",
      "user:returning",
      "development:character:second",
      "Second Ranger",
    );
    tickets.issue(
      "other",
      "user:other",
      "development:character:other",
      "Other Ranger",
    );
    const endpoint = await startChatServer({
      enabled: true,
      playTickets: tickets,
    });
    const first = await joinWithTicket(endpoint, "first", true);
    const firstMessages: MapChatMessage[] = [];
    first.onMessage(SERVER_MESSAGES.mapChat, (message) => {
      firstMessages.push(message as MapChatMessage);
    });
    for (let index = 0; index < 4; index += 1) {
      first.send(CLIENT_MESSAGES.mapChat, { text: `first ${index}` });
    }
    await vi.waitFor(() => expect(firstMessages).toHaveLength(4));
    joinedRooms.splice(joinedRooms.indexOf(first), 1);
    await first.leave();

    const returning = await joinWithTicket(endpoint, "returning", true);
    const other = await joinWithTicket(endpoint, "other");
    const returningRejections: string[] = [];
    const otherMessages: MapChatMessage[] = [];
    returning.onMessage(SERVER_MESSAGES.chatRejected, (message) => {
      returningRejections.push((message as { code: string }).code);
    });
    other.onMessage(SERVER_MESSAGES.mapChat, (message) => {
      otherMessages.push(message as MapChatMessage);
    });

    returning.send(CLIENT_MESSAGES.mapChat, { text: "new character" });
    other.send(CLIENT_MESSAGES.mapChat, { text: "separate user" });
    await vi.waitFor(() => {
      expect(returningRejections).toContain(ERROR_CODES.chatRateLimited);
      expect(otherMessages).toHaveLength(1);
    });
    expect(otherMessages[0]?.displayName).toBe("Other Ranger");
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
