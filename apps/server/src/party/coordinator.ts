import { randomBytes } from "node:crypto";

import {
  ERROR_CODES,
  SERVER_MESSAGES,
  type ErrorCode,
  type PartyInvitationMessage,
  type PartyStateMessage,
} from "@gameish/protocol";

import {
  createEmptyPartySnapshot,
  decidePartyTransition,
  type Party,
  type PartySnapshot,
  type PartyTransition,
} from "./transition.js";
import { PARTY_JOIN_COMPLETION_GRACE_MS } from "./travel-admission.js";

export interface PartyPresence {
  memberId: string;
  userId: string;
  entityId: string;
  displayName: string;
  logicalMapId: string;
  internalRoomId: string;
  send(messageType: string, payload: unknown): void;
}

export type PartyActionDecision =
  { accepted: true } | { accepted: false; code: ErrorCode };

export type PartyTravelPlan =
  | {
      accepted: true;
      reservationId: string;
      members: readonly PartyPresence[];
    }
  | { accepted: false; code: ErrorCode };

export type PartyTravelToMemberPlan =
  | {
      accepted: true;
      reservationId: string;
      member: PartyPresence;
      destination: PartyPresence;
    }
  | { accepted: false; code: ErrorCode };

interface PartyProfile {
  entityId: string;
  displayName: string;
  logicalMapId: string;
}

/**
 * Server-authoritative, process-local party adapter. The pure Party
 * Transition Decider remains the only place that judges membership rules;
 * this coordinator resolves authenticated room presences, applies accepted
 * snapshots, and emits only client-safe targeted messages.
 */
export class PartyCoordinator {
  #snapshot: PartySnapshot = createEmptyPartySnapshot();
  readonly #presenceByMember = new Map<string, PartyPresence>();
  readonly #memberByEntity = new Map<string, string>();
  readonly #profileByMember = new Map<string, PartyProfile>();
  readonly #temporarilyDisconnected = new Set<string>();
  readonly #travelTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #travelAdmissions = new Map<
    string,
    {
      reservationId: string;
      memberId: string;
      logicalMapId: string;
      expiresAtMs: number;
    }
  >();
  readonly #reservationId: () => string;

  constructor(
    readonly travelTimeoutMs = 15_000,
    reservationId: () => string = () =>
      `party-travel:${randomBytes(18).toString("base64url")}`,
  ) {
    this.#reservationId = reservationId;
  }

  registerPresence(presence: PartyPresence): void {
    const previous = this.#presenceByMember.get(presence.memberId);
    if (previous) this.#memberByEntity.delete(previous.entityId);
    this.#presenceByMember.set(presence.memberId, presence);
    this.#memberByEntity.set(presence.entityId, presence.memberId);
    this.#profileByMember.set(presence.memberId, {
      entityId: presence.entityId,
      displayName: presence.displayName,
      logicalMapId: presence.logicalMapId,
    });
    this.#apply({ type: "finishTravel", memberIds: [presence.memberId] });
    this.#temporarilyDisconnected.delete(presence.memberId);
    const timeout = this.#travelTimeouts.get(presence.memberId);
    if (timeout) clearTimeout(timeout);
    this.#travelTimeouts.delete(presence.memberId);
    this.#publishPartyFor(presence.memberId);
  }

  invite(inviterId: string, targetEntityId: string): PartyActionDecision {
    const inviter = this.#presenceByMember.get(inviterId);
    const inviteeId = this.#memberByEntity.get(targetEntityId);
    const invitee = inviteeId
      ? this.#presenceByMember.get(inviteeId)
      : undefined;
    if (
      !inviter ||
      !invitee ||
      inviter.internalRoomId !== invitee.internalRoomId
    ) {
      return { accepted: false, code: ERROR_CODES.partyInvalidTarget };
    }
    const previousInvitationSequence = this.#snapshot.nextInvitationSequence;
    const decision = this.#apply({
      type: "invite",
      inviterId,
      inviteeId: invitee.memberId,
    });
    if (!decision.accepted) return decision;
    const invitation = this.#snapshot.invitations.find(
      (candidate) =>
        candidate.id === `party-invite:${String(previousInvitationSequence)}`,
    );
    if (!invitation) {
      return { accepted: false, code: ERROR_CODES.partyInviteNotFound };
    }
    invitee.send(SERVER_MESSAGES.partyInvitation, {
      invitationId: invitation.id,
      inviter: {
        entityId: inviter.entityId,
        displayName: inviter.displayName,
        logicalMapId: inviter.logicalMapId,
      },
    } satisfies PartyInvitationMessage);
    return { accepted: true };
  }

  accept(memberId: string, invitationId: string): PartyActionDecision {
    const decision = this.#apply({
      type: "accept",
      invitationId,
      inviteeId: memberId,
    });
    if (decision.accepted) this.#publishPartyFor(memberId);
    return decision;
  }

  decline(memberId: string, invitationId: string): PartyActionDecision {
    return this.#apply({
      type: "decline",
      invitationId,
      inviteeId: memberId,
    });
  }

  leave(memberId: string): PartyActionDecision {
    const formerParty = this.#partyFor(memberId);
    const decision = this.#apply({ type: "leave", memberId });
    if (decision.accepted) {
      this.#sendPartyState(memberId, { members: [] });
      this.#publishMembers(formerParty?.memberIds ?? []);
    }
    return decision;
  }

  changeLeader(leaderId: string, targetEntityId: string): PartyActionDecision {
    const nextLeaderId = this.#memberByEntity.get(targetEntityId);
    if (!nextLeaderId) {
      return { accepted: false, code: ERROR_CODES.partyInvalidTarget };
    }
    const decision = this.#apply({
      type: "changeLeader",
      leaderId,
      nextLeaderId,
      nextLeaderAvailable:
        !this.#temporarilyDisconnected.has(nextLeaderId) &&
        this.#presenceByMember.has(nextLeaderId),
    });
    if (decision.accepted) this.#publishPartyFor(leaderId);
    return decision;
  }

  disconnect(memberId: string): void {
    const formerParty = this.#partyFor(memberId);
    this.#sendPartyState(memberId, { members: [] });
    this.#apply({ type: "disconnect", memberId });
    this.#removePresence(memberId);
    const timeout = this.#travelTimeouts.get(memberId);
    if (timeout) clearTimeout(timeout);
    this.#travelTimeouts.delete(memberId);
    this.#profileByMember.delete(memberId);
    this.#temporarilyDisconnected.delete(memberId);
    this.#publishMembers(formerParty?.memberIds ?? []);
  }

  markDisconnected(memberId: string): void {
    if (!this.#presenceByMember.has(memberId)) return;
    this.#temporarilyDisconnected.add(memberId);
    this.#publishPartyFor(memberId);
  }

  markReconnected(memberId: string): void {
    if (!this.#temporarilyDisconnected.delete(memberId)) return;
    this.#publishPartyFor(memberId);
  }

  beginCohesiveTravel(
    memberId: string,
    internalRoomId: string,
    explicitlyAlone = false,
  ): PartyTravelPlan {
    const presence = this.#presenceByMember.get(memberId);
    if (!presence || presence.internalRoomId !== internalRoomId) {
      return { accepted: false, code: ERROR_CODES.partyMemberUnavailable };
    }
    const party = this.#partyFor(memberId);
    if (!party) {
      const claim = this.#claimTravel([presence]);
      // A partyless player re-requesting while their own transition is in
      // flight is the plain rapid retry the portal cooldown already names;
      // party vocabulary would leak into solo travel feedback otherwise.
      return !claim.accepted && claim.code === ERROR_CODES.partyTravelInProgress
        ? { accepted: false, code: ERROR_CODES.portalOnCooldown }
        : claim;
    }
    if (party.leaderId !== memberId) {
      return explicitlyAlone
        ? this.#claimTravel([presence])
        : { accepted: false, code: ERROR_CODES.partyNotLeader };
    }
    const members: PartyPresence[] = [];
    for (const partyMemberId of party.memberIds) {
      const member = this.#presenceByMember.get(partyMemberId);
      if (
        !member ||
        member.internalRoomId !== internalRoomId ||
        this.#temporarilyDisconnected.has(partyMemberId)
      ) {
        return {
          accepted: false,
          code: ERROR_CODES.partyMemberUnavailable,
        };
      }
      members.push(member);
    }
    return this.#claimTravel(members);
  }

  beginTravelToMember(
    memberId: string,
    targetEntityId: string,
  ): PartyTravelToMemberPlan {
    const member = this.#presenceByMember.get(memberId);
    const targetMemberId = this.#memberByEntity.get(targetEntityId);
    const destination = targetMemberId
      ? this.#presenceByMember.get(targetMemberId)
      : undefined;
    const party = this.#partyFor(memberId);
    if (
      !member ||
      !destination ||
      this.#temporarilyDisconnected.has(memberId) ||
      this.#temporarilyDisconnected.has(destination.memberId) ||
      !party ||
      !party.memberIds.includes(destination.memberId)
    ) {
      return { accepted: false, code: ERROR_CODES.partyNotMember };
    }
    if (member.internalRoomId === destination.internalRoomId) {
      return {
        accepted: false,
        code: ERROR_CODES.partyAlreadyWithMember,
      };
    }
    const claim = this.#claimTravel([member]);
    return claim.accepted
      ? {
          accepted: true,
          reservationId: claim.reservationId,
          member,
          destination,
        }
      : claim;
  }

  cancelTravel(memberIds: readonly string[]): void {
    this.#apply({ type: "finishTravel", memberIds });
  }

  cancelTravelForParty(memberId: string): void {
    this.cancelTravel(this.#partyFor(memberId)?.memberIds ?? [memberId]);
  }

  travelToMemberStillAvailable(
    plan: Extract<PartyTravelToMemberPlan, { accepted: true }>,
  ): boolean {
    const party = this.#partyFor(plan.member.memberId);
    const destination = this.#presenceByMember.get(plan.destination.memberId);
    const travelingMembers = party?.memberIds.filter((memberId) =>
      this.#snapshot.travelingMemberIds.includes(memberId),
    );
    return (
      party?.memberIds.includes(plan.destination.memberId) === true &&
      destination?.internalRoomId === plan.destination.internalRoomId &&
      travelingMembers?.length === 1 &&
      travelingMembers[0] === plan.member.memberId &&
      !this.#temporarilyDisconnected.has(plan.member.memberId) &&
      !this.#temporarilyDisconnected.has(plan.destination.memberId)
    );
  }

  cohesiveTravelStillAvailable(
    members: readonly PartyPresence[],
    internalRoomId: string,
  ): boolean {
    if (members.length > 1) {
      const party = this.#partyFor(members[0]!.memberId);
      if (
        !party ||
        party.memberIds.length !== members.length ||
        party.memberIds.some(
          (memberId) => !members.some((member) => member.memberId === memberId),
        )
      ) {
        return false;
      }
    }
    return members.every((member) => {
      const current = this.#presenceByMember.get(member.memberId);
      return (
        current?.internalRoomId === internalRoomId &&
        !this.#temporarilyDisconnected.has(member.memberId)
      );
    });
  }

  departForTravel(memberId: string): void {
    this.#removePresence(memberId);
    const timeout = setTimeout(() => {
      if (!this.#presenceByMember.has(memberId)) this.disconnect(memberId);
    }, this.travelTimeoutMs);
    timeout.unref?.();
    this.#travelTimeouts.set(memberId, timeout);
    this.#publishPartyFor(memberId);
  }

  partyIdFor(memberId: string): string | undefined {
    return this.#partyFor(memberId)?.id;
  }

  bindTravelAdmission(input: {
    ticket: string;
    reservationId: string;
    memberId: string;
    logicalMapId: string;
    expiresAtMs: number;
  }): void {
    this.#travelAdmissions.set(input.ticket, {
      reservationId: input.reservationId,
      memberId: input.memberId,
      logicalMapId: input.logicalMapId,
      expiresAtMs: input.expiresAtMs + PARTY_JOIN_COMPLETION_GRACE_MS,
    });
  }

  travelReservationForAdmission(
    ticket: string,
    logicalMapId: string,
    nowMs: number,
  ): string | undefined {
    this.#purgeTravelAdmissions(nowMs);
    const admission = this.#travelAdmissions.get(ticket);
    return admission?.logicalMapId === logicalMapId
      ? admission.reservationId
      : undefined;
  }

  claimTravelAdmission(
    ticket: string,
    reservationId: string,
    memberId: string,
    logicalMapId: string,
    nowMs: number,
  ): boolean {
    this.#purgeTravelAdmissions(nowMs);
    const admission = this.#travelAdmissions.get(ticket);
    if (
      admission?.reservationId !== reservationId ||
      admission.memberId !== memberId ||
      admission.logicalMapId !== logicalMapId
    ) {
      return false;
    }
    this.#travelAdmissions.delete(ticket);
    return true;
  }

  stateFor(memberId: string): PartyStateMessage {
    const party = this.#partyFor(memberId);
    if (!party) return { members: [] };
    return {
      members: party.memberIds.flatMap((partyMemberId) => {
        const profile = this.#profileByMember.get(partyMemberId);
        return profile
          ? [
              {
                entityId: profile.entityId,
                displayName: profile.displayName,
                logicalMapId: profile.logicalMapId,
                leader: party.leaderId === partyMemberId,
                connected:
                  this.#presenceByMember.has(partyMemberId) &&
                  !this.#temporarilyDisconnected.has(partyMemberId),
              },
            ]
          : [];
      }),
    };
  }

  sendState(memberId: string): void {
    this.#sendPartyState(memberId, this.stateFor(memberId));
  }

  #claimTravel(members: readonly PartyPresence[]): PartyTravelPlan {
    const decision = this.#apply({
      type: "beginTravel",
      memberIds: members.map((member) => member.memberId),
    });
    if (!decision.accepted) return decision;
    return {
      accepted: true,
      reservationId: this.#reservationId(),
      members,
    };
  }

  #apply(transition: PartyTransition): PartyActionDecision {
    const decision = decidePartyTransition(this.#snapshot, transition);
    if (!decision.accepted) return decision;
    this.#snapshot = decision.snapshot;
    return { accepted: true };
  }

  #partyFor(memberId: string): Party | undefined {
    return this.#snapshot.parties.find((party) =>
      party.memberIds.includes(memberId),
    );
  }

  #publishPartyFor(memberId: string): void {
    const party = this.#partyFor(memberId);
    if (!party) {
      this.#sendPartyState(memberId, { members: [] });
      return;
    }
    this.#publishMembers(party.memberIds);
  }

  #publishMembers(memberIds: readonly string[]): void {
    for (const memberId of memberIds) {
      this.#sendPartyState(memberId, this.stateFor(memberId));
    }
  }

  #sendPartyState(memberId: string, state: PartyStateMessage): void {
    this.#presenceByMember
      .get(memberId)
      ?.send(SERVER_MESSAGES.partyState, state);
  }

  #removePresence(memberId: string): void {
    const presence = this.#presenceByMember.get(memberId);
    if (presence) this.#memberByEntity.delete(presence.entityId);
    this.#presenceByMember.delete(memberId);
    this.#temporarilyDisconnected.delete(memberId);
  }

  #purgeTravelAdmissions(nowMs: number): void {
    for (const [ticket, admission] of this.#travelAdmissions) {
      if (nowMs >= admission.expiresAtMs) this.#travelAdmissions.delete(ticket);
    }
  }
}
