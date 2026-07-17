export const ERROR_CODES = {
  databaseUnavailable: "DATABASE_UNAVAILABLE",
  invalidJoinOptions: "INVALID_JOIN_OPTIONS",
  invalidMovementIntention: "INVALID_MOVEMENT_INTENTION",
  invalidPlayTicket: "INVALID_PLAY_TICKET",
  playTicketExpired: "PLAY_TICKET_EXPIRED",
  playTicketReplayed: "PLAY_TICKET_REPLAYED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ROOM_NAMES = {
  village: "village",
} as const;

export const CLIENT_MESSAGES = {
  movement: "movement",
} as const;

export const SERVER_MESSAGES = {
  authoritativeMovement: "authoritative_movement",
  intentionRejected: "intention_rejected",
} as const;

export interface MovementIntention {
  x: number;
  y: number;
  sequence: number;
}

export interface AuthoritativeMovementSnapshot {
  x: number;
  y: number;
  lastProcessedSequence: number;
  serverTimeMs: number;
}

export interface PublicAppearance {
  rigId: string;
  baseLayerId: string;
  armorLayerId: string;
}

export interface PublicPlayerPresence {
  entityId: string;
  displayName: string;
  x: number;
  y: number;
  facing: "east" | "west";
  animation: "idle" | "walk";
  appearance: PublicAppearance;
}
