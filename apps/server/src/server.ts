import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";

import { Server, type RegisteredHandler } from "@colyseus/core";
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
import { createForestRoom } from "./rooms/forest-room.js";
import { PortalCooldownRegistry } from "./rooms/portal-transition-handler.js";
import { createVillageRoom } from "./rooms/village-room.js";
import {
  DevelopmentTransitionTicketIssuer,
  FallbackTransitionTicketIssuer,
  type TransitionTicketIssuer,
} from "./identity/transition-tickets.js";
import type { QuestPersistence } from "./quests/persistence.js";
import type { RewardPersistence } from "./rewards/persistence.js";
import type { EquipmentPersistence } from "./equipment/persistence.js";
import { MapChatRateLimiter } from "./chat/map-chat.js";
import {
  DEFAULT_MAP_INSTANCE_HARD_CAPACITY,
  DEFAULT_MAP_INSTANCE_SOFT_POPULATION_TARGET,
  MapPlacementDriver,
} from "./rooms/placement.js";
import { PartyCoordinator } from "./party/coordinator.js";
import { isLogicalMapAccessible } from "./rooms/logical-maps.js";

export interface StartFoundationServerOptions {
  host: string;
  port: number;
  publicAddress?: string | undefined;
  allowedOrigin?: string | undefined;
  readinessProbe: ReadinessProbe;
  developmentLoginEnabled?: boolean | undefined;
  mapChatEnabled?: boolean | undefined;
  developmentInstanceInspectionEnabled?: boolean | undefined;
  accountService?: GuestAccountService | undefined;
  playTickets?: PlayTicketConsumer | undefined;
  runtimeEnvironment?: "development" | "test" | "production" | undefined;
  now?: (() => number) | undefined;
  reconnectGraceSeconds?: number | undefined;
  checkpointTimeoutMs?: number | undefined;
  softPopulationTarget?: number | undefined;
  hardCapacity?: number | undefined;
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
  recordCheckpointTimeout?:
    | ((details: {
        logicalMapId: string;
        sessionId: string;
        connectionState: LocationCheckpointInput["connectionState"];
        timeoutMs: number;
      }) => void)
    | undefined;
  transitionTickets?: TransitionTicketIssuer | undefined;
  canAccessMap?:
    ((characterId: string, logicalMapId: string) => boolean) | undefined;
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
  isMapInstance: (roomId: string) => boolean,
) {
  app.server.removeAllListeners("request");
  app.server.on(
    "request",
    (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const joinByIdMatch =
        request.method === "POST"
          ? /^\/matchmake\/joinById\/([^/]+)$/.exec(pathname)
          : undefined;
      if (joinByIdMatch) {
        let roomId: string | undefined;
        try {
          roomId = decodeURIComponent(joinByIdMatch[1] ?? "");
        } catch {
          roomId = undefined;
        }
        if (roomId && isMapInstance(roomId)) {
          const body = JSON.stringify({
            error: "Map instance selection is not client-controlled",
          });
          response.writeHead(400, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          });
          response.end(body);
          return;
        }
      }
      const listener = isColyseusRequest(request)
        ? colyseusListener
        : fastifyListener;
      listener(request, response);
    },
  );
}

function registerPlacementLifecycle(
  handler: RegisteredHandler,
  logicalMapId: string,
  app: FastifyInstance,
): void {
  handler.on("create", (room: { roomId: string }) => {
    app.log.info(
      {
        event: "map_instance_created",
        logicalMapId,
        roomId: room.roomId,
      },
      "Map instance created",
    );
  });
  handler.on(
    "join",
    (room: { roomId: string; clients: { length: number } }) => {
      app.log.info(
        {
          event: "map_instance_placement",
          logicalMapId,
          roomId: room.roomId,
          clients: room.clients.length,
        },
        "Player placed in map instance",
      );
    },
  );
  handler.on("dispose", (room: { roomId: string }) => {
    app.log.info(
      {
        event: "map_instance_disposed",
        logicalMapId,
        roomId: room.roomId,
      },
      "Map instance disposed after its lifecycle work",
    );
  });
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
  if (
    options.developmentInstanceInspectionEnabled &&
    options.runtimeEnvironment !== "development" &&
    options.runtimeEnvironment !== "test"
  ) {
    throw new Error(
      "Development instance inspection cannot be enabled in production",
    );
  }
  const placementDriver = new MapPlacementDriver(
    {
      softPopulationTarget:
        options.softPopulationTarget ??
        DEFAULT_MAP_INSTANCE_SOFT_POPULATION_TARGET,
      hardCapacity: options.hardCapacity ?? DEFAULT_MAP_INSTANCE_HARD_CAPACITY,
    },
    options.now === undefined ? undefined : { now: options.now },
  );
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
    developmentInstanceInspectionEnabled:
      options.developmentInstanceInspectionEnabled,
    inspectInstances: () => placementDriver.inspectInstances(),
    accountService: options.accountService,
    allowedOrigin: options.allowedOrigin,
    logger: options.logger,
  });
  await app.ready();
  const recordMapChat: NonNullable<
    StartFoundationServerOptions["recordMapChat"]
  > =
    options.recordMapChat ??
    ((details) => {
      app.log.info(
        { event: "map_chat", ...details },
        "Map chat message handled",
      );
    });

  const fastifyListener = app.server.listeners("request")[0] as
    RequestListener | undefined;
  if (!fastifyListener) {
    throw new Error("Fastify request listener is unavailable");
  }

  const transport = new WebSocketTransport({ server: app.server });
  const gameServer = new Server({
    transport,
    driver: placementDriver,
    ...(options.publicAddress === undefined
      ? {}
      : { publicAddress: options.publicAddress }),
    gracefullyShutdown: false,
    greet: false,
  });
  const mapChatRateLimiter = new MapChatRateLimiter();
  const parties = new PartyCoordinator();
  const canAccessMap =
    options.canAccessMap ??
    ((_characterId: string, logicalMapId: string) =>
      isLogicalMapAccessible(logicalMapId));
  gameServer.define("privacy_spike", PrivacySpikeRoom);
  const developmentTransitionTickets = developmentPlayTickets
    ? new DevelopmentTransitionTicketIssuer(developmentPlayTickets)
    : undefined;
  const transitionTickets =
    developmentTransitionTickets && options.transitionTickets
      ? new FallbackTransitionTicketIssuer([
          developmentTransitionTickets,
          options.transitionTickets,
        ])
      : (options.transitionTickets ?? developmentTransitionTickets);
  // One registry shared by every logical-map room: the portal cooldown
  // follows the character across the transition, not the source session.
  const portalCooldowns = new PortalCooldownRegistry();
  if (playTickets) {
    const villageHandler = gameServer
      .define(
        ROOM_NAMES.village,
        createVillageRoom(playTickets, {
          hardCapacity: placementDriver.hardCapacity,
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
          recordMapChat,
          ...(options.checkpointLocation === undefined
            ? {}
            : { checkpointLocation: options.checkpointLocation }),
          ...(options.checkpointTimeoutMs === undefined
            ? {}
            : { checkpointTimeoutMs: options.checkpointTimeoutMs }),
          recordCheckpointTimeout(details) {
            if (options.recordCheckpointTimeout) {
              options.recordCheckpointTimeout(details);
              return;
            }
            app.log.warn(
              { event: "map_checkpoint_timeout", ...details },
              "Map checkpoint exceeded its lifecycle timeout",
            );
          },
          ...(transitionTickets === undefined ? {} : { transitionTickets }),
          portalCooldowns,
          parties,
          placement: placementDriver,
          canAccessMap,
          recordPartyTravelFailure(actionId) {
            app.log.error(
              {
                event: "party_travel_failure",
                actionId,
                logicalMapId: "map:village",
              },
              "Party travel failed unexpectedly",
            );
          },
          recordLifecycle(event) {
            app.log.info({ event }, "Village connection lifecycle changed");
          },
        }),
      )
      .filterBy(["partyReservationId"]);
    registerPlacementLifecycle(villageHandler, "map:village", app);
    const forestHandler = gameServer
      .define(
        ROOM_NAMES.forest,
        createForestRoom(playTickets, {
          hardCapacity: placementDriver.hardCapacity,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.reconnectGraceSeconds === undefined
            ? {}
            : { reconnectGraceSeconds: options.reconnectGraceSeconds }),
          ...(options.checkpointLocation === undefined
            ? {}
            : { checkpointLocation: options.checkpointLocation }),
          ...(options.checkpointTimeoutMs === undefined
            ? {}
            : { checkpointTimeoutMs: options.checkpointTimeoutMs }),
          recordCheckpointTimeout(details) {
            if (options.recordCheckpointTimeout) {
              options.recordCheckpointTimeout(details);
              return;
            }
            app.log.warn(
              { event: "map_checkpoint_timeout", ...details },
              "Map checkpoint exceeded its lifecycle timeout",
            );
          },
          ...(transitionTickets === undefined ? {} : { transitionTickets }),
          portalCooldowns,
          parties,
          placement: placementDriver,
          canAccessMap,
          recordPartyTravelFailure(actionId) {
            app.log.error(
              {
                event: "party_travel_failure",
                actionId,
                logicalMapId: "map:forest",
              },
              "Party travel failed unexpectedly",
            );
          },
          mapChatEnabled: options.mapChatEnabled === true,
          mapChatRateLimiter,
          recordMapChat,
          recordLifecycle(event) {
            app.log.info({ event }, "Forest connection lifecycle changed");
          },
        }),
      )
      .filterBy(["partyReservationId"]);
    registerPlacementLifecycle(forestHandler, "map:forest", app);
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
  installRequestDispatcher(app, fastifyListener, colyseusListener, (roomId) =>
    placementDriver.isMapInstance(roomId),
  );

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
