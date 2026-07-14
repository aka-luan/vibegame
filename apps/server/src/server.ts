import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import type { FastifyInstance } from "fastify";

import { createHttpApp, type ReadinessProbe } from "./http/app.js";
import { PrivacySpikeRoom } from "./rooms/privacy-spike-room.js";

export interface StartFoundationServerOptions {
  host: string;
  port: number;
  readinessProbe: ReadinessProbe;
  logger?: boolean | undefined;
}

export interface RunningFoundationServer {
  app: FastifyInstance;
  port: number;
  close(): Promise<void>;
}

function isColyseusRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  return pathname === "/__healthcheck" || pathname.startsWith("/matchmake/");
}

function installRequestDispatcher(
  app: FastifyInstance,
  fastifyListener: RequestListener,
  colyseusListener: RequestListener,
) {
  app.server.removeAllListeners("request");
  app.server.on(
    "request",
    (request: IncomingMessage, response: ServerResponse) => {
      const listener = isColyseusRequest(request)
        ? colyseusListener
        : fastifyListener;
      listener(request, response);
    },
  );
}

export async function startFoundationServer(
  options: StartFoundationServerOptions,
): Promise<RunningFoundationServer> {
  const app = createHttpApp({
    readinessProbe: options.readinessProbe,
    logger: options.logger,
  });
  await app.ready();

  const fastifyListener = app.server.listeners("request")[0] as
    RequestListener | undefined;
  if (!fastifyListener) {
    throw new Error("Fastify request listener is unavailable");
  }

  const transport = new WebSocketTransport({ server: app.server });
  const gameServer = new Server({
    transport,
    gracefullyShutdown: false,
    greet: false,
  });
  gameServer.define("privacy_spike", PrivacySpikeRoom);
  await gameServer.listen(options.port, options.host);

  const colyseusListener = app.server
    .listeners("request")
    .find((listener) => listener !== fastifyListener) as
    RequestListener | undefined;
  if (!colyseusListener) {
    await gameServer.gracefullyShutdown(false);
    await app.close();
    throw new Error("Colyseus request listener is unavailable");
  }
  installRequestDispatcher(app, fastifyListener, colyseusListener);

  const address = app.server.address();
  if (!address || typeof address === "string") {
    await gameServer.gracefullyShutdown(false);
    await app.close();
    throw new Error("Foundation server did not bind a TCP port");
  }

  return {
    app,
    port: address.port,
    async close() {
      await gameServer.gracefullyShutdown(false);
      await app.close();
    },
  };
}
