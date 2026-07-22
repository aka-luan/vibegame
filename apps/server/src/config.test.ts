import { describe, expect, it } from "vitest";

import { parseServerConfig } from "./config.js";

describe("server environment gates", () => {
  it("rejects development login in production", () => {
    expect(() =>
      parseServerConfig({
        NODE_ENV: "production",
        DEVELOPMENT_LOGIN_ENABLED: "true",
      }),
    ).toThrow(/development login/i);
  });

  it("fails closed when development login is enabled without an environment", () => {
    expect(() =>
      parseServerConfig({ DEVELOPMENT_LOGIN_ENABLED: "true" }),
    ).toThrow(/development login/i);
  });

  it("defaults controlled map chat to disabled", () => {
    expect(
      parseServerConfig({ NODE_ENV: "test" }).CONTROLLED_MAP_CHAT_ENABLED,
    ).toBe(false);
  });

  it("allows controlled map chat only in an explicit non-production environment", () => {
    expect(
      parseServerConfig({
        NODE_ENV: "test",
        CONTROLLED_MAP_CHAT_ENABLED: "true",
      }).CONTROLLED_MAP_CHAT_ENABLED,
    ).toBe(true);
    expect(() =>
      parseServerConfig({ CONTROLLED_MAP_CHAT_ENABLED: "true" }),
    ).toThrow(/map chat/i);
    expect(() =>
      parseServerConfig({
        NODE_ENV: "development",
        CONTROLLED_MAP_CHAT_ENABLED: "yes",
      }),
    ).toThrow();
  });
});
