import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp, type ReadinessProbe } from "./app.js";

const openApps: Array<ReturnType<typeof createHttpApp>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

function appWith(probe: ReadinessProbe): ReturnType<typeof createHttpApp> {
  const app = createHttpApp({ readinessProbe: probe, logger: false });
  openApps.push(app);
  return app;
}

describe("process health and database readiness", () => {
  it("reports process health even when PostgreSQL is unavailable", async () => {
    const app = appWith({
      check: () => Promise.reject(new Error("connection refused")),
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports readiness only after PostgreSQL answers", async () => {
    const app = appWith({ check: () => Promise.resolve() });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("returns a stable safe code when PostgreSQL is unavailable", async () => {
    const app = appWith({
      check: () => Promise.reject(new Error("secret connection detail")),
    });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["x-correlation-id"]).toEqual(expect.any(String));
    expect(response.json()).toEqual({
      status: "not_ready",
      code: "DATABASE_UNAVAILABLE",
    });
    expect(response.body).not.toContain("secret connection detail");
  });
});
