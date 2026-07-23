import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "@gameish/protocol";

import {
  createEmptyPartySnapshot,
  decidePartyTransition,
  type PartySnapshot,
} from "./transition.js";

function apply(
  snapshot: PartySnapshot,
  transition: Parameters<typeof decidePartyTransition>[1],
): PartySnapshot {
  const decision = decidePartyTransition(snapshot, transition);
  expect(decision.accepted).toBe(true);
  if (!decision.accepted) throw new Error(decision.code);
  return decision.snapshot;
}

function partyOf(snapshot: PartySnapshot, memberId: string) {
  return snapshot.parties.find((party) => party.memberIds.includes(memberId));
}

describe("Party Transition Decider", () => {
  it("forms a party when an invited player accepts", () => {
    let snapshot = createEmptyPartySnapshot();
    snapshot = apply(snapshot, {
      type: "invite",
      inviterId: "character:leader",
      inviteeId: "character:member",
    });
    const invitationId = snapshot.invitations[0]?.id;
    expect(invitationId).toBe("party-invite:1");

    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: invitationId!,
      inviteeId: "character:member",
    });

    expect(snapshot.invitations).toEqual([]);
    expect(snapshot.parties).toEqual([
      {
        id: "party:1",
        leaderId: "character:leader",
        memberIds: ["character:leader", "character:member"],
      },
    ]);
  });

  it("declines an invitation without creating a party", () => {
    let snapshot = apply(createEmptyPartySnapshot(), {
      type: "invite",
      inviterId: "character:leader",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "decline",
      invitationId: "party-invite:1",
      inviteeId: "character:member",
    });

    expect(snapshot.invitations).toEqual([]);
    expect(snapshot.parties).toEqual([]);
  });

  it("rejects duplicate invitations without changing state", () => {
    const snapshot = apply(createEmptyPartySnapshot(), {
      type: "invite",
      inviterId: "character:leader",
      inviteeId: "character:member",
    });

    expect(
      decidePartyTransition(snapshot, {
        type: "invite",
        inviterId: "character:leader",
        inviteeId: "character:member",
      }),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyInviteDuplicate,
    });
  });

  it("caps membership at four under simultaneous accepts", () => {
    let snapshot = createEmptyPartySnapshot();
    for (const inviteeId of [
      "character:two",
      "character:three",
      "character:four",
      "character:five",
    ]) {
      snapshot = apply(snapshot, {
        type: "invite",
        inviterId: "character:leader",
        inviteeId,
      });
    }

    for (const invitationId of [
      "party-invite:1",
      "party-invite:2",
      "party-invite:3",
    ]) {
      const invitation = snapshot.invitations.find(
        (candidate) => candidate.id === invitationId,
      )!;
      snapshot = apply(snapshot, {
        type: "accept",
        invitationId,
        inviteeId: invitation.inviteeId,
      });
    }
    const beforeRejectedAccept = snapshot;
    const rejected = decidePartyTransition(snapshot, {
      type: "accept",
      invitationId: "party-invite:4",
      inviteeId: "character:five",
    });

    expect(partyOf(snapshot, "character:leader")?.memberIds).toHaveLength(4);
    expect(rejected).toEqual({
      accepted: false,
      code: ERROR_CODES.partyFull,
    });
    expect(snapshot).toBe(beforeRejectedAccept);
  });

  it("rejects accepting another invitation after joining a party", () => {
    let snapshot = createEmptyPartySnapshot();
    snapshot = apply(snapshot, {
      type: "invite",
      inviterId: "character:first-leader",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "invite",
      inviterId: "character:second-leader",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: "party-invite:1",
      inviteeId: "character:member",
    });

    expect(
      decidePartyTransition(snapshot, {
        type: "accept",
        invitationId: "party-invite:2",
        inviteeId: "character:member",
      }),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyInviteNotFound,
    });
  });

  it("removes a member and dissolves a party when only one remains", () => {
    let snapshot = apply(createEmptyPartySnapshot(), {
      type: "invite",
      inviterId: "character:leader",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: "party-invite:1",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "leave",
      memberId: "character:member",
    });

    expect(snapshot.parties).toEqual([]);
  });

  it("promotes the longest-standing remaining member when the leader leaves", () => {
    let snapshot = createEmptyPartySnapshot();
    for (const inviteeId of ["character:two", "character:three"]) {
      snapshot = apply(snapshot, {
        type: "invite",
        inviterId: "character:leader",
        inviteeId,
      });
    }
    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: "party-invite:1",
      inviteeId: "character:two",
    });
    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: "party-invite:2",
      inviteeId: "character:three",
    });
    snapshot = apply(snapshot, {
      type: "leave",
      memberId: "character:leader",
    });

    expect(snapshot.parties[0]).toEqual({
      id: "party:1",
      leaderId: "character:two",
      memberIds: ["character:two", "character:three"],
    });
  });

  it("lets the leader transfer leadership to another member", () => {
    let snapshot = apply(createEmptyPartySnapshot(), {
      type: "invite",
      inviterId: "character:leader",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: "party-invite:1",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "changeLeader",
      leaderId: "character:leader",
      nextLeaderId: "character:member",
      nextLeaderAvailable: true,
    });

    expect(snapshot.parties[0]?.leaderId).toBe("character:member");
    expect(
      decidePartyTransition(snapshot, {
        type: "changeLeader",
        leaderId: "character:leader",
        nextLeaderId: "character:member",
        nextLeaderAvailable: true,
      }),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyNotLeader,
    });
  });

  it("rejects transferring leadership to an unavailable member", () => {
    let snapshot = apply(createEmptyPartySnapshot(), {
      type: "invite",
      inviterId: "character:leader",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: "party-invite:1",
      inviteeId: "character:member",
    });

    expect(
      decidePartyTransition(snapshot, {
        type: "changeLeader",
        leaderId: "character:leader",
        nextLeaderId: "character:member",
        nextLeaderAvailable: false,
      }),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyMemberUnavailable,
    });
  });

  it("removes invitations and safely changes leader on disconnect", () => {
    let snapshot = createEmptyPartySnapshot();
    for (const inviteeId of ["character:member", "character:pending"]) {
      snapshot = apply(snapshot, {
        type: "invite",
        inviterId: "character:leader",
        inviteeId,
      });
    }
    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: "party-invite:1",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "disconnect",
      memberId: "character:leader",
    });

    expect(snapshot.parties).toEqual([]);
    expect(snapshot.invitations).toEqual([]);
    expect(
      decidePartyTransition(snapshot, {
        type: "disconnect",
        memberId: "character:leader",
      }),
    ).toEqual({ accepted: true, snapshot });
  });

  it("locks membership while a coordinated travel is in progress", () => {
    let snapshot = apply(createEmptyPartySnapshot(), {
      type: "invite",
      inviterId: "character:leader",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "beginTravel",
      memberIds: ["character:leader"],
    });

    expect(
      decidePartyTransition(snapshot, {
        type: "accept",
        invitationId: "party-invite:1",
        inviteeId: "character:member",
      }),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyTravelInProgress,
    });

    snapshot = apply(snapshot, {
      type: "finishTravel",
      memberIds: ["character:leader"],
    });
    expect(
      decidePartyTransition(snapshot, {
        type: "accept",
        invitationId: "party-invite:1",
        inviteeId: "character:member",
      }).accepted,
    ).toBe(true);
  });

  it("serializes every travel intention across the whole party", () => {
    let snapshot = apply(createEmptyPartySnapshot(), {
      type: "invite",
      inviterId: "character:leader",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "accept",
      invitationId: "party-invite:1",
      inviteeId: "character:member",
    });
    snapshot = apply(snapshot, {
      type: "beginTravel",
      memberIds: ["character:leader"],
    });

    expect(
      decidePartyTransition(snapshot, {
        type: "beginTravel",
        memberIds: ["character:member"],
      }),
    ).toEqual({
      accepted: false,
      code: ERROR_CODES.partyTravelInProgress,
    });
  });
});
