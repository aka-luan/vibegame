export const ERROR_CODES = {
  databaseUnavailable: "DATABASE_UNAVAILABLE",
  invalidJoinOptions: "INVALID_JOIN_OPTIONS",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
