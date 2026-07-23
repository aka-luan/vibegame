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
  type PartyInvitationMessage,
  type PartyResultMessage,
  type PartyStateMessage,
  type TransitionRejectedMessage,
  type TransitionTicketMessage,
} from "../packages/protocol/src/index.js";

let runningServer: RunningFoundationServer | undefined;
const joinedRooms: Room[] = [];

afterEach(async () => {
  await Promise.all(
    joinedRooms.splice(0).map((room) => room.leave().catch(() => undefined)),
  );
  await runningServer?.close();
  runningServer = undefined;
}, 15_000);

async function startPartyServer(
  options: {
    hardCapacity?: number;
    now?: () => number;
    reconnectGraceSeconds?: number;
  } = {},
) {
  runningServer = await startFoundationServer({
    host: "127.0.0.1",
    port: 0,
    logger: false,
    readinessProbe: { check: () => Promise.resolve() },
    developmentLoginEnabled: true,
    developmentInstanceInspectionEnabled: true,
    runtimeEnvironment: "test",
    hardCapacity: options.hardCapacity,
    softPopulationTarget: options.hardCapacity,
    now: options.now,
    reconnectGraceSeconds: options.reconnectGraceSeconds,
  });
  return `http://127.0.0.1:${String(runningServer.port)}`;
}

async function join(
  endpoint: string,
  displayName: string,
  spawn?: { mapId: string; entranceId: string },
): Promise<Room> {
  const response = await fetch(`${endpoint}/development/play-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName, ...spawn }),
  });
  expect(response.status).toBe(201);
  const { ticket } = (await response.json()) as { ticket: string };
  const room = await new Client(endpoint).joinOrCreate(
    spawn?.mapId === "map:forest" ? ROOM_NAMES.forest : ROOM_NAMES.village,
    { ticket },
  );
  joinedRooms.push(room);
  return room;
}

function nextMessage<T>(room: Room, type: string): Promise<T> {
  return new Promise<T>((resolve) => room.onMessage<T>(type, resolve));
}

async function formParty(leader: Room, members: readonly Room[]) {
  for (const member of members) {
    const invitation = nextMessage<PartyInvitationMessage>(
      member,
      SERVER_MESSAGES.partyInvitation,
    );
    leader.send(CLIENT_MESSAGES.partyInvite, {
      actionId: `invite:${member.sessionId}`,
      targetEntityId: member.sessionId,
    });
    const invited = await invitation;
    const accepted = nextMessage<PartyResultMessage>(
      member,
      SERVER_MESSAGES.partyResult,
    );
    member.send(CLIENT_MESSAGES.partyAccept, {
      actionId: `accept:${member.sessionId}`,
      invitationId: invited.invitationId,
    });
    await expect(accepted).resolves.toMatchObject({ accepted: true });
  }
}

async function joinTransition(
  endpoint: string,
  transition: TransitionTicketMessage,
): Promise<Room> {
  const room = await new Client(endpoint).joinOrCreate(
    transition.destinationRoomName,
    { ticket: transition.ticket },
  );
  joinedRooms.push(room);
  return room;
}

describe("party races and cohesive travel", () => {
  it("forms at four under simultaneous accepts and keeps payloads private", async () => {
    const endpoint = await startPartyServer({ hardCapacity: 8 });
    const leader = await join(endpoint, "Leader");
    const members = await Promise.all(
      ["Two", "Three", "Four", "Five"].map((name) => join(endpoint, name)),
    );
    const invitations = members.map((member) =>
      nextMessage<PartyInvitationMessage>(
        member,
        SERVER_MESSAGES.partyInvitation,
      ),
    );
    for (const member of members) {
      leader.send(CLIENT_MESSAGES.partyInvite, {
        actionId: `invite:${member.sessionId}`,
        targetEntityId: member.sessionId,
      });
    }
    const invitationMessages = await Promise.all(invitations);
    const results = members.map((member) =>
      nextMessage<PartyResultMessage>(member, SERVER_MESSAGES.partyResult),
    );
    for (const [index, member] of members.entries()) {
      member.send(CLIENT_MESSAGES.partyAccept, {
        actionId: `accept:${member.sessionId}`,
        invitationId: invitationMessages[index]!.invitationId,
      });
    }
    const decisions = await Promise.all(results);

    expect(decisions.filter((decision) => decision.accepted)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.accepted)).toEqual([
      expect.objectContaining({ code: ERROR_CODES.partyFull }),
    ]);
    const stateMessage = nextMessage<PartyStateMessage>(
      leader,
      SERVER_MESSAGES.partyState,
    );
    leader.send(CLIENT_MESSAGES.partyStateRequest);
    const state = await stateMessage;
    expect(state.members).toHaveLength(4);
    expect(JSON.stringify(state)).not.toMatch(
      /userId|characterId|partyId|roomId|session|internal/i,
    );
  });

  it("moves a three-client party into one reserved destination in both directions", async () => {
    let nowMs = 1_000;
    const endpoint = await startPartyServer({
      hardCapacity: 4,
      now: () => nowMs,
    });
    const spawn = { mapId: "map:village", entranceId: "village_gate" };
    const leader = await join(endpoint, "Leader", spawn);
    const memberOne = await join(endpoint, "Member One", spawn);
    const memberTwo = await join(endpoint, "Member Two", spawn);
    await formParty(leader, [memberOne, memberTwo]);

    const outbound = [leader, memberOne, memberTwo].map((room) =>
      nextMessage<TransitionTicketMessage>(
        room,
        SERVER_MESSAGES.transitionTicket,
      ),
    );
    leader.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "party-to-forest",
      portalId: "portal_forest_gate",
    });
    const forestTickets = await Promise.all(outbound);
    const forestRooms = await Promise.all(
      forestTickets.map((ticket) => joinTransition(endpoint, ticket)),
    );
    expect(new Set(forestRooms.map((room) => room.roomId)).size).toBe(1);

    nowMs += 2_100;
    const inbound = forestRooms.map((room) =>
      nextMessage<TransitionTicketMessage>(
        room,
        SERVER_MESSAGES.transitionTicket,
      ),
    );
    forestRooms[0]!.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "party-to-village",
      portalId: "portal_village_gate",
    });
    const villageTickets = await Promise.all(inbound);
    const villageRooms = await Promise.all(
      villageTickets.map((ticket) => joinTransition(endpoint, ticket)),
    );
    expect(new Set(villageRooms.map((room) => room.roomId)).size).toBe(1);
  }, 20_000);

  it("serializes simultaneous portal intentions into one cohesive travel", async () => {
    const endpoint = await startPartyServer({ hardCapacity: 4 });
    const spawn = { mapId: "map:village", entranceId: "village_gate" };
    const leader = await join(endpoint, "Leader", spawn);
    const member = await join(endpoint, "Member", spawn);
    await formParty(leader, [member]);
    const leaderTicket = nextMessage<TransitionTicketMessage>(
      leader,
      SERVER_MESSAGES.transitionTicket,
    );
    const memberTicket = nextMessage<TransitionTicketMessage>(
      member,
      SERVER_MESSAGES.transitionTicket,
    );
    const memberRejection = nextMessage<TransitionRejectedMessage>(
      member,
      SERVER_MESSAGES.transitionRejected,
    );

    member.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "simultaneous-member",
      portalId: "portal_forest_gate",
    });
    leader.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "simultaneous-leader",
      portalId: "portal_forest_gate",
    });

    await expect(memberRejection).resolves.toMatchObject({
      actionId: "simultaneous-member",
      code: ERROR_CODES.partyNotLeader,
    });
    const destinationRooms = await Promise.all(
      [await leaderTicket, await memberTicket].map((ticket) =>
        joinTransition(endpoint, ticket),
      ),
    );
    expect(new Set(destinationRooms.map((room) => room.roomId)).size).toBe(1);
  });

  it("keeps the requester in place when a competing join takes the member's last seat", async () => {
    const endpoint = await startPartyServer({ hardCapacity: 2 });
    const spawn = { mapId: "map:village", entranceId: "village_gate" };
    const leader = await join(endpoint, "Leader", spawn);
    const member = await join(endpoint, "Member", spawn);
    await formParty(leader, [member]);

    const memberTicket = nextMessage<TransitionTicketMessage>(
      member,
      SERVER_MESSAGES.transitionTicket,
    );
    member.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "member-solo-before-capacity-race",
      portalId: "portal_forest_gate",
      travelMode: "alone",
    });
    const memberInForest = await joinTransition(endpoint, await memberTicket);
    const competingJoin = await join(endpoint, "Competing Join", {
      mapId: "map:forest",
      entranceId: "forest_edge",
    });
    expect(competingJoin.roomId).toBe(memberInForest.roomId);

    let issuedTickets = 0;
    leader.onMessage(SERVER_MESSAGES.transitionTicket, () => {
      issuedTickets += 1;
    });
    const rejected = nextMessage<PartyResultMessage>(
      leader,
      SERVER_MESSAGES.partyResult,
    );

    leader.send(CLIENT_MESSAGES.partyTravelToMember, {
      actionId: "party-capacity-lost",
      targetEntityId: memberInForest.sessionId,
    });

    await expect(rejected).resolves.toEqual({
      accepted: false,
      actionId: "party-capacity-lost",
      code: ERROR_CODES.instanceUnavailable,
    });
    expect(issuedTickets).toBe(0);
    expect(leader.connection.isOpen).toBe(true);
    expect(leader.roomId).not.toBe(memberInForest.roomId);
  });

  it("reunites an intentionally split member with travel-to-member", async () => {
    const endpoint = await startPartyServer({ hardCapacity: 4 });
    const spawn = { mapId: "map:village", entranceId: "village_gate" };
    const leader = await join(endpoint, "Leader", spawn);
    const member = await join(endpoint, "Member", spawn);
    await formParty(leader, [member]);

    const memberTicket = nextMessage<TransitionTicketMessage>(
      member,
      SERVER_MESSAGES.transitionTicket,
    );
    member.send(CLIENT_MESSAGES.portalTransition, {
      actionId: "member-solo-travel",
      portalId: "portal_forest_gate",
      travelMode: "alone",
    });
    const memberInForest = await joinTransition(endpoint, await memberTicket);

    let memberState: PartyStateMessage | undefined;
    memberInForest.onMessage<PartyStateMessage>(
      SERVER_MESSAGES.partyState,
      (state) => {
        memberState = state;
      },
    );
    memberInForest.send(CLIENT_MESSAGES.partyStateRequest);
    await vi.waitFor(() => {
      expect(memberState?.members).toHaveLength(2);
    });
    const forestEntity = memberState!.members.find(
      (candidate) => candidate.displayName === "Member",
    )!.entityId;

    const leaderTicket = nextMessage<TransitionTicketMessage>(
      leader,
      SERVER_MESSAGES.transitionTicket,
    );
    leader.send(CLIENT_MESSAGES.partyTravelToMember, {
      actionId: "leader-reunite",
      targetEntityId: forestEntity,
    });
    const leaderInForest = await joinTransition(endpoint, await leaderTicket);
    expect(leaderInForest.roomId).toBe(memberInForest.roomId);
  });

  it("promotes a remaining member when the leader disconnects", async () => {
    const endpoint = await startPartyServer({
      hardCapacity: 4,
      reconnectGraceSeconds: 0.05,
    });
    const leader = await join(endpoint, "Leader");
    const memberOne = await join(endpoint, "Member One");
    const memberTwo = await join(endpoint, "Member Two");
    await formParty(leader, [memberOne, memberTwo]);
    let state: PartyStateMessage | undefined;
    memberOne.onMessage<PartyStateMessage>(
      SERVER_MESSAGES.partyState,
      (next) => {
        state = next;
      },
    );

    leader.reconnection.enabled = false;
    await leader.leave(false);
    await vi.waitFor(() => {
      expect(state?.members).toHaveLength(2);
      expect(
        state?.members.find((member) => member.displayName === "Member One")
          ?.leader,
      ).toBe(true);
    });
  });
});
