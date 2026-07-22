import { randomBytes, randomUUID } from "node:crypto";

import type { GuestAccountRepository } from "@gameish/database";

import type { DevelopmentPlayTickets } from "../development/play-tickets.js";
import { PLAY_TICKET_TTL_MS } from "./guest-account.js";
import { hashSecret } from "./play-tickets.js";

/**
 * Issues a short-lived transition ticket for a player moving between rooms
 * via a portal, from inside the source room (not the HTTP play-ticket
 * endpoint). Bound to user, character, destination map id, destination
 * entrance id, content version, and a single-use nonce, with the same TTL
 * as a regular play ticket (ADR-0007).
 */
export interface TransitionTicketIssuer {
  issue(input: {
    userId: string;
    characterId: string;
    destinationMapId: string;
    destinationEntranceId: string;
    contentVersion: string;
  }): Promise<{ ticket: string; expiresAtMs: number } | undefined>;
}

export class PostgresTransitionTicketIssuer implements TransitionTicketIssuer {
  readonly #repository: GuestAccountRepository;
  readonly #now: () => number;

  constructor(
    repository: GuestAccountRepository,
    options?: { now?: () => number },
  ) {
    this.#repository = repository;
    this.#now = options?.now ?? Date.now;
  }

  async issue(input: {
    userId: string;
    characterId: string;
    destinationMapId: string;
    destinationEntranceId: string;
    contentVersion: string;
  }): Promise<{ ticket: string; expiresAtMs: number } | undefined> {
    const ticket = randomBytes(32).toString("base64url");
    const nowMs = this.#now();
    const expiresAtMs = nowMs + PLAY_TICKET_TTL_MS;
    const created = await this.#repository.issuePlayTicket({
      tokenHash: hashSecret(ticket),
      userId: input.userId,
      characterId: input.characterId,
      logicalDestination: input.destinationMapId,
      entranceId: input.destinationEntranceId,
      contentVersion: input.contentVersion,
      nonce: randomUUID(),
      now: new Date(nowMs),
      expiresAt: new Date(expiresAtMs),
    });
    return created ? { ticket, expiresAtMs } : undefined;
  }
}

export class DevelopmentTransitionTicketIssuer implements TransitionTicketIssuer {
  readonly #developmentPlayTickets: DevelopmentPlayTickets;

  constructor(developmentPlayTickets: DevelopmentPlayTickets) {
    this.#developmentPlayTickets = developmentPlayTickets;
  }

  issue(input: {
    userId: string;
    characterId: string;
    destinationMapId: string;
    destinationEntranceId: string;
    contentVersion: string;
  }): Promise<{ ticket: string; expiresAtMs: number } | undefined> {
    return Promise.resolve(
      this.#developmentPlayTickets.issueTransition(input),
    );
  }
}
