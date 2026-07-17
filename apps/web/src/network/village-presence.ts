import { Client, type Room } from "@colyseus/sdk";
import { z } from "zod";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  ROOM_NAMES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type CombatResult,
  type ErrorCode,
  type MovementIntention,
  type PublicMonsterPresence,
  type PublicPlayerPresence,
} from "@gameish/protocol";

const errorCodeSchema = z.enum(
  Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]],
);
const authoritativeMovementSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    lastProcessedSequence: z.number().int().nonnegative(),
    serverTimeMs: z.number().finite(),
  })
  .strict();
const targetSelectedSchema = z
  .object({ targetEntityId: z.string().min(1).max(80) })
  .strict();
const combatResultSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      accepted: z.literal(true),
      actionId: z.string(),
      targetEntityId: z.string(),
      damage: z.number().nonnegative(),
      remainingResource: z.number().nonnegative(),
      cooldownEndsAtMs: z.number().finite(),
      defeated: z.boolean(),
    })
    .strict(),
  z
    .object({
      accepted: z.literal(false),
      actionId: z.string(),
      code: errorCodeSchema,
    })
    .strict(),
]);
const combatEventSchema = z
  .object({
    kind: z.enum([
      "spawned",
      "aggro",
      "hit",
      "defeated",
      "respawned",
      "attack",
    ]),
    entityId: z.string(),
    healthFraction: z.number().min(0).max(1).optional(),
  })
  .strict();

type SynchronizedPlayer = Omit<PublicPlayerPresence, "entityId">;

interface VillageRoomState {
  serverTimeMs: number;
  players?: {
    forEach(
      callback: (player: SynchronizedPlayer, entityId: string) => void,
    ): void;
  };
  monsters?: {
    forEach(
      callback: (
        monster: Omit<PublicMonsterPresence, "entityId">,
        entityId: string,
      ) => void,
    ): void;
  };
}

export interface VillagePresenceSnapshot {
  localEntityId: string;
  serverTimeMs: number;
  connectionStatus: "connected" | "reconnecting" | "disconnected";
  localMovement: AuthoritativeMovementSnapshot | undefined;
  players: readonly PublicPlayerPresence[];
  monsters: readonly PublicMonsterPresence[];
  selectedTargetEntityId: string | null;
  combatResult: CombatResult | undefined;
}

export interface VillagePresence {
  readonly developmentRoomId: string;
  readonly simulatedLatencyMs: number;
  sendMovement(intention: MovementIntention): void;
  selectTarget(targetEntityId: string): void;
  basicAttack(): void;
  setSimulatedLatency(latencyMs: number): void;
  subscribe(listener: (snapshot: VillagePresenceSnapshot) => void): () => void;
  close(): Promise<void>;
}

export async function connectDevelopmentVillage(
  displayName: string,
  options: { simulatedLatencyMs?: number } = {},
): Promise<VillagePresence> {
  const response = await fetch("/development/play-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) throw new Error("Development admission is unavailable");
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string") {
    throw new Error("Development admission returned an invalid ticket");
  }

  const room: Room<unknown, VillageRoomState> = await new Client(
    window.location.origin,
  ).joinOrCreate(ROOM_NAMES.village, { ticket: body.ticket });
  const listeners = new Set<(snapshot: VillagePresenceSnapshot) => void>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let simulatedLatencyMs = options.simulatedLatencyMs ?? 0;
  let connectionStatus: VillagePresenceSnapshot["connectionStatus"] =
    "connected";
  let localMovement: AuthoritativeMovementSnapshot | undefined;
  let selectedTargetEntityId: string | null = null;
  let combatResult: CombatResult | undefined;

  room.reconnection.minUptime = 0;
  room.reconnection.minDelay = 100;
  room.reconnection.delay = 100;
  room.reconnection.maxDelay = 500;
  room.reconnection.maxRetries = 10;
  room.reconnection.maxEnqueuedMessages = 120;

  const afterNetworkDelay = (callback: () => void) => {
    const delayMs = simulatedLatencyMs / 2;
    if (delayMs === 0) {
      callback();
      return;
    }
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      callback();
    }, delayMs);
    pendingTimers.add(timer);
  };

  const publish = (state: VillageRoomState) => {
    const players: PublicPlayerPresence[] = [];
    state.players?.forEach((player, entityId) => {
      players.push({
        entityId,
        displayName: player.displayName,
        x: player.x,
        y: player.y,
        facing: player.facing,
        animation: player.animation,
        appearance: {
          rigId: player.appearance.rigId,
          baseLayerId: player.appearance.baseLayerId,
          armorLayerId: player.appearance.armorLayerId,
        },
      });
    });
    const monsters: PublicMonsterPresence[] = [];
    state.monsters?.forEach((monster, entityId) => {
      monsters.push({
        entityId,
        displayName: monster.displayName,
        x: monster.x,
        y: monster.y,
        animation: monster.animation,
        healthFraction: monster.healthFraction,
      });
    });
    const snapshot: VillagePresenceSnapshot = {
      localEntityId: room.sessionId,
      serverTimeMs: state.serverTimeMs,
      connectionStatus,
      localMovement,
      players,
      monsters,
      selectedTargetEntityId,
      combatResult,
    };
    afterNetworkDelay(() => {
      for (const listener of listeners) listener(snapshot);
    });
  };
  room.onStateChange(publish);
  room.onMessage<unknown>(
    SERVER_MESSAGES.authoritativeMovement,
    (unsafeSnapshot) => {
      const snapshot = authoritativeMovementSchema.safeParse(unsafeSnapshot);
      if (!snapshot.success) return;
      localMovement = snapshot.data;
      publish(room.state);
    },
  );
  room.onMessage<unknown>(SERVER_MESSAGES.targetSelected, (unsafeSelection) => {
    const selection = targetSelectedSchema.safeParse(unsafeSelection);
    if (!selection.success) return;
    selectedTargetEntityId = selection.data.targetEntityId;
    publish(room.state);
  });
  room.onMessage<unknown>(SERVER_MESSAGES.combatResult, (unsafeResult) => {
    const result = combatResultSchema.safeParse(unsafeResult);
    if (!result.success) return;
    combatResult = result.data;
    publish(room.state);
  });
  room.onMessage<unknown>(SERVER_MESSAGES.combatRejected, (unsafeRejection) => {
    const rejection = z
      .object({ code: errorCodeSchema })
      .strict()
      .safeParse(unsafeRejection);
    if (!rejection.success) return;
    combatResult = {
      accepted: false,
      actionId: "target-selection",
      code: rejection.data.code,
    };
    publish(room.state);
  });
  room.onMessage<unknown>(SERVER_MESSAGES.combatEvent, (unsafeEvent) => {
    if (!combatEventSchema.safeParse(unsafeEvent).success) return;
    publish(room.state);
  });
  room.onDrop(() => {
    connectionStatus = "reconnecting";
    publish(room.state);
  });
  room.onReconnect(() => {
    connectionStatus = "connected";
    publish(room.state);
  });
  room.onLeave(() => {
    connectionStatus = "disconnected";
    publish(room.state);
  });

  return {
    developmentRoomId: room.roomId,
    get simulatedLatencyMs() {
      return simulatedLatencyMs;
    },
    sendMovement(intention) {
      afterNetworkDelay(() => room.send(CLIENT_MESSAGES.movement, intention));
    },
    selectTarget(targetEntityId) {
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.targetSelection, { targetEntityId }),
      );
    },
    basicAttack() {
      if (!selectedTargetEntityId) return;
      const targetEntityId = selectedTargetEntityId;
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.basicAttack, {
          actionId: crypto.randomUUID(),
          targetEntityId,
        }),
      );
    },
    setSimulatedLatency(latencyMs) {
      simulatedLatencyMs = Math.max(0, Math.min(500, latencyMs));
    },
    subscribe(listener) {
      listeners.add(listener);
      publish(room.state);
      return () => listeners.delete(listener);
    },
    async close() {
      room.onStateChange.remove(publish);
      listeners.clear();
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      await room.leave();
    },
  };
}
