import type { ServerMapArtifact } from "@gameish/content";
import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";

import type { TransitionTicketIssuer } from "../identity/transition-tickets.js";
import { PARTY_JOIN_COMPLETION_GRACE_MS } from "../party/travel-admission.js";
import {
  evaluatePortalTransition,
  portalTransitionSchema,
} from "./portal-transition.js";

export type PortalTransitionOutcome =
  | { kind: "invalid" }
  | { kind: "rejected"; actionId: string; code: ErrorCode }
  | {
      kind: "approved";
      actionId: string;
      ticket: string;
      expiresAtMs: number;
      destinationRoomName: string;
      destinationMapId: string;
    };

export type CohesivePortalTransitionOutcome =
  | { kind: "invalid" }
  | { kind: "rejected"; actionId: string; code: ErrorCode }
  | {
      kind: "approved";
      actionId: string;
      destinationRoomName: string;
      destinationMapId: string;
      reservationId: string;
      admissions: readonly {
        sessionId: string;
        memberId: string;
        ticket: string;
        expiresAtMs: number;
      }[];
    };

/**
 * Per-character portal cooldown, held outside any single room.
 *
 * A successful transition always removes the session from its source room,
 * so a cooldown stored per session in the source room would be discarded by
 * the very transition it exists to rate-limit. Keying by character and
 * sharing one registry across every logical-map room is what makes the
 * cooldown in AC2 apply to repeated traversal rather than only to a repeat
 * request within one session.
 */
export class PortalCooldownRegistry {
  readonly #lastTransitionAtMs = new Map<string, number>();

  lastTransitionAtMs(characterId: string): number | undefined {
    return this.#lastTransitionAtMs.get(characterId);
  }

  stamp(characterId: string, atMs: number): void {
    this.#lastTransitionAtMs.set(characterId, atMs);
  }
}

/**
 * Shared server-authoritative portal transition flow (AC1-AC4), used
 * identically by every room. Owns per-session cooldown tracking and the
 * ordered "evaluate -> checkpoint safe location -> issue destination
 * ticket" pipeline, so this logic exists exactly once regardless of how
 * many logical-map rooms exist. Rooms stay responsible only for the
 * Colyseus-specific parts: reading player position/identity off their own
 * state, and — once a transition is approved — sending the ticket, removing
 * the player, and calling `client.leave()`.
 */
export class PortalTransitionCoordinator {
  readonly #sourceMap: ServerMapArtifact;
  readonly #transitionTickets: TransitionTicketIssuer;
  readonly #now: () => number;
  readonly #cooldowns: PortalCooldownRegistry;
  readonly #inFlight = new Set<string>();

  constructor(input: {
    sourceMap: ServerMapArtifact;
    transitionTickets: TransitionTicketIssuer;
    cooldowns: PortalCooldownRegistry;
    now?: () => number;
  }) {
    this.#sourceMap = input.sourceMap;
    this.#transitionTickets = input.transitionTickets;
    this.#cooldowns = input.cooldowns;
    this.#now = input.now ?? Date.now;
  }

  clearSession(sessionId: string): void {
    this.#inFlight.delete(sessionId);
  }

  async evaluate(input: {
    sessionId: string;
    unsafeIntention: unknown;
    playerFoot: { x: number; y: number } | undefined;
    identity: { userId: string; characterId: string } | undefined;
    checkpoint: () => Promise<boolean>;
  }): Promise<PortalTransitionOutcome> {
    const parsed = portalTransitionSchema.safeParse(input.unsafeIntention);
    if (!parsed.success || !input.playerFoot || !input.identity) {
      return { kind: "invalid" };
    }
    const characterId = input.identity.characterId;
    // A second request arriving before the first one's awaits resolve would
    // otherwise pass the same cooldown check and be issued a second, equally
    // valid destination ticket — two joins for one character, i.e. duplicated
    // presence. The claim and the cooldown stamp are both taken
    // synchronously, before any await, so only one request can be in flight.
    if (this.#inFlight.has(input.sessionId)) {
      return {
        kind: "rejected",
        actionId: parsed.data.actionId,
        code: ERROR_CODES.portalOnCooldown,
      };
    }
    const evaluation = evaluatePortalTransition({
      sourceMap: this.#sourceMap,
      portalId: parsed.data.portalId,
      now: this.#now(),
      lastTransitionAtMs: this.#cooldowns.lastTransitionAtMs(characterId),
      playerFoot: input.playerFoot,
    });
    if (!evaluation.ok) {
      return {
        kind: "rejected",
        actionId: parsed.data.actionId,
        code: evaluation.code,
      };
    }
    this.#inFlight.add(input.sessionId);
    this.#cooldowns.stamp(characterId, this.#now());
    try {
      // Checkpoint the safe, pre-transition location before anything is
      // consumed or removed, so a failure downstream still recovers here
      // (AC4) rather than at a half-completed transition. A checkpoint that
      // did not land makes that recovery point unknown, so the transition
      // does not proceed at all.
      const checkpointed = await input.checkpoint();
      if (!checkpointed) {
        return {
          kind: "rejected",
          actionId: parsed.data.actionId,
          code: ERROR_CODES.transitionUnavailable,
        };
      }
      const issued = await this.#transitionTickets.issue({
        userId: input.identity.userId,
        characterId,
        destinationMapId: evaluation.destinationMapId,
        destinationEntranceId: evaluation.destinationEntranceId,
        contentVersion: this.#sourceMap.contentVersion,
      });
      if (!issued) {
        return {
          kind: "rejected",
          actionId: parsed.data.actionId,
          code: ERROR_CODES.transitionUnavailable,
        };
      }
      return this.#approved(parsed.data.actionId, issued, evaluation);
    } finally {
      // The session is removed from the room on success, which clears this
      // anyway; on rejection it must be released so the player can retry
      // once the cooldown expires.
      this.#inFlight.delete(input.sessionId);
    }
  }

  async evaluateCohesive(input: {
    initiatorSessionId: string;
    unsafeIntention: unknown;
    reservationId: string;
    members: readonly {
      sessionId: string;
      playerFoot: { x: number; y: number } | undefined;
      identity: { userId: string; characterId: string } | undefined;
      checkpoint: () => Promise<boolean>;
    }[];
    reserveCapacity: (input: {
      reservationId: string;
      destinationMapId: string;
      memberIds: readonly string[];
      expiresAtMs: number;
    }) => boolean;
    releaseCapacity: (reservationId: string) => void;
    extendCapacity: (reservationId: string, expiresAtMs: number) => boolean;
    revalidateMembers: () => boolean;
  }): Promise<CohesivePortalTransitionOutcome> {
    const parsed = portalTransitionSchema.safeParse(input.unsafeIntention);
    if (!parsed.success || input.members.length === 0) {
      return { kind: "invalid" };
    }
    const initiator = input.members.find(
      (member) => member.sessionId === input.initiatorSessionId,
    );
    if (!initiator) return { kind: "invalid" };
    // A repeat request from the initiator while their own transition is
    // still in flight is the same rapid-retry `evaluate` rejects with the
    // cooldown code; only another member's in-flight travel is a party
    // condition.
    if (this.#inFlight.has(initiator.sessionId)) {
      return {
        kind: "rejected",
        actionId: parsed.data.actionId,
        code: ERROR_CODES.portalOnCooldown,
      };
    }
    if (
      input.members.some(
        (member) =>
          !member.playerFoot ||
          !member.identity ||
          this.#inFlight.has(member.sessionId),
      )
    ) {
      return {
        kind: "rejected",
        actionId: parsed.data.actionId,
        code: ERROR_CODES.partyTravelInProgress,
      };
    }
    const now = this.#now();
    const evaluations = input.members.map((member) =>
      evaluatePortalTransition({
        sourceMap: this.#sourceMap,
        portalId: parsed.data.portalId,
        now,
        lastTransitionAtMs: this.#cooldowns.lastTransitionAtMs(
          member.identity!.characterId,
        ),
        playerFoot: member.playerFoot!,
      }),
    );
    const rejection = evaluations.find((evaluation) => !evaluation.ok);
    if (rejection && !rejection.ok) {
      return {
        kind: "rejected",
        actionId: parsed.data.actionId,
        code: rejection.code,
      };
    }
    const destination = evaluations[0];
    if (!destination?.ok) return { kind: "invalid" };
    for (const member of input.members) {
      this.#inFlight.add(member.sessionId);
      this.#cooldowns.stamp(member.identity!.characterId, now);
    }
    const reservationExpiresAtMs = now + 15_000;
    let reserved: boolean;
    try {
      reserved = input.reserveCapacity({
        reservationId: input.reservationId,
        destinationMapId: destination.destinationMapId,
        memberIds: input.members.map((member) => member.identity!.characterId),
        expiresAtMs: reservationExpiresAtMs,
      });
    } catch {
      input.releaseCapacity(input.reservationId);
      this.#clearInFlight(input.members);
      return {
        kind: "rejected",
        actionId: parsed.data.actionId,
        code: ERROR_CODES.transitionUnavailable,
      };
    }
    if (!reserved) {
      this.#clearInFlight(input.members);
      return {
        kind: "rejected",
        actionId: parsed.data.actionId,
        code: ERROR_CODES.instanceUnavailable,
      };
    }
    try {
      const checkpointed = await Promise.all(
        input.members.map((member) => member.checkpoint()),
      );
      if (checkpointed.some((value) => !value)) {
        input.releaseCapacity(input.reservationId);
        return {
          kind: "rejected",
          actionId: parsed.data.actionId,
          code: ERROR_CODES.transitionUnavailable,
        };
      }
      if (!input.revalidateMembers()) {
        input.releaseCapacity(input.reservationId);
        return {
          kind: "rejected",
          actionId: parsed.data.actionId,
          code: ERROR_CODES.partyMemberUnavailable,
        };
      }
      const issued = await Promise.all(
        input.members.map(async (member) => {
          const identity = member.identity!;
          const ticket = await this.#transitionTickets.issue({
            userId: identity.userId,
            characterId: identity.characterId,
            destinationMapId: destination.destinationMapId,
            destinationEntranceId: destination.destinationEntranceId,
            contentVersion: this.#sourceMap.contentVersion,
          });
          return ticket
            ? {
                sessionId: member.sessionId,
                memberId: identity.characterId,
                ...ticket,
              }
            : undefined;
        }),
      );
      if (issued.some((admission) => admission === undefined)) {
        input.releaseCapacity(input.reservationId);
        return {
          kind: "rejected",
          actionId: parsed.data.actionId,
          code: ERROR_CODES.transitionUnavailable,
        };
      }
      const admissions = issued.filter(
        (admission): admission is NonNullable<typeof admission> =>
          admission !== undefined,
      );
      const latestAdmissionExpiry = Math.max(
        ...admissions.map((admission) => admission.expiresAtMs),
      );
      if (
        !input.extendCapacity(
          input.reservationId,
          latestAdmissionExpiry + PARTY_JOIN_COMPLETION_GRACE_MS,
        )
      ) {
        input.releaseCapacity(input.reservationId);
        return {
          kind: "rejected",
          actionId: parsed.data.actionId,
          code: ERROR_CODES.instanceUnavailable,
        };
      }
      return {
        kind: "approved",
        actionId: parsed.data.actionId,
        destinationRoomName: destination.destinationRoomName,
        destinationMapId: destination.destinationMapId,
        reservationId: input.reservationId,
        admissions,
      };
    } catch {
      input.releaseCapacity(input.reservationId);
      return {
        kind: "rejected",
        actionId: parsed.data.actionId,
        code: ERROR_CODES.transitionUnavailable,
      };
    } finally {
      this.#clearInFlight(input.members);
    }
  }

  #clearInFlight(members: readonly { sessionId: string }[]): void {
    for (const member of members) this.#inFlight.delete(member.sessionId);
  }

  #approved(
    actionId: string,
    issued: { ticket: string; expiresAtMs: number },
    evaluation: {
      destinationRoomName: string;
      destinationMapId: string;
    },
  ): PortalTransitionOutcome {
    return {
      kind: "approved",
      actionId,
      ticket: issued.ticket,
      expiresAtMs: issued.expiresAtMs,
      destinationRoomName: evaluation.destinationRoomName,
      destinationMapId: evaluation.destinationMapId,
    };
  }
}
