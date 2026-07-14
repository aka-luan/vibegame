import { createServer, Socket, type Server } from "node:net";

import { connectDatabase, type DatabaseConnection } from "@gameish/database";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../apps/server/src/http/app.js";

const resources: Array<{
  app: ReturnType<typeof createHttpApp>;
  database: DatabaseConnection;
}> = [];
const proxies: PostgresAvailabilityProxy[] = [];

class PostgresAvailabilityProxy {
  readonly #target: URL;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #port: number | undefined;

  constructor(databaseUrl: string) {
    this.#target = new URL(databaseUrl);
  }

  get databaseUrl(): string {
    if (!this.#port) {
      throw new Error("PostgreSQL availability proxy is not listening");
    }
    const proxyUrl = new URL(this.#target);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(this.#port);
    return proxyUrl.toString();
  }

  async start(): Promise<void> {
    if (this.#server) return;

    this.#server = createServer((client) => {
      const upstream = new Socket();
      this.#sockets.add(client);
      this.#sockets.add(upstream);
      const forget = () => {
        this.#sockets.delete(client);
        this.#sockets.delete(upstream);
      };
      client.once("close", forget);
      upstream.once("close", forget);
      client.once("error", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
      upstream.connect(
        Number(this.#target.port || 5432),
        this.#target.hostname,
        () => {
          client.pipe(upstream).pipe(client);
        },
      );
    });

    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.#port ?? 0, "127.0.0.1", resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new Error("PostgreSQL availability proxy did not bind a TCP port");
    }
    this.#port = address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ app, database }) => {
      await app.close();
      await database.close();
    }),
  );
  await Promise.all(proxies.splice(0).map(async (proxy) => proxy.stop()));
});

function appFor(databaseUrl: string) {
  const database = connectDatabase(databaseUrl);
  const app = createHttpApp({ readinessProbe: database, logger: false });
  resources.push({ app, database });
  return app;
}

describe("PostgreSQL availability", () => {
  it("tracks loss and recovery of the configured PostgreSQL dependency", async () => {
    const proxy = new PostgresAvailabilityProxy(
      process.env.TEST_DATABASE_URL ??
        "postgres://gameish:gameish@localhost:5432/gameish",
    );
    proxies.push(proxy);
    await proxy.start();
    const app = appFor(proxy.databaseUrl);

    const readyResponse = await app.inject({ method: "GET", url: "/ready" });
    expect(readyResponse.statusCode).toBe(200);

    await proxy.stop();
    const unavailableResponse = await app.inject({
      method: "GET",
      url: "/ready",
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json()).toEqual({
      status: "not_ready",
      code: "DATABASE_UNAVAILABLE",
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);

    await proxy.start();
    const recoveredResponse = await app.inject({
      method: "GET",
      url: "/ready",
    });
    expect(recoveredResponse.statusCode).toBe(200);
  });
});
