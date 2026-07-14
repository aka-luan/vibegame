import { Room, ServerError, type Client } from "@colyseus/core";
import { MapSchema, Schema, type } from "@colyseus/schema";
import villageCharacter from "@gameish/content/village-character";
import villageMap from "@gameish/content/village-map-server";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  SERVER_MESSAGES,
  type MovementIntention,
} from "@gameish/protocol";
import { moveBody } from "@gameish/world";
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

const FIXED_STEP_MS = 50;
const MOVEMENT_SPEED = 92;
const MAX_MOVEMENT_MESSAGE_BYTES = 256;
const MAX_INTENTION_VIOLATIONS = 5;

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
  facing = "south";

  @type("string")
  animation = "idle";

  @type(PublicAppearance)
  appearance = new PublicAppearance();
}

class VillageState extends Schema {
  @type({ map: PublicPlayer })
  players = new MapSchema<PublicPlayer>();
}

export function createVillageRoom(playTickets: DevelopmentPlayTickets) {
  return class VillageRoom extends Room<{ state: VillageState }> {
    override state = new VillageState();
    readonly #intentions = new Map<string, MovementIntention>();
    readonly #intentionViolations = new Map<string, number>();

    override onCreate() {
      this.maxMessagesPerSecond = 60;
      this.onMessage(
        CLIENT_MESSAGES.movement,
        (client, unsafeIntention: unknown) => {
          const encodedIntention = JSON.stringify(unsafeIntention);
          const intention = movementIntentionSchema.safeParse(unsafeIntention);
          const previous = this.#intentions.get(client.sessionId);
          if (
            encodedIntention === undefined ||
            Buffer.byteLength(encodedIntention) > MAX_MOVEMENT_MESSAGE_BYTES ||
            !intention.success ||
            (previous !== undefined &&
              intention.data.sequence <= previous.sequence)
          ) {
            this.#rejectIntention(client);
            return;
          }
          this.#intentions.set(client.sessionId, intention.data);
        },
      );
      this.setSimulationInterval(
        () => this.#simulateFixedStep(),
        FIXED_STEP_MS,
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
      this.#intentions.set(client.sessionId, { x: 0, y: 0, sequence: -1 });
      this.#intentionViolations.set(client.sessionId, 0);
    }

    override onLeave(client: Client) {
      this.#intentions.delete(client.sessionId);
      this.#intentionViolations.delete(client.sessionId);
      this.state.players.delete(client.sessionId);
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
      for (const [sessionId, player] of this.state.players) {
        const intention = this.#intentions.get(sessionId);
        if (!intention) continue;
        const isMoving = intention.x !== 0 || intention.y !== 0;
        player.animation = isMoving ? "walk" : "idle";
        if (!isMoving) continue;

        if (intention.y < 0) player.facing = "north";
        else if (intention.y > 0) player.facing = "south";
        else if (intention.x < 0) player.facing = "west";
        else player.facing = "east";

        const bodyPosition = {
          x: player.x + villageCharacter.collision.offsetX,
          y: player.y + villageCharacter.collision.offsetY,
        };
        const moved = moveBody({
          position: bodyPosition,
          direction: intention,
          speed: MOVEMENT_SPEED,
          elapsedMs: FIXED_STEP_MS,
          body: {
            width: villageCharacter.collision.width,
            height: villageCharacter.collision.height,
          },
          world: {
            bounds: villageMap.bounds,
            obstacles: villageMap.collision,
          },
        });
        player.x = moved.x - villageCharacter.collision.offsetX;
        player.y = moved.y - villageCharacter.collision.offsetY;
      }
    }
  };
}
