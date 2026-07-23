import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";

import type { TransitionTicketIssuer } from "../identity/transition-tickets.js";
import {
  defaultEntranceId,
  destinationRoomName,
  LOGICAL_MAPS,
} from "../rooms/logical-maps.js";
import type { MapPlacementDriver } from "../rooms/placement.js";
import type { PartyTravelToMemberPlan } from "./coordinator.js";
import { PARTY_JOIN_COMPLETION_GRACE_MS } from "./travel-admission.js";

export type TravelToMemberOutcome =
  | { kind: "rejected"; actionId: string; code: ErrorCode }
  | {
      kind: "approved";
      actionId: string;
      reservationId: string;
      memberId: string;
      ticket: string;
      expiresAtMs: number;
      destinationMapId: string;
      destinationRoomName: string;
    };

/**
 * Completes the server-side travel-to-member checks and preparation after
 * the Party Coordinator has proven the relationship. Capacity is reserved
 * against the member's exact internal destination, while the result exposes
 * only its logical map and room type to the client.
 */
export async function prepareTravelToMember(input: {
  actionId: string;
  plan: Extract<PartyTravelToMemberPlan, { accepted: true }>;
  placement: MapPlacementDriver;
  transitionTickets: TransitionTicketIssuer;
  now: () => number;
  canAccessMap: (memberId: string, logicalMapId: string) => boolean;
  checkpoint: () => Promise<boolean>;
  revalidate: () => boolean;
}): Promise<TravelToMemberOutcome> {
  const destinationMapId = input.plan.destination.logicalMapId;
  const destinationMap = LOGICAL_MAPS[destinationMapId];
  const roomName = destinationRoomName(destinationMapId);
  const entranceId = defaultEntranceId(destinationMapId);
  if (!destinationMap || !roomName || !entranceId) {
    return {
      kind: "rejected",
      actionId: input.actionId,
      code: ERROR_CODES.destinationNotAllowed,
    };
  }
  try {
    if (!input.canAccessMap(input.plan.member.memberId, destinationMapId)) {
      return {
        kind: "rejected",
        actionId: input.actionId,
        code: ERROR_CODES.mapLocked,
      };
    }
    const reservation = input.placement.reservePartyCapacity({
      reservationId: input.plan.reservationId,
      logicalMapId: destinationMapId,
      memberIds: [input.plan.member.memberId],
      preferredRoomId: input.plan.destination.internalRoomId,
      expiresAtMs: input.now() + 15_000,
    });
    if (!reservation.accepted) {
      return {
        kind: "rejected",
        actionId: input.actionId,
        code: ERROR_CODES.instanceUnavailable,
      };
    }
    const checkpointed = await input.checkpoint();
    if (!checkpointed) {
      input.placement.releasePartyReservation(input.plan.reservationId);
      return {
        kind: "rejected",
        actionId: input.actionId,
        code: ERROR_CODES.transitionUnavailable,
      };
    }
    if (!input.revalidate()) {
      input.placement.releasePartyReservation(input.plan.reservationId);
      return {
        kind: "rejected",
        actionId: input.actionId,
        code: ERROR_CODES.partyMemberUnavailable,
      };
    }
    const ticket = await input.transitionTickets.issue({
      userId: input.plan.member.userId,
      characterId: input.plan.member.memberId,
      destinationMapId,
      destinationEntranceId: entranceId,
      contentVersion: destinationMap.contentVersion,
    });
    if (!ticket) {
      input.placement.releasePartyReservation(input.plan.reservationId);
      return {
        kind: "rejected",
        actionId: input.actionId,
        code: ERROR_CODES.transitionUnavailable,
      };
    }
    if (
      !input.placement.extendPartyReservation(
        input.plan.reservationId,
        ticket.expiresAtMs + PARTY_JOIN_COMPLETION_GRACE_MS,
      )
    ) {
      input.placement.releasePartyReservation(input.plan.reservationId);
      return {
        kind: "rejected",
        actionId: input.actionId,
        code: ERROR_CODES.instanceUnavailable,
      };
    }
    return {
      kind: "approved",
      actionId: input.actionId,
      reservationId: input.plan.reservationId,
      memberId: input.plan.member.memberId,
      ticket: ticket.ticket,
      expiresAtMs: ticket.expiresAtMs,
      destinationMapId,
      destinationRoomName: roomName,
    };
  } catch {
    input.placement.releasePartyReservation(input.plan.reservationId);
    return {
      kind: "rejected",
      actionId: input.actionId,
      code: ERROR_CODES.transitionUnavailable,
    };
  }
}
