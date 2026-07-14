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
});
