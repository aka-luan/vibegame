import { describe, expect, it } from "vitest";

import {
  MapPlacementDriver,
  selectPartyMapInstance,
  selectMapInstance,
  type MapInstanceCandidate,
  type MapPlacementConfig,
} from "./placement.js";
import type { IRoomCache } from "@colyseus/core";

const config: MapPlacementConfig = {
  softPopulationTarget: 2,
  hardCapacity: 4,
};

function candidate(
  overrides: Partial<MapInstanceCandidate> = {},
): MapInstanceCandidate {
  return {
    roomId: "room:village:1",
    clients: 0,
    maxClients: config.hardCapacity,
    locked: false,
    instanceRole: "public",
    logicalMapId: "map:village",
    createdAt: 1,
    ...overrides,
  };
}

function cachedRoom(overrides: Partial<MapInstanceCandidate> = {}): IRoomCache {
  const value = candidate(overrides);
  return {
    roomId: value.roomId,
    name: value.logicalMapId === "map:forest" ? "forest" : "village",
    clients: value.clients,
    maxClients: value.maxClients,
    locked: value.locked,
    private: false,
    processId: "process:test",
    createdAt: new Date(value.createdAt),
    metadata: {
      logicalMapId: value.logicalMapId,
      instanceRole: value.instanceRole,
      ...(value.partyReservationId === undefined
        ? {}
        : { partyReservationId: value.partyReservationId }),
    },
  } as IRoomCache;
}

describe("map placement matrix", () => {
  it("creates a new public instance when there are no candidates", () => {
    expect(selectMapInstance([], "map:village", config)).toBeUndefined();
  });

  it("selects an instance below the soft population target", () => {
    expect(
      selectMapInstance(
        [candidate({ roomId: "room:village:1", clients: 1 })],
        "map:village",
        config,
      ),
    ).toBe("room:village:1");
  });

  it("creates a new instance when every candidate reaches the soft target", () => {
    expect(
      selectMapInstance(
        [candidate({ roomId: "room:village:1", clients: 2 })],
        "map:village",
        config,
      ),
    ).toBeUndefined();
  });

  it("uses an over-target instance as overflow while it remains below hard capacity", () => {
    expect(
      selectMapInstance(
        [candidate({ roomId: "room:village:1", clients: 3 })],
        "map:village",
        config,
      ),
    ).toBe("room:village:1");
  });

  it("excludes locked, full, disposing, non-public, and wrong-map candidates", () => {
    expect(
      selectMapInstance(
        [
          candidate({ roomId: "room:locked", locked: true }),
          candidate({ roomId: "room:full", clients: 4 }),
          candidate({
            roomId: "room:capacity-limited",
            clients: 2,
            maxClients: 2,
          }),
          candidate({ roomId: "room:disposing", locked: true }),
          candidate({ roomId: "room:private", instanceRole: "private" }),
          candidate({ roomId: "room:forest", logicalMapId: "map:forest" }),
          candidate({ roomId: "room:village:valid", clients: 1 }),
        ],
        "map:village",
        config,
      ),
    ).toBe("room:village:valid");
  });

  it("breaks ties by fewest clients and then oldest creation time", () => {
    expect(
      selectMapInstance(
        [
          candidate({
            roomId: "room:more-populated",
            clients: 1,
            createdAt: 1,
          }),
          candidate({
            roomId: "room:less-populated",
            clients: 0,
            createdAt: 100,
          }),
        ],
        "map:village",
        config,
      ),
    ).toBe("room:less-populated");
    expect(
      selectMapInstance(
        [
          candidate({ roomId: "room:newer", clients: 1, createdAt: 2 }),
          candidate({ roomId: "room:older", clients: 1, createdAt: 1 }),
        ],
        "map:village",
        config,
      ),
    ).toBe("room:older");
  });
});

describe("whole-party placement reservations", () => {
  it("selects one instance only when every required seat fits", () => {
    const candidates = [
      candidate({ roomId: "room:nearly-full", clients: 3 }),
      candidate({ roomId: "room:together", clients: 1 }),
    ];

    expect(
      selectPartyMapInstance(candidates, "map:village", 3, config, new Map()),
    ).toBe("room:together");
    expect(
      selectPartyMapInstance(candidates, "map:village", 4, config, new Map()),
    ).toBeUndefined();
  });

  it("chooses a new public instance before an over-target instance", () => {
    expect(
      selectPartyMapInstance(
        [candidate({ roomId: "room:overflow", clients: 3 })],
        "map:village",
        1,
        config,
        new Map(),
      ),
    ).toBeUndefined();
  });

  it("reserves all seats together or leaves capacity unchanged", () => {
    let nowMs = 1_000;
    const driver = new MapPlacementDriver(config, { now: () => nowMs });
    driver.rooms.push(
      cachedRoom({ roomId: "room:forest:1", logicalMapId: "map:forest" }),
    );

    expect(
      driver.reservePartyCapacity({
        reservationId: "party-travel:one",
        logicalMapId: "map:forest",
        memberIds: ["character:a", "character:b", "character:c"],
        expiresAtMs: 2_000,
      }),
    ).toEqual({
      accepted: true,
      reservationId: "party-travel:one",
      roomId: "room:forest:1",
    });
    expect(driver.reservedSeats("room:forest:1")).toBe(3);

    expect(
      driver.reservePartyCapacity({
        reservationId: "party-travel:two",
        logicalMapId: "map:forest",
        memberIds: ["character:d", "character:e"],
        preferredRoomId: "room:forest:1",
        expiresAtMs: 2_000,
      }),
    ).toEqual({ accepted: false, code: "INSTANCE_UNAVAILABLE" });
    expect(driver.reservedSeats("room:forest:1")).toBe(3);

    nowMs = 2_000;
    expect(driver.reservedSeats("room:forest:1")).toBe(0);
  });

  it("does not let a normal join consume promised party seats", async () => {
    const driver = new MapPlacementDriver(config);
    driver.rooms.push(
      cachedRoom({
        roomId: "room:reserved",
        clients: 1,
        logicalMapId: "map:forest",
      }),
    );
    expect(
      driver.reservePartyCapacity({
        reservationId: "party-travel:reserved",
        logicalMapId: "map:forest",
        memberIds: ["character:a", "character:b", "character:c"],
        expiresAtMs: Date.now() + 10_000,
      }),
    ).toMatchObject({ accepted: true, roomId: "room:reserved" });

    await expect(
      driver.findOne({ name: "forest", locked: false, private: false }),
    ).resolves.toBeUndefined();
    expect(driver.reservedSeats("room:reserved")).toBe(3);
  });

  it("returns a timed-out reserved instance to normal placement", async () => {
    let nowMs = 1_000;
    const driver = new MapPlacementDriver(config, { now: () => nowMs });
    expect(
      driver.reservePartyCapacity({
        reservationId: "party-travel:new-room",
        logicalMapId: "map:forest",
        memberIds: ["character:a", "character:b"],
        expiresAtMs: 2_000,
      }),
    ).toMatchObject({ accepted: true, roomId: undefined });
    const room = cachedRoom({
      roomId: "room:new-party",
      logicalMapId: "map:forest",
      partyReservationId: "party-travel:new-room",
    });
    driver.persist(room, true);

    nowMs = 2_000;
    await expect(
      driver.findOne({ name: "forest", locked: false, private: false }),
    ).resolves.toMatchObject({ roomId: "room:new-party" });
    expect(room.metadata).not.toHaveProperty("partyReservationId");
  });

  it("extends every promised seat through the issued ticket lifetime", () => {
    let nowMs = 1_000;
    const driver = new MapPlacementDriver(config, { now: () => nowMs });
    driver.rooms.push(
      cachedRoom({ roomId: "room:forest:1", logicalMapId: "map:forest" }),
    );
    expect(
      driver.reservePartyCapacity({
        reservationId: "party-travel:slow",
        logicalMapId: "map:forest",
        memberIds: ["character:a", "character:b"],
        expiresAtMs: 16_000,
      }).accepted,
    ).toBe(true);

    nowMs = 15_000;
    expect(driver.extendPartyReservation("party-travel:slow", 30_000)).toBe(
      true,
    );
    nowMs = 20_000;
    expect(driver.reservedSeats("room:forest:1")).toBe(2);
    nowMs = 30_000;
    expect(driver.reservedSeats("room:forest:1")).toBe(0);
  });

  it("prioritizes a party member's destination and rejects capacity loss", () => {
    const driver = new MapPlacementDriver(config);
    driver.rooms.push(
      cachedRoom({
        roomId: "room:member",
        clients: 2,
        logicalMapId: "map:forest",
      }),
    );

    expect(
      driver.reservePartyCapacity({
        reservationId: "party-travel:member",
        logicalMapId: "map:forest",
        memberIds: ["character:traveler"],
        preferredRoomId: "room:member",
        expiresAtMs: Date.now() + 10_000,
      }),
    ).toMatchObject({ accepted: true, roomId: "room:member" });

    driver.rooms[0]!.clients = 4;
    expect(
      driver.reservePartyCapacity({
        reservationId: "party-travel:late",
        logicalMapId: "map:forest",
        memberIds: ["character:late"],
        preferredRoomId: "room:member",
        expiresAtMs: Date.now() + 10_000,
      }),
    ).toEqual({ accepted: false, code: "INSTANCE_UNAVAILABLE" });
  });
});
