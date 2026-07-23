import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";

export const PARTY_MAX_MEMBERS = 4;

export interface Party {
  id: string;
  leaderId: string;
  memberIds: readonly string[];
}

export interface PartyInvitation {
  id: string;
  inviterId: string;
  inviteeId: string;
}

export interface PartySnapshot {
  nextPartySequence: number;
  nextInvitationSequence: number;
  parties: readonly Party[];
  invitations: readonly PartyInvitation[];
  travelingMemberIds: readonly string[];
}

export type PartyTransition =
  | { type: "invite"; inviterId: string; inviteeId: string }
  | { type: "accept"; invitationId: string; inviteeId: string }
  | { type: "decline"; invitationId: string; inviteeId: string }
  | { type: "leave"; memberId: string }
  | { type: "disconnect"; memberId: string }
  | { type: "beginTravel"; memberIds: readonly string[] }
  | { type: "finishTravel"; memberIds: readonly string[] }
  | {
      type: "changeLeader";
      leaderId: string;
      nextLeaderId: string;
      nextLeaderAvailable: boolean;
    };

export type PartyTransitionDecision =
  | { accepted: true; snapshot: PartySnapshot }
  | { accepted: false; code: ErrorCode };

export function createEmptyPartySnapshot(): PartySnapshot {
  return {
    nextPartySequence: 1,
    nextInvitationSequence: 1,
    parties: [],
    invitations: [],
    travelingMemberIds: [],
  };
}

function rejected(code: ErrorCode): PartyTransitionDecision {
  return { accepted: false, code };
}

function accepted(snapshot: PartySnapshot): PartyTransitionDecision {
  return { accepted: true, snapshot };
}

function partyForMember(
  snapshot: PartySnapshot,
  memberId: string,
): Party | undefined {
  return snapshot.parties.find((party) => party.memberIds.includes(memberId));
}

function isTraveling(snapshot: PartySnapshot, memberId: string): boolean {
  return snapshot.travelingMemberIds.includes(memberId);
}

function partyIsTraveling(snapshot: PartySnapshot, party: Party): boolean {
  return party.memberIds.some((memberId) => isTraveling(snapshot, memberId));
}

function decideInvite(
  snapshot: PartySnapshot,
  transition: Extract<PartyTransition, { type: "invite" }>,
): PartyTransitionDecision {
  if (transition.inviterId === transition.inviteeId) {
    return rejected(ERROR_CODES.partyInvalidTarget);
  }
  if (
    isTraveling(snapshot, transition.inviterId) ||
    isTraveling(snapshot, transition.inviteeId)
  ) {
    return rejected(ERROR_CODES.partyTravelInProgress);
  }
  if (
    snapshot.invitations.some(
      (invitation) =>
        invitation.inviterId === transition.inviterId &&
        invitation.inviteeId === transition.inviteeId,
    )
  ) {
    return rejected(ERROR_CODES.partyInviteDuplicate);
  }
  const inviterParty = partyForMember(snapshot, transition.inviterId);
  if (inviterParty && partyIsTraveling(snapshot, inviterParty)) {
    return rejected(ERROR_CODES.partyTravelInProgress);
  }
  if (inviterParty && inviterParty.leaderId !== transition.inviterId) {
    return rejected(ERROR_CODES.partyNotLeader);
  }
  if (inviterParty?.memberIds.includes(transition.inviteeId)) {
    return rejected(ERROR_CODES.partyAlreadyMember);
  }
  if (partyForMember(snapshot, transition.inviteeId)) {
    return rejected(ERROR_CODES.partyAlreadyMember);
  }
  if (inviterParty && inviterParty.memberIds.length >= PARTY_MAX_MEMBERS) {
    return rejected(ERROR_CODES.partyFull);
  }
  return accepted({
    ...snapshot,
    nextInvitationSequence: snapshot.nextInvitationSequence + 1,
    invitations: [
      ...snapshot.invitations,
      {
        id: `party-invite:${String(snapshot.nextInvitationSequence)}`,
        inviterId: transition.inviterId,
        inviteeId: transition.inviteeId,
      },
    ],
  });
}

function invitationFor(
  snapshot: PartySnapshot,
  invitationId: string,
  inviteeId: string,
): PartyInvitation | undefined {
  return snapshot.invitations.find(
    (invitation) =>
      invitation.id === invitationId && invitation.inviteeId === inviteeId,
  );
}

function decideAccept(
  snapshot: PartySnapshot,
  transition: Extract<PartyTransition, { type: "accept" }>,
): PartyTransitionDecision {
  const invitation = invitationFor(
    snapshot,
    transition.invitationId,
    transition.inviteeId,
  );
  if (!invitation) return rejected(ERROR_CODES.partyInviteNotFound);
  if (partyForMember(snapshot, transition.inviteeId)) {
    return rejected(ERROR_CODES.partyAlreadyMember);
  }
  const inviterParty = partyForMember(snapshot, invitation.inviterId);
  if (
    isTraveling(snapshot, transition.inviteeId) ||
    isTraveling(snapshot, invitation.inviterId) ||
    (inviterParty && partyIsTraveling(snapshot, inviterParty))
  ) {
    return rejected(ERROR_CODES.partyTravelInProgress);
  }
  if (inviterParty && inviterParty.leaderId !== invitation.inviterId) {
    return rejected(ERROR_CODES.partyNotLeader);
  }
  if (inviterParty && inviterParty.memberIds.length >= PARTY_MAX_MEMBERS) {
    return rejected(ERROR_CODES.partyFull);
  }

  const invitations = snapshot.invitations.filter(
    (candidate) => candidate.inviteeId !== transition.inviteeId,
  );
  if (inviterParty) {
    return accepted({
      ...snapshot,
      invitations,
      parties: snapshot.parties.map((party) =>
        party.id === inviterParty.id
          ? {
              ...party,
              memberIds: [...party.memberIds, transition.inviteeId],
            }
          : party,
      ),
    });
  }
  return accepted({
    ...snapshot,
    nextPartySequence: snapshot.nextPartySequence + 1,
    invitations,
    parties: [
      ...snapshot.parties,
      {
        id: `party:${String(snapshot.nextPartySequence)}`,
        leaderId: invitation.inviterId,
        memberIds: [invitation.inviterId, transition.inviteeId],
      },
    ],
  });
}

function decideDecline(
  snapshot: PartySnapshot,
  transition: Extract<PartyTransition, { type: "decline" }>,
): PartyTransitionDecision {
  const invitation = invitationFor(
    snapshot,
    transition.invitationId,
    transition.inviteeId,
  );
  if (!invitation) return rejected(ERROR_CODES.partyInviteNotFound);
  return accepted({
    ...snapshot,
    invitations: snapshot.invitations.filter(
      (candidate) => candidate.id !== invitation.id,
    ),
  });
}

function removeMember(
  snapshot: PartySnapshot,
  memberId: string,
  missingIsAccepted: boolean,
): PartyTransitionDecision {
  const party = partyForMember(snapshot, memberId);
  const invitations = snapshot.invitations.filter(
    (invitation) =>
      invitation.inviterId !== memberId && invitation.inviteeId !== memberId,
  );
  if (!party) {
    return missingIsAccepted
      ? accepted({
          ...snapshot,
          invitations,
          travelingMemberIds: snapshot.travelingMemberIds.filter(
            (candidate) => candidate !== memberId,
          ),
        })
      : rejected(ERROR_CODES.partyNotMember);
  }
  if (!missingIsAccepted && partyIsTraveling(snapshot, party)) {
    return rejected(ERROR_CODES.partyTravelInProgress);
  }
  const remainingMemberIds = party.memberIds.filter(
    (candidate) => candidate !== memberId,
  );
  const parties =
    remainingMemberIds.length < 2
      ? snapshot.parties.filter((candidate) => candidate.id !== party.id)
      : snapshot.parties.map((candidate) =>
          candidate.id === party.id
            ? {
                ...candidate,
                leaderId:
                  candidate.leaderId === memberId
                    ? remainingMemberIds[0]!
                    : candidate.leaderId,
                memberIds: remainingMemberIds,
              }
            : candidate,
        );
  return accepted({
    ...snapshot,
    invitations,
    parties,
    travelingMemberIds: snapshot.travelingMemberIds.filter(
      (candidate) => candidate !== memberId,
    ),
  });
}

function decideChangeLeader(
  snapshot: PartySnapshot,
  transition: Extract<PartyTransition, { type: "changeLeader" }>,
): PartyTransitionDecision {
  const party = partyForMember(snapshot, transition.leaderId);
  if (!party) return rejected(ERROR_CODES.partyNotMember);
  if (party.leaderId !== transition.leaderId) {
    return rejected(ERROR_CODES.partyNotLeader);
  }
  if (partyIsTraveling(snapshot, party)) {
    return rejected(ERROR_CODES.partyTravelInProgress);
  }
  if (!transition.nextLeaderAvailable) {
    return rejected(ERROR_CODES.partyMemberUnavailable);
  }
  if (
    transition.nextLeaderId === transition.leaderId ||
    !party.memberIds.includes(transition.nextLeaderId)
  ) {
    return rejected(ERROR_CODES.partyInvalidTarget);
  }
  return accepted({
    ...snapshot,
    invitations: snapshot.invitations.filter(
      (invitation) => invitation.inviterId !== transition.leaderId,
    ),
    parties: snapshot.parties.map((candidate) =>
      candidate.id === party.id
        ? { ...candidate, leaderId: transition.nextLeaderId }
        : candidate,
    ),
  });
}

function decideBeginTravel(
  snapshot: PartySnapshot,
  memberIds: readonly string[],
): PartyTransitionDecision {
  const uniqueMemberIds = [...new Set(memberIds)];
  const affectedParties = uniqueMemberIds.flatMap((memberId) => {
    const party = partyForMember(snapshot, memberId);
    return party ? [party] : [];
  });
  if (
    uniqueMemberIds.length === 0 ||
    uniqueMemberIds.length !== memberIds.length ||
    uniqueMemberIds.some((memberId) => isTraveling(snapshot, memberId)) ||
    affectedParties.some((party) => partyIsTraveling(snapshot, party))
  ) {
    return rejected(ERROR_CODES.partyTravelInProgress);
  }
  return accepted({
    ...snapshot,
    travelingMemberIds: [...snapshot.travelingMemberIds, ...uniqueMemberIds],
  });
}

function decideFinishTravel(
  snapshot: PartySnapshot,
  memberIds: readonly string[],
): PartyTransitionDecision {
  const finished = new Set(memberIds);
  return accepted({
    ...snapshot,
    travelingMemberIds: snapshot.travelingMemberIds.filter(
      (memberId) => !finished.has(memberId),
    ),
  });
}

/**
 * The single Party Transition Decider. It is pure: every transition either
 * returns a complete next snapshot or a stable rejection, and callers never
 * mutate or partially apply the current snapshot.
 */
export function decidePartyTransition(
  snapshot: PartySnapshot,
  transition: PartyTransition,
): PartyTransitionDecision {
  switch (transition.type) {
    case "invite":
      return decideInvite(snapshot, transition);
    case "accept":
      return decideAccept(snapshot, transition);
    case "decline":
      return decideDecline(snapshot, transition);
    case "leave":
      return removeMember(snapshot, transition.memberId, false);
    case "disconnect":
      return removeMember(snapshot, transition.memberId, true);
    case "beginTravel":
      return decideBeginTravel(snapshot, transition.memberIds);
    case "finishTravel":
      return decideFinishTravel(snapshot, transition.memberIds);
    case "changeLeader":
      return decideChangeLeader(snapshot, transition);
  }
}
