import { describe, expect, it } from "vitest";

import { ERROR_CODES, SERVER_MESSAGES } from "@gameish/protocol";

import { PartyCoordinator, type PartyPresence } from "./coordinator.js";

function presence(
  memberId: string,
  entityId: string,
  messages: { type: string; payload: unknown }[],
  overrides: Partial<PartyPresence> = {},
): PartyPresence {
  return {
    memberId,
    userId: `user:${memberId}`,
    entityId,
    displayName: memberId.replace("character:", ""),
    logicalMapId: "map:village",
    internalRoomId: "internal-room-one",
    send(type, payload) {
      messages.push({ type, payload });
    },
    ...overrides,
  };
}

function formParty(coordinator: PartyCoordinator) {
  const leaderMessages: { type: string; payload: unknown }[] = [];
  const memberMessages: { type: string; payload: unknown }[] = [];
  coordinator.registerPresence(
    presence("character:leader", "entity:leader", leaderMessages),
  );
  coordinator.registerPresence(
    presence("character:member", "entity:member", memberMessages),
  );
  expect(coordinator.invite("character:leader", "entity:member")).toEqual({
    accepted: true,
  });
  expect(coordinator.accept("character:member", "party-invite:1")).toEqual({
    accepted: true,
  });
  return { leaderMessages, memberMessages };
}

describe("in-memory Party Coordinator", () => {
  it("publishes client party state without durable or room identity", () => {
    const coordinator = new PartyCoordinator();
    const { memberMessages } = formParty(coordinator);
    const state = memberMessages
      .filter((message) => message.type === SERVER_MESSAGES.partyState)
      .at(-1)?.payload;
    const encoded = JSON.stringify(state);

    expect(encoded).toContain("entity:leader");
    expect(encoded).toContain("map:village");
    expect(encoded).not.toContain("character:");
    expect(encoded).not.toContain("internal-room");
    expect(encoded).not.toMatch(/userId|roomId|partyId|session/i);
  });

  it("serializes simultaneous accepts through the decider", () => {
    const coordinator = new PartyCoordinator();
    const messages: { type: string; payload: unknown }[] = [];
    for (const [index, memberId] of [
      "character:leader",
      "character:two",
      "character:three",
      "character:four",
      "character:five",
    ].entries()) {
      coordinator.registerPresence(
        presence(memberId, `entity:${String(index)}`, messages),
      );
    }
    for (const targetEntityId of [
      "entity:1",
      "entity:2",
      "entity:3",
      "entity:4",
    ]) {
      expect(
        coordinator.invite("character:leader", targetEntityId).accepted,
      ).toBe(true);
    }
    for (const [invitationId, memberId] of [
      ["party-invite:1", "character:two"],
      ["party-invite:2", "character:three"],
      ["party-invite:3", "character:four"],
    ] as const) {
      expect(coordinator.accept(memberId, invitationId).accepted).toBe(true);
    }

    expect(coordinator.accept("character:five", "party-invite:4")).toEqual({
      accepted: false,
      code: ERROR_CODES.partyFull,
    });
    expect(coordinator.stateFor("character:leader").members).toHaveLength(4);
  });

  it("claims one cohesive travel at a time and requires co-location", () => {
    const coordinator = new PartyCoordinator();
    formParty(coordinator);

    const first = coordinator.beginCohesiveTravel(
      "character:leader",
      "internal-room-one",
    );
    expect(first.accepted && first.members).toHaveLength(2);
    expect(
      coordinator.beginCohesiveTravel("character:leader", "internal-room-one"),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyTravelInProgress,
    });
    if (first.accepted) {
      coordinator.cancelTravel(first.members.map((member) => member.memberId));
    }
  });

  it("lets a non-leader intentionally travel alone", () => {
    const coordinator = new PartyCoordinator();
    formParty(coordinator);

    expect(
      coordinator.beginCohesiveTravel("character:member", "internal-room-one"),
    ).toEqual({ accepted: false, code: ERROR_CODES.partyNotLeader });
    const travel = coordinator.beginCohesiveTravel(
      "character:member",
      "internal-room-one",
      true,
    );
    expect(
      travel.accepted && travel.members.map((member) => member.memberId),
    ).toEqual(["character:member"]);
  });

  it("checks the party relationship before travel-to-member", () => {
    const coordinator = new PartyCoordinator();
    formParty(coordinator);
    const strangerMessages: { type: string; payload: unknown }[] = [];
    coordinator.registerPresence(
      presence("character:stranger", "entity:stranger", strangerMessages, {
        logicalMapId: "map:forest",
        internalRoomId: "internal-room-two",
      }),
    );

    expect(
      coordinator.beginTravelToMember("character:leader", "entity:stranger"),
    ).toEqual({ accepted: false, code: ERROR_CODES.partyNotMember });
    coordinator.registerPresence(
      presence("character:member", "entity:member-forest", [], {
        logicalMapId: "map:forest",
        internalRoomId: "internal-room-two",
      }),
    );
    const travel = coordinator.beginTravelToMember(
      "character:leader",
      "entity:member-forest",
    );
    expect(travel).toMatchObject({
      accepted: true,
      member: { memberId: "character:leader" },
      destination: {
        memberId: "character:member",
        logicalMapId: "map:forest",
        internalRoomId: "internal-room-two",
      },
    });
  });

  it("prevents the destination member from starting a competing travel", () => {
    const coordinator = new PartyCoordinator();
    formParty(coordinator);
    coordinator.registerPresence(
      presence("character:member", "entity:member-forest", [], {
        logicalMapId: "map:forest",
        internalRoomId: "internal-room-two",
      }),
    );

    expect(
      coordinator.beginTravelToMember(
        "character:leader",
        "entity:member-forest",
      ).accepted,
    ).toBe(true);
    expect(
      coordinator.beginCohesiveTravel(
        "character:member",
        "internal-room-two",
        true,
      ),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyTravelInProgress,
    });
  });

  it("keeps reservation routing server-side and bound to its ticket", () => {
    const coordinator = new PartyCoordinator();
    coordinator.bindTravelAdmission({
      ticket: "opaque-ticket",
      reservationId: "internal-reservation",
      memberId: "character:member",
      logicalMapId: "map:forest",
      expiresAtMs: 2_000,
    });

    expect(
      coordinator.travelReservationForAdmission(
        "opaque-ticket",
        "map:forest",
        1_900,
      ),
    ).toBe("internal-reservation");
    expect(
      coordinator.claimTravelAdmission(
        "opaque-ticket",
        "internal-reservation",
        "character:member",
        "map:forest",
        2_500,
      ),
    ).toBe(true);
  });

  it("rejects membership changes and publishes reconnecting state during travel", () => {
    const coordinator = new PartyCoordinator();
    formParty(coordinator);
    const travel = coordinator.beginCohesiveTravel(
      "character:leader",
      "internal-room-one",
    );
    expect(travel.accepted).toBe(true);
    expect(coordinator.leave("character:member")).toEqual({
      accepted: false,
      code: ERROR_CODES.partyTravelInProgress,
    });

    coordinator.markDisconnected("character:member");
    expect(
      coordinator
        .stateFor("character:leader")
        .members.find((member) => member.displayName === "member")?.connected,
    ).toBe(false);
  });

  it("does not transfer leadership to a temporarily disconnected member", () => {
    const coordinator = new PartyCoordinator();
    formParty(coordinator);
    coordinator.markDisconnected("character:member");

    expect(
      coordinator.changeLeader("character:leader", "entity:member"),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyMemberUnavailable,
    });
  });

  it("recovers leadership predictably after disconnect", () => {
    const coordinator = new PartyCoordinator();
    formParty(coordinator);
    coordinator.disconnect("character:leader");

    expect(coordinator.stateFor("character:member")).toEqual({ members: [] });
    expect(coordinator.partyIdFor("character:member")).toBeUndefined();
  });
});
