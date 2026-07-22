import { Client, type Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  startFoundationServer,
  type RunningFoundationServer,
} from "../apps/server/src/server.js";
import {
  CLIENT_MESSAGES,
  ROOM_NAMES,
  SERVER_MESSAGES,
} from "../packages/protocol/src/index.js";

let runningServer: RunningFoundationServer | undefined;
const joinedRooms: Room[] = [];

afterEach(async () => {
  await Promise.all(
    joinedRooms.splice(0).map((room) => room.leave().catch(() => undefined)),
  );
  await runningServer?.close();
  runningServer = undefined;
});

describe("placement protocol privacy", () => {
  it("keeps internal room identity out of normal tickets, state, and messages", async () => {
    runningServer = await startFoundationServer({
      host: "127.0.0.1",
      port: 0,
      logger: false,
      readinessProbe: { check: () => Promise.resolve() },
      developmentLoginEnabled: true,
      runtimeEnvironment: "test",
    });
    const endpoint = `http://127.0.0.1:${String(runningServer.port)}`;
    const ticketResponse = await fetch(`${endpoint}/development/play-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Protocol Ranger" }),
    });
    const ticketJson = JSON.stringify(await ticketResponse.json());
    expect(ticketJson).not.toMatch(/roomId|room_id|instanceId|instance_id/i);

    const { ticket } = JSON.parse(ticketJson) as { ticket: string };
    const room = await new Client(endpoint).joinOrCreate(ROOM_NAMES.village, {
      ticket,
    });
    joinedRooms.push(room);
    await new Promise<void>((resolve) =>
      room.onStateChange.once(() => resolve()),
    );
    const stateJson = JSON.stringify(room.state);
    expect(stateJson).not.toMatch(/roomId|room_id|instanceId|instance_id/i);

    const movementMessage = new Promise<unknown>((resolve) => {
      room.onMessage(SERVER_MESSAGES.authoritativeMovement, resolve);
    });
    room.send(CLIENT_MESSAGES.movement, { x: 0, y: 0, sequence: 1 });
    expect(JSON.stringify(await movementMessage)).not.toMatch(
      /roomId|room_id|instanceId|instance_id/i,
    );
  });
});
