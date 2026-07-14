import { Client, type Room } from "@colyseus/sdk";
import {
  CLIENT_MESSAGES,
  ROOM_NAMES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type MovementIntention,
  type PublicPlayerPresence,
} from "@gameish/protocol";

type SynchronizedPlayer = Omit<PublicPlayerPresence, "entityId">;

interface VillageRoomState {
  serverTimeMs: number;
  players: {
    forEach(
      callback: (player: SynchronizedPlayer, entityId: string) => void,
    ): void;
  };
}

export interface VillagePresenceSnapshot {
  localEntityId: string;
  serverTimeMs: number;
  connectionStatus: "connected" | "reconnecting" | "disconnected";
  localMovement: AuthoritativeMovementSnapshot | undefined;
  players: readonly PublicPlayerPresence[];
}

export interface VillagePresence {
  readonly developmentRoomId: string;
  readonly simulatedLatencyMs: number;
  sendMovement(intention: MovementIntention): void;
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
    state.players.forEach((player, entityId) => {
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
    const snapshot: VillagePresenceSnapshot = {
      localEntityId: room.sessionId,
      serverTimeMs: state.serverTimeMs,
      connectionStatus,
      localMovement,
      players,
    };
    afterNetworkDelay(() => {
      for (const listener of listeners) listener(snapshot);
    });
  };
  room.onStateChange(publish);
  room.onMessage<AuthoritativeMovementSnapshot>(
    SERVER_MESSAGES.authoritativeMovement,
    (snapshot) => {
      localMovement = snapshot;
      publish(room.state);
    },
  );
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
