import { Client, type Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocationCheckpointInput } from "../packages/database/src/index.js";
import {
  startFoundationServer,
  type RunningFoundationServer,
} from "../apps/server/src/server.js";
import {
  ROOM_NAMES,
  type PublicVillageState,
} from "../packages/protocol/src/index.js";

let runningServer: RunningFoundationServer | undefined;
const joinedRooms: Room[] = [];

async function leaveRoom(room: Room): Promise<void> {
  await room.leave().catch(() => undefined);
}

afterEach(async () => {
  await Promise.all(joinedRooms.splice(0).map(leaveRoom));
  await runningServer?.close();
  runningServer = undefined;
});

async function startPlacementServer(options?: {
  softPopulationTarget?: number;
  hardCapacity?: number;
  inspect?: boolean;
  checkpointLocation?: (input: LocationCheckpointInput) => Promise<boolean>;
  checkpointTimeoutMs?: number;
  recordCheckpointTimeout?: (details: {
    logicalMapId: string;
    sessionId: string;
    connectionState: LocationCheckpointInput["connectionState"];
    timeoutMs: number;
  }) => void;
}) {
  runningServer = await startFoundationServer({
    host: "127.0.0.1",
    port: 0,
    logger: false,
    readinessProbe: { check: () => Promise.resolve() },
    developmentLoginEnabled: true,
    developmentInstanceInspectionEnabled: options?.inspect ?? true,
    runtimeEnvironment: "test",
    softPopulationTarget: options?.softPopulationTarget,
    hardCapacity: options?.hardCapacity,
    checkpointLocation: options?.checkpointLocation,
    checkpointTimeoutMs: options?.checkpointTimeoutMs,
    recordCheckpointTimeout: options?.recordCheckpointTimeout,
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

async function joinVillage(
  endpoint: string,
  displayName: string,
): Promise<Room> {
  const { ticket } = await issueTicket(endpoint, displayName);
  const room = await new Client(endpoint).joinOrCreate(ROOM_NAMES.village, {
    ticket,
  });
  joinedRooms.push(room);
  return room;
}

function countPlayers(state: PublicVillageState): number {
  let count = 0;
  state.players?.forEach(() => {
    count += 1;
  });
  return count;
}

async function waitUntil(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 3_000, interval: 20 });
}

async function inspect(endpoint: string) {
  const response = await fetch(`${endpoint}/development/instances`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    instances: {
      logicalMapId: string;
      roomId: string;
      clients: number;
      hardCapacity: number;
    }[];
  };
}

describe("headless map-instance placement", () => {
  it("creates separate hidden instances behind one logical map name", async () => {
    const endpoint = await startPlacementServer({
      softPopulationTarget: 1,
      hardCapacity: 2,
    });
    const first = await joinVillage(endpoint, "First Overflow Ranger");
    const second = await joinVillage(endpoint, "Second Overflow Ranger");

    expect(first.roomId).not.toBe(second.roomId);
    await waitUntil(() => {
      expect(countPlayers(first.state as PublicVillageState)).toBe(1);
      expect(countPlayers(second.state as PublicVillageState)).toBe(1);
    });

    const diagnostics = await inspect(endpoint);
    expect(diagnostics.instances).toHaveLength(2);
    expect(
      diagnostics.instances.every(
        (instance) => instance.logicalMapId === "map:village",
      ),
    ).toBe(true);
    expect(
      diagnostics.instances.every((instance) => instance.clients <= 2),
    ).toBe(true);
  });

  it("keeps hard capacity intact across concurrent joins", async () => {
    const endpoint = await startPlacementServer({
      softPopulationTarget: 2,
      hardCapacity: 2,
    });
    const rooms = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        joinVillage(endpoint, `Concurrent Ranger ${String(index)}`),
      ),
    );

    const diagnostics = await inspect(endpoint);
    expect(
      diagnostics.instances.reduce(
        (total, instance) => total + instance.clients,
        0,
      ),
    ).toBe(8);
    expect(
      diagnostics.instances.every(
        (instance) => instance.clients <= instance.hardCapacity,
      ),
    ).toBe(true);
    expect(new Set(rooms.map((room) => room.roomId)).size).toBeGreaterThan(1);
  });

  it("rejects a client-selected map instance id", async () => {
    const endpoint = await startPlacementServer({
      softPopulationTarget: 1,
      hardCapacity: 2,
    });
    const first = await joinVillage(endpoint, "First Protected Ranger");
    const { ticket } = await issueTicket(endpoint, "Blocked Selector");

    await expect(
      new Client(endpoint).joinById(first.roomId, { ticket }),
    ).rejects.toThrow();

    const diagnostics = await inspect(endpoint);
    expect(diagnostics.instances).toHaveLength(1);
    expect(diagnostics.instances[0]?.roomId).toBe(first.roomId);
    expect(diagnostics.instances[0]?.clients).toBe(1);
  });

  it("bounds a hung final checkpoint so a room can release its seat", async () => {
    const timeoutEvents: {
      connectionState: LocationCheckpointInput["connectionState"];
      timeoutMs: number;
    }[] = [];
    const endpoint = await startPlacementServer({
      checkpointLocation: () => new Promise<boolean>(() => undefined),
      checkpointTimeoutMs: 20,
      recordCheckpointTimeout: (details) => {
        timeoutEvents.push({
          connectionState: details.connectionState,
          timeoutMs: details.timeoutMs,
        });
      },
    });
    const room = await joinVillage(endpoint, "Checkpoint Timeout Ranger");
    const startedAt = Date.now();

    await room.leave();
    joinedRooms.splice(joinedRooms.indexOf(room), 1);

    expect(Date.now() - startedAt).toBeLessThan(500);
    await vi.waitFor(() => {
      expect(timeoutEvents).toContainEqual({
        connectionState: "offline",
        timeoutMs: 20,
      });
    });
    await vi.waitFor(async () => {
      expect((await inspect(endpoint)).instances).toHaveLength(0);
    });
  });
});

describe("development instance inspection gate", () => {
  it("does not expose diagnostics when the explicit gate is disabled", async () => {
    const endpoint = await startPlacementServer({ inspect: false });
    const response = await fetch(`${endpoint}/development/instances`);
    expect(response.status).toBe(404);
  });
});
