import { Client } from "@colyseus/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  startFoundationServer,
  type RunningFoundationServer,
} from "../apps/server/src/server.js";

let runningServer: RunningFoundationServer | undefined;

afterEach(async () => {
  await runningServer?.close();
  runningServer = undefined;
});

async function waitForState(room: {
  onStateChange: { once(callback: () => void): void };
}) {
  await new Promise<void>((resolve) => room.onStateChange.once(resolve));
}

describe("Colyseus per-client state filtering", () => {
  it("never sends one client's private field to another client", async () => {
    runningServer = await startFoundationServer({
      host: "127.0.0.1",
      port: 0,
      logger: false,
      readinessProbe: { check: () => Promise.resolve() },
    });
    const endpoint = `http://127.0.0.1:${String(runningServer.port)}`;
    const first = await new Client(endpoint).joinOrCreate("privacy_spike", {
      displayName: "First",
      privateValue: "secret:first",
    });
    const second = await new Client(endpoint).joinOrCreate("privacy_spike", {
      displayName: "Second",
      privateValue: "secret:second",
    });

    await Promise.all([waitForState(first), waitForState(second)]);

    const firstJson = JSON.stringify(first.state);
    const secondJson = JSON.stringify(second.state);
    expect(firstJson).toContain("First");
    expect(firstJson).toContain("Second");
    expect(firstJson).toContain("secret:first");
    expect(firstJson).not.toContain("secret:second");
    expect(secondJson).toContain("First");
    expect(secondJson).toContain("Second");
    expect(secondJson).toContain("secret:second");
    expect(secondJson).not.toContain("secret:first");

    await Promise.all([first.leave(), second.leave()]);
  });
});
