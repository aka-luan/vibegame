import { Client, type Room } from "@colyseus/sdk";
import {
  CLIENT_MESSAGES,
  ROOM_NAMES,
  type MovementIntention,
  type PublicPlayerPresence,
} from "@gameish/protocol";

type SynchronizedPlayer = Omit<PublicPlayerPresence, "entityId">;

interface VillageRoomState {
  players: {
    forEach(
      callback: (player: SynchronizedPlayer, entityId: string) => void,
    ): void;
  };
}

export interface VillagePresenceSnapshot {
  localEntityId: string;
  players: readonly PublicPlayerPresence[];
}

export interface VillagePresence {
  readonly developmentRoomId: string;
  sendMovement(intention: MovementIntention): void;
  subscribe(listener: (snapshot: VillagePresenceSnapshot) => void): () => void;
  close(): Promise<void>;
}

export async function connectDevelopmentVillage(
  displayName: string,
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
    const snapshot = { localEntityId: room.sessionId, players };
    for (const listener of listeners) listener(snapshot);
  };
  room.onStateChange(publish);

  return {
    developmentRoomId: room.roomId,
    sendMovement(intention) {
      room.send(CLIENT_MESSAGES.movement, intention);
    },
    subscribe(listener) {
      listeners.add(listener);
      publish(room.state);
      return () => listeners.delete(listener);
    },
    async close() {
      room.onStateChange.remove(publish);
      listeners.clear();
      await room.leave();
    },
  };
}
