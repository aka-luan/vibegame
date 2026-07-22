import { randomBytes, randomUUID } from "node:crypto";

import { villageSlice } from "@gameish/content/slices/village";
import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";

export interface DevelopmentAdmission {
  userId: string;
  characterId: string;
  partyId: string | undefined;
  displayName: string;
  logicalDestination: string;
  entranceId: string;
  contentVersion: typeof villageSlice.contentVersion;
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

interface StoredIdentity {
  characterId: string;
  displayName: string;
  appearance: DevelopmentAdmission["appearance"];
}

export class DevelopmentPlayTickets {
  readonly #tickets = new Map<string, StoredTicket>();
  readonly #identities = new Map<string, StoredIdentity>();
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
    const userId = `development:user:${randomUUID()}`;
    const characterId = `development:character:${randomUUID()}`;
    const appearance = {
      rigId: villageSlice.rigId,
      baseLayerId: "base",
      armorLayerId: "tunic",
    };
    this.#identities.set(userId, { characterId, displayName, appearance });
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#timeToLiveMs;
    this.#tickets.set(ticket, {
      admission: {
        userId,
        characterId,
        partyId: options.partyId,
        displayName,
        logicalDestination: villageSlice.mapId,
        entranceId: villageSlice.entranceId,
        contentVersion: villageSlice.contentVersion,
        nonce: randomUUID(),
        appearance,
      },
      expiresAt,
      consumed: false,
    });
    return { ticket, expiresAt };
  }

  /**
   * Issues a ticket that continues an already-issued development identity
   * (same userId/characterId/displayName/appearance) at a new destination
   * map/entrance, for portal transitions initiated from inside a room. The
   * identity must have been created by a prior `issue()` call.
   */
  issueTransition(input: {
    userId: string;
    characterId: string;
    destinationMapId: string;
    destinationEntranceId: string;
    contentVersion: string;
  }): { ticket: string; expiresAtMs: number } | undefined {
    this.#purgeExpired();
    const identity = this.#identities.get(input.userId);
    if (!identity || identity.characterId !== input.characterId) {
      return undefined;
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAtMs = this.#now() + this.#timeToLiveMs;
    this.#tickets.set(ticket, {
      admission: {
        userId: input.userId,
        characterId: input.characterId,
        partyId: undefined,
        displayName: identity.displayName,
        logicalDestination: input.destinationMapId,
        entranceId: input.destinationEntranceId,
        contentVersion: input.contentVersion,
        nonce: randomUUID(),
        appearance: identity.appearance,
      },
      expiresAt: expiresAtMs,
      consumed: false,
    });
    return { ticket, expiresAtMs };
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
