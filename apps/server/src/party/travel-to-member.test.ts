import type { IRoomCache } from "@colyseus/core";
import forestMap from "@gameish/content/forest-map-server";
import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "@gameish/protocol";

import { MapPlacementDriver } from "../rooms/placement.js";
import type { PartyPresence } from "./coordinator.js";
import { prepareTravelToMember } from "./travel-to-member.js";

function member(
  memberId: string,
  overrides: Partial<PartyPresence> = {},
): PartyPresence {
  return {
    memberId,
    userId: `user:${memberId}`,
    entityId: `entity:${memberId}`,
    displayName: memberId,
    logicalMapId: "map:village",
    internalRoomId: "room:village",
    send() {},
    ...overrides,
  };
}

function placementWithForestRoom(clients: number, hardCapacity = 4) {
  const placement = new MapPlacementDriver(
    {
      softPopulationTarget: 2,
      hardCapacity,
    },
    { now: () => 1_000 },
  );
  placement.rooms.push({
    roomId: "room:forest-member",
    name: "forest",
    clients,
    maxClients: hardCapacity,
    locked: false,
    private: false,
    processId: "process:test",
    createdAt: new Date(1),
    metadata: { logicalMapId: "map:forest", instanceRole: "public" },
  } as IRoomCache);
  return placement;
}

function plan() {
  return {
    accepted: true as const,
    reservationId: "party-travel:test",
    member: member("character:traveler"),
    destination: member("character:member", {
      logicalMapId: "map:forest",
      internalRoomId: "room:forest-member",
    }),
  };
}

describe("travel-to-member preparation", () => {
  it("checks map access before reserving capacity", async () => {
    const placement = placementWithForestRoom(1);
    const issue = vi.fn();

    await expect(
      prepareTravelToMember({
        actionId: "travel:locked",
        plan: plan(),
        placement,
        transitionTickets: { issue },
        now: () => 1_000,
        canAccessMap: () => false,
        checkpoint: () => Promise.resolve(true),
        revalidate: () => true,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      actionId: "travel:locked",
      code: ERROR_CODES.mapLocked,
    });
    expect(placement.reservedSeats("room:forest-member")).toBe(0);
    expect(issue).not.toHaveBeenCalled();
  });

  it("fails clearly when the member's instance has no capacity", async () => {
    const placement = placementWithForestRoom(4);

    await expect(
      prepareTravelToMember({
        actionId: "travel:full",
        plan: plan(),
        placement,
        transitionTickets: { issue: vi.fn() },
        now: () => 1_000,
        canAccessMap: () => true,
        checkpoint: () => Promise.resolve(true),
        revalidate: () => true,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      actionId: "travel:full",
      code: ERROR_CODES.instanceUnavailable,
    });
  });

  it("reserves the target instance and issues a bound logical destination ticket", async () => {
    const placement = placementWithForestRoom(2);
    const issue = vi.fn().mockResolvedValue({
      ticket: "one-time-ticket",
      expiresAtMs: 16_000,
    });

    await expect(
      prepareTravelToMember({
        actionId: "travel:member",
        plan: plan(),
        placement,
        transitionTickets: { issue },
        now: () => 1_000,
        canAccessMap: () => true,
        checkpoint: () => Promise.resolve(true),
        revalidate: () => true,
      }),
    ).resolves.toMatchObject({
      kind: "approved",
      reservationId: "party-travel:test",
      memberId: "character:traveler",
      destinationMapId: "map:forest",
      destinationRoomName: "forest",
    });
    expect(placement.reservedSeats("room:forest-member")).toBe(1);
    expect(issue).toHaveBeenCalledWith({
      userId: "user:character:traveler",
      characterId: "character:traveler",
      destinationMapId: "map:forest",
      destinationEntranceId: "forest_edge",
      contentVersion: forestMap.contentVersion,
    });
  });

  it("releases capacity and rejects safely when ticket issuance fails", async () => {
    const placement = placementWithForestRoom(2);

    await expect(
      prepareTravelToMember({
        actionId: "travel:failure",
        plan: plan(),
        placement,
        transitionTickets: {
          issue: vi.fn().mockRejectedValue(new Error("database unavailable")),
        },
        now: () => 1_000,
        canAccessMap: () => true,
        checkpoint: () => Promise.resolve(true),
        revalidate: () => true,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      actionId: "travel:failure",
      code: ERROR_CODES.transitionUnavailable,
    });
    expect(placement.reservedSeats("room:forest-member")).toBe(0);
  });

  it("keeps the reserved destination seat through a delayed ticket expiry", async () => {
    let nowMs = 1_000;
    const placement = new MapPlacementDriver(
      { softPopulationTarget: 2, hardCapacity: 4 },
      { now: () => nowMs },
    );
    placement.rooms.push({
      roomId: "room:forest-member",
      name: "forest",
      clients: 1,
      maxClients: 4,
      locked: false,
      private: false,
      processId: "process:test",
      createdAt: new Date(1),
      metadata: { logicalMapId: "map:forest", instanceRole: "public" },
    } as IRoomCache);

    await expect(
      prepareTravelToMember({
        actionId: "travel:slow",
        plan: plan(),
        placement,
        transitionTickets: {
          issue: vi.fn().mockImplementation(() => {
            nowMs = 15_000;
            return Promise.resolve({
              ticket: "one-time-ticket",
              expiresAtMs: 30_000,
            });
          }),
        },
        now: () => nowMs,
        canAccessMap: () => true,
        checkpoint: () => Promise.resolve(true),
        revalidate: () => true,
      }),
    ).resolves.toMatchObject({ kind: "approved", expiresAtMs: 30_000 });
    nowMs = 34_999;
    expect(placement.reservedSeats("room:forest-member")).toBe(1);
    nowMs = 35_000;
    expect(placement.reservedSeats("room:forest-member")).toBe(0);
  });
});
