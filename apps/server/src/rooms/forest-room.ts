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
import { applyFootMovementStep } from "./map-movement.js";
import { PortalTransitionCoordinator } from "./portal-transition-handler.js";
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
    checkpointLocation?:
      ((input: LocationCheckpointInput) => Promise<boolean>) | undefined;
    recordLifecycle?: (
      event: "disconnected" | "reconnected" | "removed",
    ) => void;
    transitionTickets?: TransitionTicketIssuer;
  } = {},
) {
  const transitionTickets: TransitionTicketIssuer =
    options.transitionTickets ?? {
      issue: () => Promise.resolve(undefined),
    };

  return class ForestRoom extends Room<{ state: ForestState }> {
    override state = new ForestState();
    readonly #pendingIntentions = new Map<
      string,
      Map<number, MovementIntention>
    >();
    readonly #intentionViolations = new Map<string, number>();
    readonly #lastProcessedSequences = new Map<string, number>();
    readonly #now = options.now ?? Date.now;
    readonly #reconnectGraceSeconds = options.reconnectGraceSeconds ?? 5;
    readonly #checkpointLocation = options.checkpointLocation;
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
      now: this.#now,
    });

    override onCreate() {
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

      this.setSimulationInterval(
        () => this.#simulateFixedStep(),
        PLAYER_MOVEMENT.fixedStepMs,
      );
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
        checkpoint: () => this.#checkpoint(client.sessionId, "online"),
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
      if (
        consumption.admission.contentVersion !== forestSlice.contentVersion
      ) {
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
      player.appearance.assign(consumption.admission.appearance);
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
    }

    override onLeave(client: Client) {
      void this.#checkpoint(client.sessionId, "offline");
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
        return await this.#checkpointLocation({
          characterId: identity.characterId,
          logicalMapId: forestSlice.mapId,
          entranceId,
          position: { x: player.x, y: player.y },
          safeSpawn: { x: spawn.x, y: spawn.y },
          connectionState,
          now: new Date(this.state.serverTimeMs),
        });
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
