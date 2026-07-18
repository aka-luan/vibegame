import { randomBytes, randomUUID } from "node:crypto";

import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";

export interface DevelopmentAdmission {
  userId: string;
  characterId: string;
  partyId: string | undefined;
  displayName: string;
  logicalDestination: "map:village";
  contentVersion: "content:village_m1_v1";
  nonce: string;
  appearance: {
    rigId: string;
    baseLayerId: string;
    armorLayerId: string;
  };
}

interface StoredTicket {
  admission: DevelopmentAdmission;
  expiresAt: number;
  consumed: boolean;
}

export type TicketConsumption =
  | { success: true; admission: DevelopmentAdmission }
  | { success: false; code: ErrorCode };

export class DevelopmentPlayTickets {
  readonly #tickets = new Map<string, StoredTicket>();
  readonly #now: () => number;
  readonly #timeToLiveMs: number;

  constructor(options?: { now?: () => number; timeToLiveMs?: number }) {
    this.#now = options?.now ?? Date.now;
    this.#timeToLiveMs = options?.timeToLiveMs ?? 15_000;
  }

  issue(
    displayName: string,
    options: { partyId?: string | undefined } = {},
  ): { ticket: string; expiresAt: number } {
    this.#purgeExpired();
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#timeToLiveMs;
    this.#tickets.set(ticket, {
      admission: {
        userId: `development:user:${randomUUID()}`,
        characterId: `development:character:${randomUUID()}`,
        partyId: options.partyId,
        displayName,
        logicalDestination: "map:village",
        contentVersion: "content:village_m1_v1",
        nonce: randomUUID(),
        appearance: {
          rigId: "rig:village_placeholder",
          baseLayerId: "base",
          armorLayerId: "tunic",
        },
      },
      expiresAt,
      consumed: false,
    });
    return { ticket, expiresAt };
  }

  consume(ticket: string): TicketConsumption {
    const stored = this.#tickets.get(ticket);
    if (!stored) {
      return { success: false, code: ERROR_CODES.invalidPlayTicket };
    }
    if (stored.consumed) {
      return { success: false, code: ERROR_CODES.playTicketReplayed };
    }
    if (this.#now() >= stored.expiresAt) {
      this.#tickets.delete(ticket);
      return { success: false, code: ERROR_CODES.playTicketExpired };
    }

    stored.consumed = true;
    return { success: true, admission: stored.admission };
  }

  #purgeExpired() {
    const now = this.#now();
    for (const [ticket, stored] of this.#tickets) {
      if (now >= stored.expiresAt) this.#tickets.delete(ticket);
    }
  }
}
