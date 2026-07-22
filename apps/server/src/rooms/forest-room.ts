import { Room, ServerError, type Client } from "@colyseus/core";
import { MapSchema, Schema, type } from "@colyseus/schema";
import forestMap from "@gameish/content/forest-map-server";
import villageCharacter from "@gameish/content/village-character";
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
  type TransitionRejectedMessage,
  type TransitionTicketMessage,
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
import {
  DEFAULT_MAP_INSTANCE_HARD_CAPACITY,
  type MapRoomMetadata,
} from "./placement.js";
import { resolveSpawnPosition } from "./spawn-resolution.js";

const joinOptionsSchema = z
  .object({ ticket: z.string().min(1).max(200) })
  .strict();
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
 * The forest room: traversable-only for this issue (no combat, no
 * dialogue, no quests, no monsters — see issue #13 non-goals). Movement,
 * checkpointing, and portal transitions reuse the same shared helpers as
 * the village room so that behavior exists exactly once; only the parts
 * that are irreducibly Colyseus/room-specific (state schema, onMessage
 * wiring, per-session bookkeeping) are duplicated here.
 */
export function createForestRoom(
  playTickets: PlayTicketConsumer,
  options: {
    now?: () => number;
    reconnectGraceSeconds?: number;
    hardCapacity?: number;
    checkpointLocation?:
      ((input: LocationCheckpointInput) => Promise<boolean>) | undefined;
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
    mapChatEnabled?: boolean;
    mapChatRateLimiter?: MapChatRateLimiter;
    recordMapChat?: (details: {
      outcome: "accepted" | "rejected";
      code?: "CHAT_DISABLED" | "INVALID_CHAT_MESSAGE" | "CHAT_RATE_LIMITED";
      utf8Bytes?: number;
      lineCount?: number;
    }) => void;
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
    readonly #portalTransitions = new PortalTransitionCoordinator({
      sourceMap: forestMap,
      transitionTickets,
      cooldowns: portalCooldowns,
      now: this.#now,
    });

    override onCreate() {
      this.maxClients =
        options.hardCapacity ?? DEFAULT_MAP_INSTANCE_HARD_CAPACITY;
      this.metadata = {
        logicalMapId: forestSlice.mapId,
        instanceRole: "public",
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
          void this.#handlePortalTransition(client, unsafeIntention);
        },
      );
      this.onMessage(
        CLIENT_MESSAGES.mapChat,
        (client, unsafeIntention: unknown) => {
          this.#handleMapChat(client, unsafeIntention);
        },
      );

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
      const player = this.state.players.get(client.sessionId);
      const identity = this.#playerIdentity.get(client.sessionId);
      const outcome = await this.#portalTransitions.evaluate({
        sessionId: client.sessionId,
        unsafeIntention,
        playerFoot: player ? { x: player.x, y: player.y } : undefined,
        identity,
        // A durable character's checkpoint is what AC4 recovery reads, so a
        // configured checkpoint that fails must block the transition rather
        // than strand the character at an unknown location. A development
        // identity has no durable location row at all (same convention as
        // `#questsForCharacter`), so there is nothing to lose and the
        // transition proceeds.
        checkpoint: () =>
          this.#checkpointLocation &&
          identity &&
          !identity.characterId.startsWith("development:")
            ? this.#checkpoint(client.sessionId, "online")
            : Promise.resolve(true),
      });
      if (outcome.kind === "invalid") return;
      if (outcome.kind === "rejected") {
        client.send(SERVER_MESSAGES.transitionRejected, {
          actionId: outcome.actionId,
          code: outcome.code,
        } satisfies TransitionRejectedMessage);
        return;
      }
      client.send(SERVER_MESSAGES.transitionTicket, {
        actionId: outcome.actionId,
        ticket: outcome.ticket,
        destinationRoomName: outcome.destinationRoomName,
        destinationMapId: outcome.destinationMapId,
        expiresAtMs: outcome.expiresAtMs,
      } satisfies TransitionTicketMessage);
      this.#removeSession(client.sessionId);
      client.leave(4_000, "portal_transition");
    }

    #removeSession(sessionId: string): void {
      this.#pendingIntentions.delete(sessionId);
      this.#intentionViolations.delete(sessionId);
      this.#lastProcessedSequences.delete(sessionId);
      this.#playerIdentity.delete(sessionId);
      this.#lastCheckpointAtMs.delete(sessionId);
      this.#disconnectedSessions.delete(sessionId);
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
      this.#pendingIntentions.set(client.sessionId, new Map());
      this.#lastProcessedSequences.set(client.sessionId, 0);
      this.#intentionViolations.set(client.sessionId, 0);
      void this.#checkpoint(client.sessionId, "online");
      client.send(SERVER_MESSAGES.chatAvailability, {
        enabled: this.#mapChatEnabled,
      });
    }

    override async onLeave(client: Client) {
      // Keep the final checkpoint within Colyseus' disposal lifecycle. The
      // seat is not considered free until this hook has completed.
      await this.#checkpoint(client.sessionId, "offline");
      this.#removeSession(client.sessionId);
      options.recordLifecycle?.("removed");
    }

    override onDrop(client: Client) {
      if (!this.state.players.has(client.sessionId)) return;
      void this.#checkpoint(client.sessionId, "disconnected");
      this.#disconnectedSessions.add(client.sessionId);
      options.recordLifecycle?.("disconnected");
      void this.allowReconnection(client, this.#reconnectGraceSeconds).catch(
        () => undefined,
      );
    }

    override onReconnect(client: Client) {
      this.#disconnectedSessions.delete(client.sessionId);
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
