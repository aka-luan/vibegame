import type { ServerMapArtifact } from "@gameish/content";
import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";

import type { TransitionTicketIssuer } from "../identity/transition-tickets.js";
import { evaluatePortalTransition, portalTransitionSchema } from "./portal-transition.js";

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
  readonly #lastTransitionAtMs = new Map<string, number>();

  constructor(input: {
    sourceMap: ServerMapArtifact;
    transitionTickets: TransitionTicketIssuer;
    now?: () => number;
  }) {
    this.#sourceMap = input.sourceMap;
    this.#transitionTickets = input.transitionTickets;
    this.#now = input.now ?? Date.now;
  }

  clearSession(sessionId: string): void {
    this.#lastTransitionAtMs.delete(sessionId);
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
    const evaluation = evaluatePortalTransition({
      sourceMap: this.#sourceMap,
      portalId: parsed.data.portalId,
      now: this.#now(),
      lastTransitionAtMs: this.#lastTransitionAtMs.get(input.sessionId),
      playerFoot: input.playerFoot,
    });
    if (!evaluation.ok) {
      return { kind: "rejected", actionId: parsed.data.actionId, code: evaluation.code };
    }
    // Checkpoint the safe, pre-transition location before anything is
    // consumed or removed, so a failure downstream still recovers here
    // (AC4) rather than at a half-completed transition.
    await input.checkpoint();
    const issued = await this.#transitionTickets.issue({
      userId: input.identity.userId,
      characterId: input.identity.characterId,
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
    this.#lastTransitionAtMs.set(input.sessionId, this.#now());
    return {
      kind: "approved",
      actionId: parsed.data.actionId,
      ticket: issued.ticket,
      expiresAtMs: issued.expiresAtMs,
      destinationRoomName: evaluation.destinationRoomName,
      destinationMapId: evaluation.destinationMapId,
    };
  }
}
