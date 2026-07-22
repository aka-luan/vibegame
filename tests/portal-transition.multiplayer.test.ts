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
  type TransitionRejectedMessage,
  type TransitionTicketMessage,
} from "../packages/protocol/src/index.js";
import { PORTAL_TRANSITION_COOLDOWN_MS } from "../apps/server/src/rooms/portal-transition.js";

let runningServer: RunningFoundationServer | undefined;
const joinedRooms: Room[] = [];

function leaveWithTimeout(room: Room): Promise<void> {
  return Promise.race([
    room.leave().then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
}

afterEach(async () => {
  await Promise.all(joinedRooms.splice(0).map(leaveWithTimeout));
  await runningServer?.close();
  runningServer = undefined;
}, 15_000);

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

async function issueTicket(
  endpoint: string,
  displayName: string,
  spawn?: { mapId: string; entranceId: string },
) {
  const response = await fetch(`${endpoint}/development/play-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName, ...spawn }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { ticket: string };
}

async function joinRoom(
  endpoint: string,
  roomName: string,
  displayName: string,
  spawn?: { mapId: string; entranceId: string },
) {
  const { ticket } = await issueTicket(endpoint, displayName, spawn);
  const room = await new Client(endpoint).joinOrCreate(roomName, { ticket });
  joinedRooms.push(room);
  return room;
}

async function waitUntil(assertion: () => void, timeout = 3_000) {
  await vi.waitFor(assertion, { timeout, interval: 20 });
}

function playerCount(room: Room): number {
  const state = JSON.parse(JSON.stringify(room.state)) as {
    players: Record<string, unknown>;
  };
  return Object.keys(state.players).length;
}

function displayNames(room: Room): string[] {
  const state = JSON.parse(JSON.stringify(room.state)) as {
    players: Record<string, { displayName: string }>;
  };
  return Object.values(state.players).map((player) => player.displayName);
}

const TRAVELER = "Recovering Ranger";

describe("portal transitions between village and forest", () => {
  it("moves a single presence from the village to the forest and back (AC3, AC7)", async () => {
    const endpoint = await startDevelopmentServer();
    // Spawned right beside the village's forest portal, so the transition
    // is exercised without spending real wall-clock time walking the map.
    const traveler = await joinRoom(
      endpoint,
      ROOM_NAMES.village,
      "Trailwarden",
      { mapId: "map:village", entranceId: "village_gate" },
    );
    const villageWitness = await joinRoom(
      endpoint,
      ROOM_NAMES.village,
      "Village Witness",
    );

    await waitUntil(() => {
      expect(playerCount(traveler)).toBe(2);
    });

    const ticketPromise = new Promise<TransitionTicketMessage>((resolve) => {
      traveler.onMessage<TransitionTicketMessage>(
        SERVER_MESSAGES.transitionTicket,
        resolve,
      );
    });
    traveler.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "transition-1",
      portalId: "portal_forest_gate",
    });
    const transitionTicket = await ticketPromise;
    expect(transitionTicket.destinationRoomName).toBe(ROOM_NAMES.forest);
    expect(transitionTicket.destinationMapId).toBe("map:forest");

    // Source presence is gone from the village the moment the ticket is
    // granted — never two copies of the traveler at once (AC3, AC7).
    await waitUntil(() => {
      expect(playerCount(villageWitness)).toBe(1);
    });

    const forest = await new Client(endpoint).joinOrCreate(
      transitionTicket.destinationRoomName,
      { ticket: transitionTicket.ticket },
    );
    joinedRooms.push(forest);
    const forestWitness = await joinRoom(
      endpoint,
      ROOM_NAMES.forest,
      "Forest Witness",
      { mapId: "map:forest", entranceId: "forest_edge" },
    );
    await waitUntil(() => {
      expect(playerCount(forestWitness)).toBe(2);
    });

    // Return trip: forest_edge is already next to the village portal. The
    // cooldown is per character and shared across rooms, so it survives the
    // transition that removed the source session — the return trip has to
    // wait it out.
    await new Promise((resolve) =>
      setTimeout(resolve, PORTAL_TRANSITION_COOLDOWN_MS + 100),
    );
    const returnTicketPromise = new Promise<TransitionTicketMessage>(
      (resolve) => {
        forest.onMessage<TransitionTicketMessage>(
          SERVER_MESSAGES.transitionTicket,
          resolve,
        );
      },
    );
    forest.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "transition-2",
      portalId: "portal_village_gate",
    });
    const returnTicket = await returnTicketPromise;
    expect(returnTicket.destinationRoomName).toBe(ROOM_NAMES.village);
    expect(returnTicket.destinationMapId).toBe("map:village");

    await waitUntil(() => {
      expect(playerCount(forestWitness)).toBe(1);
    });

    const backInVillage = await new Client(endpoint).joinOrCreate(
      returnTicket.destinationRoomName,
      { ticket: returnTicket.ticket },
    );
    joinedRooms.push(backInVillage);
    await waitUntil(() => {
      // Exactly one presence for the traveler plus the still-connected
      // witness: no duplication survives a full round trip.
      expect(playerCount(villageWitness)).toBe(2);
    });
  }, 20_000);

  it("rejects a transition request out of proximity range (AC2, AC6)", async () => {
    const endpoint = await startDevelopmentServer();
    const farFromPortal = await joinRoom(
      endpoint,
      ROOM_NAMES.village,
      "Distant Ranger",
    );
    const rejection = new Promise<TransitionRejectedMessage>((resolve) => {
      farFromPortal.onMessage<TransitionRejectedMessage>(
        SERVER_MESSAGES.transitionRejected,
        resolve,
      );
    });
    farFromPortal.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "transition-out-of-range",
      portalId: "portal_forest_gate",
    });
    const rejected = await rejection;
    expect(rejected.code).toBe(ERROR_CODES.portalOutOfRange);
    expect(playerCount(farFromPortal)).toBe(1);
  });

  it("rejects an unknown portal id (AC6)", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinRoom(endpoint, ROOM_NAMES.village, "Ranger", {
      mapId: "map:village",
      entranceId: "village_gate",
    });
    const rejection = new Promise<TransitionRejectedMessage>((resolve) => {
      player.onMessage<TransitionRejectedMessage>(
        SERVER_MESSAGES.transitionRejected,
        resolve,
      );
    });
    player.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "transition-unknown",
      portalId: "does_not_exist",
    });
    const rejected = await rejection;
    expect(rejected.code).toBe(ERROR_CODES.portalNotFound);
  });

  it("enforces the per-player cooldown against rapid repeat requests (AC6, replay)", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinRoom(endpoint, ROOM_NAMES.village, "Ranger", {
      mapId: "map:village",
      entranceId: "village_gate",
    });
    const messages: (TransitionTicketMessage | TransitionRejectedMessage)[] =
      [];
    player.onMessage<TransitionTicketMessage>(
      SERVER_MESSAGES.transitionTicket,
      (message) => messages.push(message),
    );
    player.onMessage<TransitionRejectedMessage>(
      SERVER_MESSAGES.transitionRejected,
      (message) => messages.push(message),
    );
    // Both requests leave the client before the server can finish the first
    // one, which is exactly the race that could hand out two valid
    // destination tickets for one character.
    player.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "first",
      portalId: "portal_forest_gate",
    });
    player.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "second",
      portalId: "portal_forest_gate",
    });
    await waitUntil(() => expect(messages).toHaveLength(2));
    const approvals = messages.filter((message) => "ticket" in message);
    const rejections = messages.filter(
      (message) => !("ticket" in message),
    ) as TransitionRejectedMessage[];
    expect(approvals).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.code).toBe(ERROR_CODES.portalOnCooldown);
  });

  it("rejects a replayed transition ticket at the destination (AC6, replay)", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinRoom(endpoint, ROOM_NAMES.village, "Ranger", {
      mapId: "map:village",
      entranceId: "village_gate",
    });
    const ticketPromise = new Promise<TransitionTicketMessage>((resolve) => {
      player.onMessage<TransitionTicketMessage>(
        SERVER_MESSAGES.transitionTicket,
        resolve,
      );
    });
    player.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "replay",
      portalId: "portal_forest_gate",
    });
    const { ticket } = await ticketPromise;

    const destination = await new Client(endpoint).joinOrCreate(
      ROOM_NAMES.forest,
      { ticket },
    );
    joinedRooms.push(destination);

    // The same ticket a second time must fail closed: a transition ticket is
    // consumed exactly once (ADR-0007), so a replay cannot produce a second
    // destination presence for the same character.
    await expect(
      new Client(endpoint).joinOrCreate(ROOM_NAMES.forest, { ticket }),
    ).rejects.toThrow();
    await waitUntil(() => expect(playerCount(destination)).toBe(1));
  });

  it("recovers to the village with a single presence after a rejected destination join (AC4, AC8)", async () => {
    const endpoint = await startDevelopmentServer();
    const traveler = await joinRoom(endpoint, ROOM_NAMES.village, TRAVELER, {
      mapId: "map:village",
      entranceId: "village_gate",
    });
    const witness = await joinRoom(
      endpoint,
      ROOM_NAMES.village,
      "Recovery Witness",
    );
    await waitUntil(() => expect(playerCount(witness)).toBe(2));

    const ticketPromise = new Promise<TransitionTicketMessage>((resolve) => {
      traveler.onMessage<TransitionTicketMessage>(
        SERVER_MESSAGES.transitionTicket,
        resolve,
      );
    });
    traveler.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "transition-fail",
      portalId: "portal_forest_gate",
    });
    const transitionTicket = await ticketPromise;

    // Source presence removed exactly once, regardless of what happens
    // next at the destination.
    await waitUntil(() => expect(playerCount(witness)).toBe(1));

    // Simulate a destination-join failure (e.g. the forest room rejects a
    // corrupted/expired ticket): the ticket is single-use, so replaying it
    // fails closed rather than duplicating a presence anywhere.
    await expect(
      new Client(endpoint).joinOrCreate(ROOM_NAMES.forest, {
        ticket: `${transitionTicket.ticket}-corrupted`,
      }),
    ).rejects.toThrow();

    // The failed destination join must leave no presence behind in the
    // forest either: a witness joining the destination sees only itself.
    const forestWitness = await joinRoom(
      endpoint,
      ROOM_NAMES.forest,
      "Forest Witness",
      { mapId: "map:forest", entranceId: "forest_edge" },
    );
    await waitUntil(() => expect(playerCount(forestWitness)).toBe(1));

    // Recovery: the client falls back to requesting a fresh play ticket
    // and rejoining. (A real account's fresh ticket resolves to the
    // character's last checkpointed safe location via
    // GuestAccountService.issuePlayTicket; the in-memory development path
    // used here restarts a fresh development identity at the village
    // entrance, so the assertion below is on the display name rather than
    // on a raw count.)
    const recovered = await joinRoom(endpoint, ROOM_NAMES.village, TRAVELER, {
      mapId: "map:village",
      entranceId: "village_gate",
    });
    await waitUntil(() => expect(playerCount(witness)).toBe(2));
    // Exactly one "Recovering Ranger" exists across both rooms — the
    // traveler was removed from the source, never landed in the
    // destination, and came back exactly once (AC4, AC8).
    await waitUntil(() => {
      expect(displayNames(witness).filter((name) => name === TRAVELER)).toEqual(
        [TRAVELER],
      );
      expect(displayNames(forestWitness)).toEqual(["Forest Witness"]);
    });
    expect(playerCount(recovered)).toBe(2);
  });
});
