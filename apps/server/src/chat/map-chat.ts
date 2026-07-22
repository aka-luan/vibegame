import { z } from "zod";

export const MAP_CHAT_POLICY = {
  maximumUtf8Bytes: 240,
  maximumLines: 3,
  bucketCapacity: 4,
  refillIntervalMs: 2_000,
} as const;

const chatIntentionSchema = z.object({ text: z.string() }).strict();

export type MapChatRejection = "INVALID_CHAT_MESSAGE" | "CHAT_RATE_LIMITED";

export type MapChatValidation =
  | { accepted: true; text: string; utf8Bytes: number; lineCount: number }
  | {
      accepted: false;
      code: MapChatRejection;
      utf8Bytes?: number;
      lineCount?: number;
    };

function containsInvalidUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validateMapChatIntention(
  unsafeIntention: unknown,
): MapChatValidation {
  const intention = chatIntentionSchema.safeParse(unsafeIntention);
  if (!intention.success)
    return { accepted: false, code: "INVALID_CHAT_MESSAGE" };

  const { text } = intention.data;
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const lineCount = text.split("\n").length;
  if (
    text.trim().length === 0 ||
    containsInvalidUnicode(text) ||
    text.includes("\r") ||
    /[<>]/u.test(text) ||
    utf8Bytes > MAP_CHAT_POLICY.maximumUtf8Bytes ||
    lineCount > MAP_CHAT_POLICY.maximumLines
  ) {
    return {
      accepted: false,
      code: "INVALID_CHAT_MESSAGE",
      utf8Bytes,
      lineCount,
    };
  }
  return { accepted: true, text, utf8Bytes, lineCount };
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

export class MapChatRateLimiter {
  readonly #buckets = new Map<string, Bucket>();

  allow(stableUserKey: string, nowMs: number): boolean {
    const bucket = this.#buckets.get(stableUserKey) ?? {
      tokens: MAP_CHAT_POLICY.bucketCapacity,
      updatedAtMs: nowMs,
    };
    const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
    bucket.tokens = Math.min(
      MAP_CHAT_POLICY.bucketCapacity,
      bucket.tokens + elapsedMs / MAP_CHAT_POLICY.refillIntervalMs,
    );
    bucket.updatedAtMs = nowMs;
    if (bucket.tokens < 1) {
      this.#buckets.set(stableUserKey, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.#buckets.set(stableUserKey, bucket);
    return true;
  }
}
