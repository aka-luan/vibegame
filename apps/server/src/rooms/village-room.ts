import { Room, ServerError, type Client } from "@colyseus/core";
import { MapSchema, Schema, type } from "@colyseus/schema";
import villageCharacter from "@gameish/content/village-character";
import villageMap from "@gameish/content/village-map-server";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type MovementIntention,
} from "@gameish/protocol";
import { moveCharacterFoot, PLAYER_MOVEMENT } from "@gameish/world";
import { z } from "zod";

import type { DevelopmentPlayTickets } from "../development/play-tickets.js";

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
  facing = "east";

  @type("string")
  animation = "idle";

  @type(PublicAppearance)
  appearance = new PublicAppearance();
}

class VillageState extends Schema {
  @type("number")
  serverTimeMs = 0;

  @type({ map: PublicPlayer })
  players = new MapSchema<PublicPlayer>();
}

export function createVillageRoom(
  playTickets: DevelopmentPlayTickets,
  options: {
    now?: () => number;
    reconnectGraceSeconds?: number;
    recordLifecycle?: (
      event: "disconnected" | "reconnected" | "removed",
    ) => void;
  } = {},
) {
  return class VillageRoom extends Room<{ state: VillageState }> {
    override state = new VillageState();
    readonly #pendingIntentions = new Map<
      string,
      Map<number, MovementIntention>
    >();
    readonly #intentionViolations = new Map<string, number>();
    readonly #lastProcessedSequences = new Map<string, number>();
    readonly #now = options.now ?? Date.now;
    readonly #reconnectGraceSeconds = options.reconnectGraceSeconds ?? 5;

    override onCreate() {
      this.state.serverTimeMs = this.#now();
      this.maxMessagesPerSecond = 60;
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
      this.setSimulationInterval(
        () => this.#simulateFixedStep(),
        PLAYER_MOVEMENT.fixedStepMs,
      );
    }

    override onJoin(client: Client, unsafeOptions: unknown) {
      const options = joinOptionsSchema.safeParse(unsafeOptions);
      if (!options.success) {
        throw new ServerError(4_221, ERROR_CODES.invalidJoinOptions);
      }
      const consumption = playTickets.consume(options.data.ticket);
      if (!consumption.success) {
        throw new ServerError(4_223, consumption.code);
      }

      const player = new PublicPlayer();
      player.displayName = consumption.admission.displayName;
      const spawn = villageMap.spawns.find(
        (candidate) => candidate.entranceId === "village_square",
      );
      if (!spawn) throw new Error("Village player spawn is unavailable");
      player.x = spawn.x;
      player.y = spawn.y;
      player.appearance.assign(consumption.admission.appearance);
      this.state.players.set(client.sessionId, player);
      this.#pendingIntentions.set(client.sessionId, new Map());
      this.#lastProcessedSequences.set(client.sessionId, 0);
      this.#intentionViolations.set(client.sessionId, 0);
    }

    override onLeave(client: Client) {
      this.#pendingIntentions.delete(client.sessionId);
      this.#intentionViolations.delete(client.sessionId);
      this.#lastProcessedSequences.delete(client.sessionId);
      this.state.players.delete(client.sessionId);
      options.recordLifecycle?.("removed");
    }

    override onDrop(client: Client) {
      if (!this.state.players.has(client.sessionId)) return;
      options.recordLifecycle?.("disconnected");
      void this.allowReconnection(client, this.#reconnectGraceSeconds).catch(
        () => undefined,
      );
    }

    override onReconnect(client: Client) {
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
        if (!intention) {
          player.animation = "idle";
          continue;
        }
        pending?.delete(nextSequence);
        this.#lastProcessedSequences.set(sessionId, nextSequence);
        const isMoving = intention.x !== 0 || intention.y !== 0;
        player.animation = isMoving ? "walk" : "idle";
        if (!isMoving) {
          this.#sendAuthoritativeMovementBySessionId(sessionId);
          continue;
        }

        if (intention.x < 0) player.facing = "west";
        else if (intention.x > 0) player.facing = "east";

        const moved = moveCharacterFoot({
          footPosition: player,
          direction: intention,
          speed: PLAYER_MOVEMENT.speed,
          elapsedMs: PLAYER_MOVEMENT.fixedStepMs,
          collision: villageCharacter.collision,
          world: {
            bounds: villageMap.bounds,
            obstacles: villageMap.collision,
          },
        });
        player.x = moved.x;
        player.y = moved.y;
        this.#sendAuthoritativeMovementBySessionId(sessionId);
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
