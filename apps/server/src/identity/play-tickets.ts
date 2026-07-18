import { createHash } from "node:crypto";

import { ERROR_CODES, type ErrorCode } from "@gameish/protocol";
import type {
  GuestAccountRepository,
  PlayTicketAdmission,
} from "@gameish/database";

export interface PlayTicketConsumer {
  consume(
    ticket: string,
  ): Promise<PlayTicketConsumption> | PlayTicketConsumption;
}

export type PlayTicketConsumption =
  | { success: true; admission: PlayTicketAdmission }
  | { success: false; code: ErrorCode };

export class FallbackPlayTickets implements PlayTicketConsumer {
  constructor(readonly consumers: readonly PlayTicketConsumer[]) {}

  async consume(ticket: string): Promise<PlayTicketConsumption> {
    let lastFailure: PlayTicketConsumption = {
      success: false,
      code: ERROR_CODES.invalidPlayTicket,
    };
    for (const consumer of this.consumers) {
      const result = await consumer.consume(ticket);
      if (result.success) return result;
      if (
        lastFailure.code === ERROR_CODES.invalidPlayTicket ||
        result.code !== ERROR_CODES.invalidPlayTicket
      ) {
        lastFailure = result;
      }
    }
    return lastFailure;
  }
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export class DatabasePlayTickets implements PlayTicketConsumer {
  readonly #repository: GuestAccountRepository;
  readonly #now: () => number;

  constructor(
    repository: GuestAccountRepository,
    options?: { now?: () => number },
  ) {
    this.#repository = repository;
    this.#now = options?.now ?? Date.now;
  }

  async consume(ticket: string): Promise<PlayTicketConsumption> {
    const result = await this.#repository.consumePlayTicket(
      hashSecret(ticket),
      new Date(this.#now()),
    );
    if (result.success) return result;
    if (result.reason === "expired") {
      return { success: false, code: ERROR_CODES.playTicketExpired };
    }
    if (result.reason === "replayed") {
      return { success: false, code: ERROR_CODES.playTicketReplayed };
    }
    return { success: false, code: ERROR_CODES.invalidPlayTicket };
  }
}
