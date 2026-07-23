import { Room, ServerError, type Client } from "@colyseus/core";
import { MapSchema, Schema, type } from "@colyseus/schema";
import forestMap from "@gameish/content/forest-map-server";
import villageCharacter from "@gameish/content/village-character";
import villageQuests from "@gameish/content/village-quests-server";
import { forestSlice } from "@gameish/content/slices/forest";
import type { LocationCheckpointInput } from "@gameish/database";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type MapChatMessage,
  type MovementIntention,
  type PublicAppearance as PublicAppearanceState,
  type PublicForestState,
  type PublicPlayerState,
  type QuestStateMessage,
  type TransitionRejectedMessage,
  type TransitionTicketMessage,
  type PartyResultMessage,
  type MapOverviewMessage,
} from "@gameish/protocol";
import { PLAYER_MOVEMENT } from "@gameish/world";
import { z } from "zod";

import type { PlayTicketConsumer } from "../identity/play-tickets.js";
import type { TransitionTicketIssuer } from "../identity/transition-tickets.js";
import {
  MapChatRateLimiter,
  validateMapChatIntention,
} from "../chat/map-chat.js";
import { applyFootMovementStep } from "./map-movement.js";
import {
  PortalCooldownRegistry,
  PortalTransitionCoordinator,
} from "./portal-transition-handler.js";
import { portalTransitionSchema } from "./portal-transition.js";
import {
  DEFAULT_MAP_INSTANCE_HARD_CAPACITY,
  MapPlacementDriver,
  type MapRoomMetadata,
} from "./placement.js";
import { resolveSpawnPosition } from "./spawn-resolution.js";
import { LOGICAL_MAP_OVERVIEW_MAPS, LOGICAL_MAPS } from "./logical-maps.js";
import { buildMapOverview } from "./map-overview.js";
import type { QuestPersistence } from "../quests/persistence.js";
import { PartyCoordinator } from "../party/coordinator.js";
import { registerPartyRoomHandlers } from "../party/room-handlers.js";
import { prepareTravelToMember } from "../party/travel-to-member.js";

const clientJoinOptionsSchema = z
  .object({ ticket: z.string().min(1).max(200) })
  .strict();
const joinOptionsSchema = clientJoinOptionsSchema.extend({
  partyReservationId: z.string().min(1).max(100).optional(),
});
const movementIntentionSchema = z
  .object({
    x: z.number().finite().min(-1).max(1),
    y: z.number().finite().min(-1).max(1),
    sequence: z.number().int().nonnegative(),
  })
  .strict()
  .refine((intention) => Math.hypot(intention.x, intention.y) <= 1, {
    message: "Movement direction exceeds normalized speed",
  });

const MAX_MOVEMENT_MESSAGE_BYTES = 256;
const MAX_INTENTION_VIOLATIONS = 5;
const MAX_PENDING_INTENTIONS = 120;

class PublicAppearance extends Schema {
  @type("string")
  rigId = "";

  @type("string")
  baseLayerId = "";

  @type("string")
  armorLayerId = "";
}

class PublicPlayer extends Schema {
  @type("string")
  displayName = "";

  @type("number")
  x = 0;

  @type("number")
  y = 0;

  @type("string")
  facing: PublicPlayerState["facing"] = "east";

  @type("string")
  animation: PublicPlayerState["animation"] = "idle";

  @type("number")
  appearanceRevision = 0;

  @type(PublicAppearance)
  appearance = new PublicAppearance();
}

class ForestState extends Schema {
  @type("number")
  serverTimeMs = 0;

  @type({ map: PublicPlayer })
  players = new MapSchema<PublicPlayer>();
}

type AssertConforms<T extends U, U> = T;

export type ForestPublicAppearanceConformance = AssertConforms<
  PublicAppearance,
  PublicAppearanceState
>;
export type ForestPublicPlayerConformance = AssertConforms<
  PublicPlayer,
  PublicPlayerState
>;
export type ForestStateConformance = AssertConforms<
  ForestState,
  PublicForestState
>;

export type { AssertConforms, PublicAppearance, PublicPlayer, ForestState };

const DEFAULT_CHECKPOINT_TIMEOUT_MS = 1_000;

/**
 * The forest room remains traversable-only for combat and dialogue, but it
 * records visit objective events privately. Movement, checkpointing, and
 * portal transitions reuse the same shared helpers as the village room so
 * that behavior exists exactly once; only the parts that are irreducibly
 * Colyseus/room-specific (state schema, onMessage wiring, per-session
 * bookkeeping) are duplicated here.
 */
export function createForestRoom(
  playTickets: PlayTicketConsumer,
  options: {
    now?: () => number;
    reconnectGraceSeconds?: number;
    hardCapacity?: number;
    checkpointLocation?:
      ((input: LocationCheckpointInput) => Promise<boolean>) | undefined;
    recordArrival?:
      | ((characterId: string, logicalMapId: string) => Promise<void>)
      | undefined;
    checkpointTimeoutMs?: number;
    recordCheckpointTimeout?: (details: {
      logicalMapId: string;
      sessionId: string;
      connectionState: LocationCheckpointInput["connectionState"];
      timeoutMs: number;
    }) => void;
    recordLifecycle?: (
      event: "disconnected" | "reconnected" | "removed",
    ) => void;
    transitionTickets?: TransitionTicketIssuer;
    portalCooldowns?: PortalCooldownRegistry;
    questPersistence?: QuestPersistence;
    mapChatEnabled?: boolean;
    mapChatRateLimiter?: MapChatRateLimiter;
    recordMapChat?: (details: {
      outcome: "accepted" | "rejected";
      code?: "CHAT_DISABLED" | "INVALID_CHAT_MESSAGE" | "CHAT_RATE_LIMITED";
      utf8Bytes?: number;
      lineCount?: number;
    }) => void;
    parties?: PartyCoordinator;
    placement?: MapPlacementDriver;
    canAccessMap?: (characterId: string, logicalMapId: string) => boolean;
    recordPartyTravelFailure?: (actionId: string) => void;
  } = {},
) {
  const transitionTickets: TransitionTicketIssuer =
    options.transitionTickets ?? {
      issue: () => Promise.resolve(undefined),
    };
  // Shared across every logical-map room when the server wires it, so the
  // cooldown survives the transition that removes the source session.
  const portalCooldowns =
    options.portalCooldowns ?? new PortalCooldownRegistry();
  const parties = options.parties ?? new PartyCoordinator();
  const placement =
    options.placement ??
    new MapPlacementDriver({
      softPopulationTarget: 25,
      hardCapacity: options.hardCapacity ?? DEFAULT_MAP_INSTANCE_HARD_CAPACITY,
    });

  return class ForestRoom extends Room<{
    state: ForestState;
    metadata: MapRoomMetadata;
  }> {
    override state = new ForestState();
    readonly #pendingIntentions = new Map<
      string,
      Map<number, MovementIntention>
    >();
    readonly #intentionViolations = new Map<string, number>();
    readonly #lastProcessedSequences = new Map<string, number>();
    readonly #now = options.now ?? Date.now;
    readonly #reconnectGraceSeconds = options.reconnectGraceSeconds ?? 5;
    readonly #checkpointTimeoutMs = Math.min(
      options.checkpointTimeoutMs ?? DEFAULT_CHECKPOINT_TIMEOUT_MS,
      Math.max(1, this.#reconnectGraceSeconds * 1_000),
    );
    readonly #checkpointLocation = options.checkpointLocation;
    readonly #recordArrival = options.recordArrival;
    readonly #questPersistence = options.questPersistence;
    readonly #mapChatEnabled = options.mapChatEnabled ?? false;
    readonly #mapChatRateLimiter =
      options.mapChatRateLimiter ?? new MapChatRateLimiter();
    readonly #playerIdentity = new Map<
      string,
      { userId: string; characterId: string; partyId: string | undefined }
    >();
    readonly #sessionEntranceId = new Map<string, string>();
    readonly #lastCheckpointAtMs = new Map<string, number>();
    readonly #disconnectedSessions = new Set<string>();
    readonly #discoveredMapIds = new Map<string, Set<string>>();
    readonly #partyDepartures = new Set<string>();
    readonly #portalTransitions = new PortalTransitionCoordinator({
      sourceMap: forestMap,
      transitionTickets,
      cooldowns: portalCooldowns,
      now: this.#now,
    });

    static override onAuth(
      _token: string,
      unsafeOptions: unknown,
    ): Promise<unknown> {
      const parsed = clientJoinOptionsSchema.safeParse(unsafeOptions);
      if (!parsed.success) {
        throw new ServerError(4_221, ERROR_CODES.invalidJoinOptions);
      }
      const reservationId = parties.travelReservationForAdmission(
        parsed.data.ticket,
        forestSlice.mapId,
        (options.now ?? Date.now)(),
      );
      if (
        reservationId !== undefined &&
        !placement.hasPartyReservationToken(reservationId, forestSlice.mapId)
      ) {
        throw new ServerError(4_228, ERROR_CODES.instanceUnavailable);
      }
      if (reservationId !== undefined) {
        (unsafeOptions as { partyReservationId?: string }).partyReservationId =
          reservationId;
      }
      return Promise.resolve(true);
    }

    override onCreate(unsafeOptions?: unknown) {
      const creationOptions = joinOptionsSchema.safeParse(unsafeOptions);
      this.maxClients =
        options.hardCapacity ?? DEFAULT_MAP_INSTANCE_HARD_CAPACITY;
      this.metadata = {
        logicalMapId: forestSlice.mapId,
        instanceRole: "public",
        ...(creationOptions.success &&
        creationOptions.data.partyReservationId !== undefined
          ? { partyReservationId: creationOptions.data.partyReservationId }
          : {}),
      };
      this.maxMessagesPerSecond = 60;
      this.state.serverTimeMs = this.#now();
      this.onMessage(
        CLIENT_MESSAGES.movement,
        (client, unsafeIntention: unknown) => {
          const encodedIntention = JSON.stringify(unsafeIntention);
          const intention = movementIntentionSchema.safeParse(unsafeIntention);
          const player = this.state.players.get(client.sessionId);
          const pending = this.#pendingIntentions.get(client.sessionId);
          const lastProcessedSequence = this.#lastProcessedSequences.get(
            client.sessionId,
          );
          if (
            encodedIntention === undefined ||
            Buffer.byteLength(encodedIntention) > MAX_MOVEMENT_MESSAGE_BYTES ||
            !intention.success ||
            !player ||
            !pending ||
            lastProcessedSequence === undefined ||
            intention.data.sequence >
              lastProcessedSequence + MAX_PENDING_INTENTIONS
          ) {
            this.#rejectIntention(client);
            return;
          }
          if (intention.data.sequence <= lastProcessedSequence) return;
          pending.set(intention.data.sequence, intention.data);
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.portalTransition,
        (client, unsafeIntention: unknown) => {
          const memberId = this.#playerIdentity.get(
            client.sessionId,
          )?.characterId;
          void this.#handlePortalTransition(client, unsafeIntention).catch(
            () => {
              if (memberId) parties.cancelTravelForParty(memberId);
              const actionId =
                unsafeIntention &&
                typeof unsafeIntention === "object" &&
                "actionId" in unsafeIntention &&
                typeof unsafeIntention.actionId === "string"
                  ? unsafeIntention.actionId
                  : "invalid-transition";
              options.recordPartyTravelFailure?.(actionId);
              client.send(SERVER_MESSAGES.transitionRejected, {
                actionId,
                code: ERROR_CODES.transitionUnavailable,
              } satisfies TransitionRejectedMessage);
            },
          );
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.mapChat,
        (client, unsafeIntention: unknown) => {
          this.#handleMapChat(client, unsafeIntention);
        },
      );
      this.onMessage(CLIENT_MESSAGES.questStateRequest, (client) => {
        void this.#sendVisitQuestState(client);
      });
      this.onMessage(CLIENT_MESSAGES.mapOverviewRequest, (client) => {
        void this.#sendMapOverview(client);
      });
      registerPartyRoomHandlers({
        room: this,
        parties,
        memberIdFor: (sessionId) =>
          this.#playerIdentity.get(sessionId)?.characterId,
        travelToMember: (client, intention) =>
          this.#handleTravelToMember(client, intention),
        ...(options.recordPartyTravelFailure === undefined
          ? {}
          : {
              recordUnexpectedTravelFailure: options.recordPartyTravelFailure,
            }),
      });

      this.setSimulationInterval(
        () => this.#simulateFixedStep(),
        PLAYER_MOVEMENT.fixedStepMs,
      );
    }

    #handleMapChat(client: Client, unsafeIntention: unknown): void {
      if (!this.#mapChatEnabled) {
        options.recordMapChat?.({ outcome: "rejected", code: "CHAT_DISABLED" });
        client.send(SERVER_MESSAGES.chatRejected, {
          code: ERROR_CODES.chatDisabled,
        });
        return;
      }
      const validation = validateMapChatIntention(unsafeIntention);
      if (!validation.accepted) {
        options.recordMapChat?.({
          outcome: "rejected",
          code: "INVALID_CHAT_MESSAGE",
          ...(validation.utf8Bytes === undefined
            ? {}
            : { utf8Bytes: validation.utf8Bytes }),
          ...(validation.lineCount === undefined
            ? {}
            : { lineCount: validation.lineCount }),
        });
        client.send(SERVER_MESSAGES.chatRejected, {
          code: ERROR_CODES.invalidChatMessage,
        });
        return;
      }
      const identity = this.#playerIdentity.get(client.sessionId);
      const player = this.state.players.get(client.sessionId);
      if (!identity || !player) return;
      if (
        !this.#mapChatRateLimiter.allow(
          identity.userId,
          this.state.serverTimeMs,
        )
      ) {
        options.recordMapChat?.({
          outcome: "rejected",
          code: "CHAT_RATE_LIMITED",
          utf8Bytes: validation.utf8Bytes,
          lineCount: validation.lineCount,
        });
        client.send(SERVER_MESSAGES.chatRejected, {
          code: ERROR_CODES.chatRateLimited,
        });
        return;
      }
      const message: MapChatMessage = {
        entityId: client.sessionId,
        displayName: player.displayName,
        text: validation.text,
        serverTimeMs: this.state.serverTimeMs,
      };
      options.recordMapChat?.({
        outcome: "accepted",
        utf8Bytes: validation.utf8Bytes,
        lineCount: validation.lineCount,
      });
      this.broadcast(SERVER_MESSAGES.mapChat, message);
    }

    async #handlePortalTransition(
      client: Client,
      unsafeIntention: unknown,
    ): Promise<void> {
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!identity) return;
      const intention = portalTransitionSchema.safeParse(unsafeIntention);
      if (!intention.success) return;
      const plan = parties.beginCohesiveTravel(
        identity.characterId,
        this.roomId,
        intention.data.travelMode === "alone",
      );
      if (!plan.accepted) {
        const actionId =
          unsafeIntention &&
          typeof unsafeIntention === "object" &&
          "actionId" in unsafeIntention &&
          typeof unsafeIntention.actionId === "string"
            ? unsafeIntention.actionId
            : "invalid-transition";
        client.send(SERVER_MESSAGES.transitionRejected, {
          actionId,
          code: plan.code,
        } satisfies TransitionRejectedMessage);
        return;
      }
      const outcome = await this.#portalTransitions.evaluateCohesive({
        initiatorSessionId: client.sessionId,
        unsafeIntention: intention.data,
        reservationId: plan.reservationId,
        members: plan.members.map((member) => {
          const player = this.state.players.get(member.entityId);
          const memberIdentity = this.#playerIdentity.get(member.entityId);
          return {
            sessionId: member.entityId,
            playerFoot: player ? { x: player.x, y: player.y } : undefined,
            identity: memberIdentity,
            checkpoint: () =>
              this.#checkpointLocation &&
              memberIdentity &&
              !memberIdentity.characterId.startsWith("development:")
                ? this.#checkpoint(member.entityId, "online")
                : Promise.resolve(true),
          };
        }),
        reserveCapacity: (reservation) =>
          placement.reservePartyCapacity({
            reservationId: reservation.reservationId,
            logicalMapId: reservation.destinationMapId,
            memberIds: reservation.memberIds,
            expiresAtMs: reservation.expiresAtMs,
          }).accepted,
        releaseCapacity: (reservationId) =>
          placement.releasePartyReservation(reservationId),
        extendCapacity: (reservationId, expiresAtMs) =>
          placement.extendPartyReservation(reservationId, expiresAtMs),
        revalidateMembers: () =>
          parties.cohesiveTravelStillAvailable(plan.members, this.roomId),
      });
      if (outcome.kind === "invalid") {
        parties.cancelTravel(plan.members.map((member) => member.memberId));
        return;
      }
      if (outcome.kind === "rejected") {
        parties.cancelTravel(plan.members.map((member) => member.memberId));
        if (outcome.code === ERROR_CODES.transitionUnavailable) {
          options.recordPartyTravelFailure?.(outcome.actionId);
        }
        client.send(SERVER_MESSAGES.transitionRejected, {
          actionId: outcome.actionId,
          code: outcome.code,
        } satisfies TransitionRejectedMessage);
        return;
      }
      if (
        outcome.admissions.some(
          (admission) =>
            this.#disconnectedSessions.has(admission.sessionId) ||
            !this.clients.some(
              (candidate) => candidate.sessionId === admission.sessionId,
            ),
        )
      ) {
        placement.releasePartyReservation(outcome.reservationId);
        parties.cancelTravel(plan.members.map((member) => member.memberId));
        client.send(SERVER_MESSAGES.transitionRejected, {
          actionId: outcome.actionId,
          code: ERROR_CODES.partyMemberUnavailable,
        } satisfies TransitionRejectedMessage);
        return;
      }
      for (const admission of outcome.admissions) {
        parties.bindTravelAdmission({
          ticket: admission.ticket,
          reservationId: outcome.reservationId,
          memberId: admission.memberId,
          logicalMapId: outcome.destinationMapId,
          expiresAtMs: admission.expiresAtMs,
        });
      }
      for (const admission of outcome.admissions) {
        const traveler = this.clients.find(
          (candidate) => candidate.sessionId === admission.sessionId,
        )!;
        traveler.send(SERVER_MESSAGES.transitionTicket, {
          actionId: outcome.actionId,
          ticket: admission.ticket,
          destinationRoomName: outcome.destinationRoomName,
          destinationMapId: outcome.destinationMapId,
          expiresAtMs: admission.expiresAtMs,
        } satisfies TransitionTicketMessage);
      }
      // Closing the connection in the same synchronous turn as the ticket
      // send can drop the still-buffered ticket, leaving that member behind
      // without feedback — the silent split AC2 forbids. One macrotask lets
      // the transport flush every ticket before any traveler is detached.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const admission of outcome.admissions) {
        const traveler = this.clients.find(
          (candidate) => candidate.sessionId === admission.sessionId,
        );
        // A member who disconnected during the flush macrotask was already
        // handled by onLeave; skipping them keeps the remaining travelers'
        // departures intact instead of aborting the loop mid-party.
        if (!traveler) continue;
        parties.departForTravel(admission.memberId);
        this.#partyDepartures.add(admission.sessionId);
        this.#removeSession(admission.sessionId);
        traveler.leave(4_000, "portal_transition");
      }
    }

    async #handleTravelToMember(
      client: Client,
      intention: { actionId: string; targetEntityId: string },
    ): Promise<void> {
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!identity) return;
      const plan = parties.beginTravelToMember(
        identity.characterId,
        intention.targetEntityId,
      );
      if (!plan.accepted) {
        client.send(SERVER_MESSAGES.partyResult, {
          accepted: false,
          actionId: intention.actionId,
          code: plan.code,
        } satisfies PartyResultMessage);
        return;
      }
      const outcome = await prepareTravelToMember({
        actionId: intention.actionId,
        plan,
        placement,
        transitionTickets,
        now: this.#now,
        canAccessMap: options.canAccessMap ?? (() => false),
        checkpoint: () =>
          this.#checkpointLocation &&
          !identity.characterId.startsWith("development:")
            ? this.#checkpoint(client.sessionId, "online")
            : Promise.resolve(true),
        revalidate: () => parties.travelToMemberStillAvailable(plan),
      });
      if (outcome.kind === "rejected") {
        parties.cancelTravel([identity.characterId]);
        if (outcome.code === ERROR_CODES.transitionUnavailable) {
          options.recordPartyTravelFailure?.(outcome.actionId);
        }
        client.send(SERVER_MESSAGES.partyResult, {
          accepted: false,
          actionId: outcome.actionId,
          code: outcome.code,
        } satisfies PartyResultMessage);
        return;
      }
      if (
        !parties.travelToMemberStillAvailable(plan) ||
        this.#disconnectedSessions.has(client.sessionId) ||
        !this.clients.some(
          (candidate) => candidate.sessionId === client.sessionId,
        )
      ) {
        placement.releasePartyReservation(outcome.reservationId);
        parties.cancelTravel([identity.characterId]);
        client.send(SERVER_MESSAGES.partyResult, {
          accepted: false,
          actionId: intention.actionId,
          code: ERROR_CODES.partyMemberUnavailable,
        } satisfies PartyResultMessage);
        return;
      }
      parties.bindTravelAdmission({
        ticket: outcome.ticket,
        reservationId: outcome.reservationId,
        memberId: outcome.memberId,
        logicalMapId: outcome.destinationMapId,
        expiresAtMs: outcome.expiresAtMs,
      });
      client.send(SERVER_MESSAGES.partyResult, {
        accepted: true,
        actionId: outcome.actionId,
      } satisfies PartyResultMessage);
      client.send(SERVER_MESSAGES.transitionTicket, {
        actionId: outcome.actionId,
        ticket: outcome.ticket,
        destinationRoomName: outcome.destinationRoomName,
        destinationMapId: outcome.destinationMapId,
        expiresAtMs: outcome.expiresAtMs,
      } satisfies TransitionTicketMessage);
      // One macrotask so the buffered ticket flushes before the connection
      // closes; see the identical wait in the cohesive portal path.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (
        !this.clients.some(
          (candidate) => candidate.sessionId === client.sessionId,
        )
      ) {
        return;
      }
      parties.departForTravel(identity.characterId);
      this.#partyDepartures.add(client.sessionId);
      this.#removeSession(client.sessionId);
      client.leave(4_000, "party_travel_to_member");
    }

    #removeSession(sessionId: string): void {
      this.#pendingIntentions.delete(sessionId);
      this.#intentionViolations.delete(sessionId);
      this.#lastProcessedSequences.delete(sessionId);
      this.#playerIdentity.delete(sessionId);
      this.#lastCheckpointAtMs.delete(sessionId);
      this.#disconnectedSessions.delete(sessionId);
      this.#discoveredMapIds.delete(sessionId);
      this.#sessionEntranceId.delete(sessionId);
      this.#portalTransitions.clearSession(sessionId);
      this.state.players.delete(sessionId);
    }

    override async onJoin(client: Client, unsafeOptions: unknown) {
      const options = joinOptionsSchema.safeParse(unsafeOptions);
      if (!options.success) {
        throw new ServerError(4_221, ERROR_CODES.invalidJoinOptions);
      }
      const consumption = await playTickets.consume(options.data.ticket);
      if (!consumption.success) {
        throw new ServerError(4_223, consumption.code);
      }
      if (consumption.admission.logicalDestination !== forestSlice.mapId) {
        throw new ServerError(4_224, ERROR_CODES.destinationNotAllowed);
      }
      if (consumption.admission.contentVersion !== forestSlice.contentVersion) {
        throw new ServerError(4_225, ERROR_CODES.staleContentVersion);
      }
      const entranceId = consumption.admission.entranceId;
      const position = resolveSpawnPosition({
        map: forestMap,
        entranceId,
        savedState: consumption.admission.characterState,
        collision: villageCharacter.collision,
      });
      if (!position) {
        throw new ServerError(4_226, ERROR_CODES.entranceNotFound);
      }

      if (options.data.partyReservationId !== undefined) {
        if (
          !parties.claimTravelAdmission(
            options.data.ticket,
            options.data.partyReservationId,
            consumption.admission.characterId,
            forestSlice.mapId,
            this.#now(),
          ) ||
          !placement.claimPartySeat(
            options.data.partyReservationId,
            forestSlice.mapId,
            consumption.admission.characterId,
            this.roomId,
          )
        ) {
          throw new ServerError(4_228, ERROR_CODES.instanceUnavailable);
        }
      }

      const player = new PublicPlayer();
      player.displayName = consumption.admission.displayName;
      player.x = position.x;
      player.y = position.y;
      // The forest is traversable-only, so it never mutates equipment; it
      // publishes the appearance and revision the character already carries
      // so clients that travelled from the village keep a consistent view.
      player.appearance.assign(
        consumption.admission.characterState?.appearance ??
          consumption.admission.appearance,
      );
      player.appearanceRevision =
        consumption.admission.characterState?.appearanceRevision ?? 0;
      this.state.players.set(client.sessionId, player);
      this.#sessionEntranceId.set(client.sessionId, entranceId);
      this.#playerIdentity.set(client.sessionId, {
        userId: consumption.admission.userId,
        characterId: consumption.admission.characterId,
        partyId: consumption.admission.partyId,
      });
      const discoveredMapIds = new Set(
        consumption.admission.characterState?.discoveries ?? [],
      );
      discoveredMapIds.add(forestSlice.mapId);
      this.#discoveredMapIds.set(client.sessionId, discoveredMapIds);
      if (
        this.#recordArrival &&
        !consumption.admission.characterId.startsWith("development:")
      ) {
        try {
          await this.#recordArrival(
            consumption.admission.characterId,
            forestSlice.mapId,
          );
        } catch {
          throw new ServerError(4_229, ERROR_CODES.databaseUnavailable);
        }
      }
      void this.#applyVisitObjective(client);
      parties.registerPresence({
        memberId: consumption.admission.characterId,
        userId: consumption.admission.userId,
        entityId: client.sessionId,
        displayName: consumption.admission.displayName,
        logicalMapId: forestSlice.mapId,
        internalRoomId: this.roomId,
        send: (messageType, payload) => client.send(messageType, payload),
      });
      this.#pendingIntentions.set(client.sessionId, new Map());
      this.#lastProcessedSequences.set(client.sessionId, 0);
      this.#intentionViolations.set(client.sessionId, 0);
      void this.#checkpoint(client.sessionId, "online");
      void this.#sendMapOverview(client);
      client.send(SERVER_MESSAGES.chatAvailability, {
        enabled: this.#mapChatEnabled,
      });
    }

    override async onLeave(client: Client) {
      // Keep the final checkpoint within Colyseus' disposal lifecycle. The
      // seat is not considered free until this hook has completed.
      await this.#checkpoint(client.sessionId, "offline");
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!this.#partyDepartures.delete(client.sessionId) && identity) {
        parties.disconnect(identity.characterId);
      }
      this.#removeSession(client.sessionId);
      options.recordLifecycle?.("removed");
    }

    override onDrop(client: Client) {
      if (!this.state.players.has(client.sessionId)) return;
      void this.#checkpoint(client.sessionId, "disconnected");
      this.#disconnectedSessions.add(client.sessionId);
      const identity = this.#playerIdentity.get(client.sessionId);
      if (identity) parties.markDisconnected(identity.characterId);
      options.recordLifecycle?.("disconnected");
      void this.allowReconnection(client, this.#reconnectGraceSeconds).catch(
        () => undefined,
      );
    }

    override onReconnect(client: Client) {
      this.#disconnectedSessions.delete(client.sessionId);
      const identity = this.#playerIdentity.get(client.sessionId);
      if (identity) parties.markReconnected(identity.characterId);
      void this.#checkpoint(client.sessionId, "online");
      options.recordLifecycle?.("reconnected");
      this.#sendAuthoritativeMovement(client);
    }

    #rejectIntention(client: Client) {
      client.send(SERVER_MESSAGES.intentionRejected, {
        code: ERROR_CODES.invalidMovementIntention,
      });
      const score = (this.#intentionViolations.get(client.sessionId) ?? 0) + 1;
      this.#intentionViolations.set(client.sessionId, score);
      if (score >= MAX_INTENTION_VIOLATIONS) {
        client.leave(4_008, ERROR_CODES.invalidMovementIntention);
      }
    }

    async #applyVisitObjective(client: Client): Promise<void> {
      const persistence = this.#questPersistence;
      const identity = this.#playerIdentity.get(client.sessionId);
      const definition = villageQuests.quests.find(
        (quest) => quest.serverOnly.objective.kind === "visit",
      );
      if (!persistence || !identity || !definition) return;
      const snapshot = await persistence.loadQuest(
        identity.characterId,
        definition.id,
      );
      if (snapshot.status !== "active") return;
      const result = await persistence.transitionQuest({
        characterId: identity.characterId,
        questId: definition.id,
        objective: definition.serverOnly.objective,
        prerequisiteQuestIds: definition.serverOnly.prerequisites,
        transition: {
          kind: "objective",
          event: {
            // Deterministic per character + target: rejoining the forest
            // replays the same Objective Event id and dedups.
            eventId: `quest-event:visit:${identity.characterId}:${definition.serverOnly.objective.targetId}`,
            kind: "visit",
            targetId: definition.serverOnly.objective.targetId,
          },
        },
      });
      if (!result.applied) return;
      client.send(
        SERVER_MESSAGES.questState,
        this.#questStateMessage(definition, result.snapshot),
      );
    }

    async #sendVisitQuestState(client: Client): Promise<void> {
      const persistence = this.#questPersistence;
      const identity = this.#playerIdentity.get(client.sessionId);
      const definition = villageQuests.quests.find(
        (quest) => quest.serverOnly.objective.kind === "visit",
      );
      if (!persistence || !identity || !definition) return;
      const snapshot = await persistence.loadQuest(
        identity.characterId,
        definition.id,
      );
      client.send(
        SERVER_MESSAGES.questState,
        this.#questStateMessage(definition, snapshot),
      );
    }

    #questStateMessage(
      definition: (typeof villageQuests)["quests"][number],
      snapshot: Awaited<ReturnType<QuestPersistence["loadQuest"]>>,
    ): QuestStateMessage {
      return {
        questId: definition.id,
        status: snapshot.status,
        progress: snapshot.progress,
        requiredCount: definition.serverOnly.objective.requiredCount,
        revision: snapshot.revision,
        objectiveKind: definition.serverOnly.objective.kind,
        title: definition.clientVisible.title,
        description: definition.clientVisible.description,
        ...(definition.clientVisible.guidance === undefined
          ? {}
          : { guidance: definition.clientVisible.guidance }),
        ...(definition.clientVisible.markers === undefined
          ? {}
          : { markers: definition.clientVisible.markers }),
      };
    }

    async #sendMapOverview(client: Client): Promise<void> {
      const identity = this.#playerIdentity.get(client.sessionId);
      if (!identity) return;
      const definition = villageQuests.quests.find(
        (quest) => quest.serverOnly.objective.kind === "visit",
      );
      const snapshot =
        this.#questPersistence && definition
          ? await this.#questPersistence.loadQuest(
              identity.characterId,
              definition.id,
            )
          : undefined;
      const questGuidance =
        definition &&
        snapshot?.status === "active" &&
        definition.clientVisible.guidance
          ? {
              logicalMapId: definition.clientVisible.guidance.targetId,
              label: definition.clientVisible.guidance.label,
            }
          : undefined;
      client.send(
        SERVER_MESSAGES.mapOverview,
        buildMapOverview({
          logicalMaps: LOGICAL_MAP_OVERVIEW_MAPS,
          isAccessible: (logicalMapId) =>
            options.canAccessMap?.(identity.characterId, logicalMapId) ??
            Boolean(LOGICAL_MAPS[logicalMapId]),
          discoveredMapIds:
            this.#discoveredMapIds.get(client.sessionId) ?? new Set(),
          currentMapId: forestSlice.mapId,
          ...(questGuidance === undefined ? {} : { questGuidance }),
        }) satisfies MapOverviewMessage,
      );
    }

    #simulateFixedStep() {
      this.state.serverTimeMs = this.#now();
      for (const [sessionId, player] of this.state.players) {
        const pending = this.#pendingIntentions.get(sessionId);
        const lastProcessedSequence =
          this.#lastProcessedSequences.get(sessionId) ?? 0;
        const nextSequence = lastProcessedSequence + 1;
        const intention = pending?.get(nextSequence);
        if (intention) {
          pending?.delete(nextSequence);
          this.#lastProcessedSequences.set(sessionId, nextSequence);
        }
        applyFootMovementStep({
          player,
          intention,
          movementLocked: false,
          map: forestMap,
          collision: villageCharacter.collision,
        });
        this.#sendAuthoritativeMovementBySessionId(sessionId);
      }
      for (const sessionId of this.state.players.keys()) {
        const lastCheckpointAtMs = this.#lastCheckpointAtMs.get(sessionId) ?? 0;
        if (this.state.serverTimeMs >= lastCheckpointAtMs + 5_000) {
          void this.#checkpoint(sessionId, "online");
        }
      }
    }

    async #checkpoint(
      sessionId: string,
      connectionState: LocationCheckpointInput["connectionState"],
    ): Promise<boolean> {
      if (!this.#checkpointLocation) return false;
      const player = this.state.players.get(sessionId);
      const identity = this.#playerIdentity.get(sessionId);
      const entranceId =
        this.#sessionEntranceId.get(sessionId) ?? forestSlice.entranceId;
      const spawn = forestMap.spawns.find(
        (candidate) => candidate.entranceId === entranceId,
      );
      if (!player || !identity || !spawn) return false;
      this.#lastCheckpointAtMs.set(sessionId, this.state.serverTimeMs);
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const checkpoint = this.#checkpointLocation({
          characterId: identity.characterId,
          logicalMapId: forestSlice.mapId,
          entranceId,
          position: { x: player.x, y: player.y },
          safeSpawn: { x: spawn.x, y: spawn.y },
          connectionState,
          now: new Date(this.state.serverTimeMs),
        });
        const bounded = new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => {
            options.recordCheckpointTimeout?.({
              logicalMapId: forestSlice.mapId,
              sessionId,
              connectionState,
              timeoutMs: this.#checkpointTimeoutMs,
            });
            resolve(false);
          }, this.#checkpointTimeoutMs);
        });
        try {
          return await Promise.race([checkpoint, bounded]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      } catch {
        return false;
      }
    }

    #sendAuthoritativeMovementBySessionId(sessionId: string) {
      const client = this.clients.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (client) this.#sendAuthoritativeMovement(client);
    }

    #sendAuthoritativeMovement(client: Client) {
      const player = this.state.players.get(client.sessionId);
      const lastProcessedSequence = this.#lastProcessedSequences.get(
        client.sessionId,
      );
      if (!player || lastProcessedSequence === undefined) return;
      const snapshot: AuthoritativeMovementSnapshot = {
        x: player.x,
        y: player.y,
        lastProcessedSequence,
        serverTimeMs: this.state.serverTimeMs,
      };
      client.send(SERVER_MESSAGES.authoritativeMovement, snapshot);
    }
  };
}
