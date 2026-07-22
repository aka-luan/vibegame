import { describe, expect, it } from "vitest";

import {
  MAP_CHAT_POLICY,
  MapChatRateLimiter,
  validateMapChatIntention,
} from "./map-chat.js";

describe("map chat payload", () => {
  it.each([
    [{ text: "" }, "empty"],
    [{ text: "   \n" }, "whitespace"],
    [{ text: "<strong>hello</strong>" }, "markup"],
    [{ text: "one\ntwo\nthree\nfour" }, "line overflow"],
    [
      { text: "x".repeat(MAP_CHAT_POLICY.maximumUtf8Bytes + 1) },
      "byte overflow",
    ],
    [{ text: "bad\ud800text" }, "unpaired surrogate"],
    [{ text: "carriage\rreturn" }, "ambiguous newline"],
    [{ text: 12 }, "malformed value"],
    [{ text: "hello", extra: true }, "unknown field"],
  ])("rejects %s (%s)", (payload, description) => {
    expect(description).toBeTruthy();
    expect(validateMapChatIntention(payload)).toMatchObject({
      accepted: false,
      code: "INVALID_CHAT_MESSAGE",
    });
  });

  it("accepts bounded Unicode and counts UTF-8 bytes", () => {
    expect(
      validateMapChatIntention({ text: "Olá, 勇者 👋\nTudo bem?" }),
    ).toEqual({
      accepted: true,
      text: "Olá, 勇者 👋\nTudo bem?",
      utf8Bytes: 27,
      lineCount: 2,
    });
  });

  it("enforces byte length rather than UTF-16 length", () => {
    expect(
      validateMapChatIntention({
        text: "é".repeat(MAP_CHAT_POLICY.maximumUtf8Bytes / 2),
      }).accepted,
    ).toBe(true);
    expect(
      validateMapChatIntention({
        text: "é".repeat(MAP_CHAT_POLICY.maximumUtf8Bytes / 2 + 1),
      }).accepted,
    ).toBe(false);
  });
});

describe("map chat token bucket", () => {
  it("allows a burst then recovers one token per refill interval", () => {
    const limiter = new MapChatRateLimiter();
    for (let index = 0; index < MAP_CHAT_POLICY.bucketCapacity; index += 1) {
      expect(limiter.allow("character:one", 1_000)).toBe(true);
    }
    expect(limiter.allow("character:one", 1_000)).toBe(false);
    expect(
      limiter.allow("character:one", 1_000 + MAP_CHAT_POLICY.refillIntervalMs),
    ).toBe(true);
  });

  it("isolates users and retains limits across disconnect/rejoin keys", () => {
    const limiter = new MapChatRateLimiter();
    for (let index = 0; index < MAP_CHAT_POLICY.bucketCapacity; index += 1) {
      limiter.allow("character:returning", 1_000);
    }
    expect(limiter.allow("character:returning", 1_000)).toBe(false);
    expect(limiter.allow("character:other", 1_000)).toBe(true);
    expect(limiter.allow("character:returning", 1_000)).toBe(false);
  });
});
