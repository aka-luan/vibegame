import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ROOM_NAMES } from "@gameish/protocol";
import type { LocationCheckpointInput } from "@gameish/database";
import type { FastifyInstance } from "fastify";

import { createHttpApp, type ReadinessProbe } from "./http/app.js";
import { DevelopmentPlayTickets } from "./development/play-tickets.js";
import type { GuestAccountService } from "./identity/guest-account.js";
import {
  FallbackPlayTickets,
  type PlayTicketConsumer,
} from "./identity/play-tickets.js";
import { PrivacySpikeRoom } from "./rooms/privacy-spike-room.js";
import { createVillageRoom } from "./rooms/village-room.js";
import type { QuestPersistence } from "./quests/persistence.js";
import type { RewardPersistence } from "./rewards/persistence.js";
import type { EquipmentPersistence } from "./equipment/persistence.js";
import { MapChatRateLimiter } from "./chat/map-chat.js";

export interface StartFoundationServerOptions {
  host: string;
  port: number;
  publicAddress?: string | undefined;
  allowedOrigin?: string | undefined;
  readinessProbe: ReadinessProbe;
  developmentLoginEnabled?: boolean | undefined;
  mapChatEnabled?: boolean | undefined;
  accountService?: GuestAccountService | undefined;
  playTickets?: PlayTicketConsumer | undefined;
  runtimeEnvironment?: "development" | "test" | "production" | undefined;
  now?: (() => number) | undefined;
  reconnectGraceSeconds?: number | undefined;
  rewardPersistence?: RewardPersistence | undefined;
  questPersistence?: QuestPersistence | undefined;
  equipmentPersistence?: EquipmentPersistence | undefined;
  logEquipmentPersistenceFailure?:
    | ((details: {
        operation: string;
        characterId: string;
        error: unknown;
      }) => void)
    | undefined;
  recordMapChat?:
    | ((details: {
        outcome: "accepted" | "rejected";
        code?: "CHAT_DISABLED" | "INVALID_CHAT_MESSAGE" | "CHAT_RATE_LIMITED";
        utf8Bytes?: number;
        lineCount?: number;
      }) => void)
    | undefined;
  checkpointLocation?:
    ((input: LocationCheckpointInput) => Promise<boolean>) | undefined;
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
  if (
    options.developmentLoginEnabled &&
    options.runtimeEnvironment !== "development" &&
    options.runtimeEnvironment !== "test"
  ) {
    throw new Error("Development login cannot be enabled in production");
  }
  if (
    options.mapChatEnabled &&
    options.runtimeEnvironment !== "development" &&
    options.runtimeEnvironment !== "test"
  ) {
    throw new Error("Controlled map chat cannot be enabled in production");
  }
  const developmentPlayTickets = options.developmentLoginEnabled
    ? new DevelopmentPlayTickets(
        options.now === undefined ? undefined : { now: options.now },
      )
    : undefined;
  const playTickets =
    developmentPlayTickets && options.playTickets
      ? new FallbackPlayTickets([developmentPlayTickets, options.playTickets])
      : (options.playTickets ?? developmentPlayTickets);
  const app = createHttpApp({
    readinessProbe: options.readinessProbe,
    developmentPlayTickets,
    accountService: options.accountService,
    allowedOrigin: options.allowedOrigin,
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
    ...(options.publicAddress === undefined
      ? {}
      : { publicAddress: options.publicAddress }),
    gracefullyShutdown: false,
    greet: false,
  });
  const mapChatRateLimiter = new MapChatRateLimiter();
  gameServer.define("privacy_spike", PrivacySpikeRoom);
  if (playTickets) {
    gameServer.define(
      ROOM_NAMES.village,
      createVillageRoom(playTickets, {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.reconnectGraceSeconds === undefined
          ? {}
          : { reconnectGraceSeconds: options.reconnectGraceSeconds }),
        ...(options.rewardPersistence === undefined
          ? {}
          : { rewardPersistence: options.rewardPersistence }),
        ...(options.questPersistence === undefined
          ? {}
          : { questPersistence: options.questPersistence }),
        ...(options.equipmentPersistence === undefined
          ? {}
          : { equipmentPersistence: options.equipmentPersistence }),
        ...(options.logEquipmentPersistenceFailure === undefined
          ? {
              logEquipmentPersistenceFailure(details) {
                app.log.error(
                  {
                    event: "equipment_persistence_failure",
                    ...details,
                  },
                  "Equipment persistence operation failed",
                );
              },
            }
          : {
              logEquipmentPersistenceFailure:
                options.logEquipmentPersistenceFailure,
            }),
        developmentEquipmentEnabled: options.developmentLoginEnabled === true,
        developmentQuestEnabled: options.developmentLoginEnabled === true,
        mapChatEnabled: options.mapChatEnabled === true,
        mapChatRateLimiter,
        ...(options.recordMapChat === undefined
          ? {
              recordMapChat(details: {
                outcome: "accepted" | "rejected";
                code?:
                  | "CHAT_DISABLED"
                  | "INVALID_CHAT_MESSAGE"
                  | "CHAT_RATE_LIMITED";
                utf8Bytes?: number;
                lineCount?: number;
              }) {
                app.log.info(
                  { event: "map_chat", ...details },
                  "Map chat message handled",
                );
              },
            }
          : { recordMapChat: options.recordMapChat }),
        ...(options.checkpointLocation === undefined
          ? {}
          : { checkpointLocation: options.checkpointLocation }),
        recordLifecycle(event) {
          app.log.info({ event }, "Village connection lifecycle changed");
        },
      }),
    );
  }
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
