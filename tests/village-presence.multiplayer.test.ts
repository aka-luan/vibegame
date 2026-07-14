import { Client, type Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startFoundationServer,
  type RunningFoundationServer,
} from "../apps/server/src/server.js";
import { ERROR_CODES } from "../packages/protocol/src/index.js";
import {
  CLIENT_MESSAGES,
  ROOM_NAMES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
} from "../packages/protocol/src/index.js";

let runningServer: RunningFoundationServer | undefined;
const joinedRooms: Room[] = [];

afterEach(async () => {
  await Promise.all(joinedRooms.splice(0).map((room) => room.leave()));
  await runningServer?.close();
  runningServer = undefined;
});

async function startDevelopmentServer(options?: {
  now?: () => number;
  reconnectGraceSeconds?: number;
}) {
  runningServer = await startFoundationServer({
    host: "127.0.0.1",
    port: 0,
    logger: false,
    readinessProbe: { check: () => Promise.resolve() },
    developmentLoginEnabled: true,
    runtimeEnvironment: "test",
    now: options?.now,
    reconnectGraceSeconds: options?.reconnectGraceSeconds,
  });
  return `http://127.0.0.1:${String(runningServer.port)}`;
}

async function issueTicket(endpoint: string, displayName: string) {
  const response = await fetch(`${endpoint}/development/play-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { ticket: string };
}

async function joinVillage(endpoint: string, displayName: string) {
  const { ticket } = await issueTicket(endpoint, displayName);
  const room = await new Client(endpoint).joinOrCreate(ROOM_NAMES.village, {
    ticket,
  });
  joinedRooms.push(room);
  return room;
}

async function waitUntil(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3_000, interval: 20 });
}

interface ObservedPlayer {
  x: number;
  y: number;
  facing: string;
  animation: string;
}

function observedPlayer(
  room: Room,
  entityId: string,
): ObservedPlayer | undefined {
  const state = JSON.parse(JSON.stringify(room.state)) as {
    players: Record<string, ObservedPlayer>;
  };
  return state.players[entityId];
}

describe("development play ticket admission", () => {
  it("admits a ticket exactly once", async () => {
    const endpoint = await startDevelopmentServer();
    const { ticket } = await issueTicket(endpoint, "First Ranger");
    const sdk = new Client(endpoint);

    const room = await sdk.joinOrCreate(ROOM_NAMES.village, { ticket });
    joinedRooms.push(room);

    await expect(
      sdk.joinOrCreate(ROOM_NAMES.village, { ticket }),
    ).rejects.toThrow(ERROR_CODES.playTicketReplayed);
  });

  it("rejects an expired ticket without admitting a player", async () => {
    let now = 10_000;
    const endpoint = await startDevelopmentServer({ now: () => now });
    const { ticket } = await issueTicket(endpoint, "Late Ranger");
    now += 15_000;

    await expect(
      new Client(endpoint).joinOrCreate(ROOM_NAMES.village, { ticket }),
    ).rejects.toThrow(ERROR_CODES.playTicketExpired);
  });

  it("rejects an unknown ticket", async () => {
    const endpoint = await startDevelopmentServer();
    await expect(
      new Client(endpoint).joinOrCreate(ROOM_NAMES.village, {
        ticket: "not-issued",
      }),
    ).rejects.toThrow(ERROR_CODES.invalidPlayTicket);
  });

  it("does not expose development admission when its gate is disabled", async () => {
    runningServer = await startFoundationServer({
      host: "127.0.0.1",
      port: 0,
      logger: false,
      readinessProbe: { check: () => Promise.resolve() },
    });
    const response = await fetch(
      `http://127.0.0.1:${String(runningServer.port)}/development/play-ticket`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  it("refuses to start production with development admission enabled", async () => {
    await expect(
      startFoundationServer({
        host: "127.0.0.1",
        port: 0,
        logger: false,
        readinessProbe: { check: () => Promise.resolve() },
        developmentLoginEnabled: true,
        runtimeEnvironment: "production",
      }),
    ).rejects.toThrow(/development login/i);
  });
});

describe("village public presence", () => {
  it("synchronizes only render-safe public player state", async () => {
    const endpoint = await startDevelopmentServer();
    const first = await joinVillage(endpoint, "First Ranger");
    const second = await joinVillage(endpoint, "Second Ranger");

    await waitUntil(() => {
      const firstState = JSON.stringify(first.state);
      const secondState = JSON.stringify(second.state);
      for (const state of [firstState, secondState]) {
        expect(state).toContain("First Ranger");
        expect(state).toContain("Second Ranger");
        expect(state).toContain("rig:village_placeholder");
        expect(state).toContain('"facing":"south"');
        expect(state).toContain('"animation":"idle"');
        expect(state).not.toMatch(/userId|characterId|roomId|ticket/i);
        expect(state).not.toContain("lastProcessedSequence");
      }
    });
  });

  it("converges on fixed-step authoritative movement", async () => {
    const endpoint = await startDevelopmentServer();
    const first = await joinVillage(endpoint, "Moving Ranger");
    const observer = await joinVillage(endpoint, "Watching Ranger");

    first.send(CLIENT_MESSAGES.movement, { x: 1, y: 0, sequence: 1 });

    await waitUntil(() => {
      for (const room of [first, observer]) {
        const player = observedPlayer(room, first.sessionId);
        expect(player?.x).toBeGreaterThan(128);
        expect(player?.facing).toBe("east");
        expect(player?.animation).toBe("walk");
      }
    });

    first.send(CLIENT_MESSAGES.movement, { x: 0, y: 0, sequence: 2 });
    await waitUntil(() => {
      expect(observedPlayer(observer, first.sessionId)?.animation).toBe("idle");
    });
  });

  it("processes delayed and out-of-order input once in sequence order", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinVillage(endpoint, "Sequenced Ranger");
    const rejections: string[] = [];
    let authoritative: AuthoritativeMovementSnapshot | undefined;
    player.onMessage<{ code: string }>(
      SERVER_MESSAGES.intentionRejected,
      ({ code }) => rejections.push(code),
    );
    player.onMessage<AuthoritativeMovementSnapshot>(
      SERVER_MESSAGES.authoritativeMovement,
      (snapshot) => {
        authoritative = snapshot;
      },
    );

    player.send(CLIENT_MESSAGES.movement, { x: 0, y: 0, sequence: 2 });
    player.send(CLIENT_MESSAGES.movement, { x: 1, y: 0, sequence: 1 });
    player.send(CLIENT_MESSAGES.movement, { x: 1, y: 0, sequence: 1 });

    await waitUntil(() => {
      expect(authoritative?.lastProcessedSequence).toBe(2);
      expect(authoritative?.x).toBeCloseTo(132.6, 4);
    });
    expect(rejections).toEqual([]);
  });

  it.each([150, 250])(
    "converges without exceeding authoritative speed at %i ms latency",
    async (latencyMs) => {
      const endpoint = await startDevelopmentServer();
      const player = await joinVillage(endpoint, "Latency Ranger");
      const observer = await joinVillage(endpoint, "Latency Observer");
      let authoritative: AuthoritativeMovementSnapshot | undefined;
      const observerCorrections: AuthoritativeMovementSnapshot[] = [];
      player.onMessage<AuthoritativeMovementSnapshot>(
        SERVER_MESSAGES.authoritativeMovement,
        (snapshot) => {
          authoritative = snapshot;
        },
      );
      observer.onMessage<AuthoritativeMovementSnapshot>(
        SERVER_MESSAGES.authoritativeMovement,
        (snapshot) => observerCorrections.push(snapshot),
      );
      const sends: Promise<void>[] = [];
      for (let sequence = 1; sequence <= 10; sequence += 1) {
        sends.push(
          new Promise((resolve) => {
            setTimeout(
              () => {
                player.send(CLIENT_MESSAGES.movement, {
                  x: 1,
                  y: 0,
                  sequence,
                });
                resolve();
              },
              latencyMs / 2 + sequence * 50,
            );
          }),
        );
      }
      await Promise.all(sends);

      await waitUntil(() => {
        expect(authoritative?.lastProcessedSequence).toBe(10);
        for (const room of [player, observer]) {
          const observed = observedPlayer(room, player.sessionId);
          expect(observed?.x).toBeCloseTo(174, 4);
        }
      });
      expect(observerCorrections).toEqual([]);
    },
  );

  it("rejects forged coordinates and excessive speed", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinVillage(endpoint, "Honest Ranger");
    const rejections: string[] = [];
    player.onMessage<{ code: string }>(
      SERVER_MESSAGES.intentionRejected,
      ({ code }) => rejections.push(code),
    );

    player.send(CLIENT_MESSAGES.movement, {
      x: 1,
      y: 0,
      sequence: 1,
      position: { x: 500, y: 300 },
    });
    player.send(CLIENT_MESSAGES.movement, { x: 1, y: 1, sequence: 2 });
    player.send(CLIENT_MESSAGES.movement, {
      x: "east",
      y: 0,
      sequence: 3,
    });

    await waitUntil(() => {
      expect(rejections).toEqual([
        ERROR_CODES.invalidMovementIntention,
        ERROR_CODES.invalidMovementIntention,
        ERROR_CODES.invalidMovementIntention,
      ]);
    });
    expect(observedPlayer(player, player.sessionId)?.x).toBe(128);
    expect(observedPlayer(player, player.sessionId)?.y).toBe(224);
  });

  it("bounds movement messages and removes repeat hostile senders", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinVillage(endpoint, "Hostile Ranger");
    const rejections: string[] = [];
    player.onMessage<{ code: string }>(
      SERVER_MESSAGES.intentionRejected,
      ({ code }) => rejections.push(code),
    );
    const leaveCode = new Promise<number>((resolve) =>
      player.onLeave.once((code) => resolve(code)),
    );

    player.send(CLIENT_MESSAGES.movement, {
      x: 0,
      y: 0,
      sequence: 1,
      padding: "x".repeat(300),
    });
    await waitUntil(() => {
      expect(rejections).toEqual([ERROR_CODES.invalidMovementIntention]);
    });
    for (let sequence = 2; sequence <= 5; sequence += 1) {
      player.send(CLIENT_MESSAGES.movement, {
        x: "east",
        y: 0,
        sequence,
      });
    }

    await expect(leaveCode).resolves.toBe(4_008);
    joinedRooms.splice(joinedRooms.indexOf(player), 1);
  });

  it("removes a leaving entity from every remaining client", async () => {
    const endpoint = await startDevelopmentServer();
    const leaving = await joinVillage(endpoint, "Leaving Ranger");
    const staying = await joinVillage(endpoint, "Staying Ranger");
    await waitUntil(() => {
      expect(observedPlayer(staying, leaving.sessionId)).toBeDefined();
    });

    await leaving.leave();
    joinedRooms.splice(joinedRooms.indexOf(leaving), 1);

    await waitUntil(() => {
      expect(observedPlayer(staying, leaving.sessionId)).toBeUndefined();
    });
  });

  it("restores the same live entity after a short disconnect", async () => {
    const endpoint = await startDevelopmentServer();
    const reconnecting = await joinVillage(endpoint, "Returning Ranger");
    const observer = await joinVillage(endpoint, "Patient Ranger");
    const entityId = reconnecting.sessionId;
    reconnecting.reconnection.minUptime = 0;
    reconnecting.reconnection.minDelay = 10;
    reconnecting.reconnection.delay = 10;
    reconnecting.reconnection.maxDelay = 20;
    const didReconnect = new Promise<void>((resolve) =>
      reconnecting.onReconnect.once(resolve),
    );

    void reconnecting.leave(false);
    await expect(didReconnect).resolves.toBeUndefined();
    expect(reconnecting.sessionId).toBe(entityId);
    await waitUntil(() => {
      expect(observedPlayer(reconnecting, entityId)).toBeDefined();
      expect(observedPlayer(observer, entityId)).toBeDefined();
    });
  });

  it("removes a disconnected entity after its reconnect grace expires", async () => {
    const endpoint = await startDevelopmentServer({
      reconnectGraceSeconds: 0.1,
    });
    const expiring = await joinVillage(endpoint, "Expired Ranger");
    const observer = await joinVillage(endpoint, "Cleanup Ranger");
    const entityId = expiring.sessionId;
    expiring.reconnection.enabled = false;
    const didLeave = new Promise<void>((resolve) =>
      expiring.onLeave.once(() => resolve()),
    );

    void expiring.leave(false);
    await didLeave;
    joinedRooms.splice(joinedRooms.indexOf(expiring), 1);
    await waitUntil(() => {
      expect(observedPlayer(observer, entityId)).toBeUndefined();
    });
  });
});
