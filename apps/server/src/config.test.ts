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
  it("defaults map instance capacity to a soft target below a hard limit", () => {
    const config = parseServerConfig({ NODE_ENV: "test" });
    expect(config.MAP_INSTANCE_SOFT_POPULATION_TARGET).toBe(25);
    expect(config.MAP_INSTANCE_HARD_CAPACITY).toBe(30);
    expect(config.DEVELOPMENT_INSTANCE_INSPECTION_ENABLED).toBe(false);
  });

  it("rejects a hard capacity below the soft population target", () => {
    expect(() =>
      parseServerConfig({
        NODE_ENV: "test",
        MAP_INSTANCE_SOFT_POPULATION_TARGET: "3",
        MAP_INSTANCE_HARD_CAPACITY: "2",
      }),
    ).toThrow(/hard capacity/i);
  });

  it("fails closed for development instance inspection in production", () => {
    expect(() =>
      parseServerConfig({
        NODE_ENV: "production",
        DEVELOPMENT_INSTANCE_INSPECTION_ENABLED: "true",
      }),
    ).toThrow(/instance inspection/i);
  });
});
