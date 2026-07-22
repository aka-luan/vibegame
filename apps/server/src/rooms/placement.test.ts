import { describe, expect, it } from "vitest";

import { InMemoryMapPlacement, type PlacementDecision } from "./placement.js";

interface AcceptedPlacementDecision {
  kind: "reconnect" | "party" | "existing" | "new" | "overflow";
  instance: {
    instanceId: string;
    connectedSeats: number;
    reservedSeats: number;
  };
  reservationId: string;
}

function reserveAndCommit(
  placement: InMemoryMapPlacement,
  request: Parameters<InMemoryMapPlacement["place"]>[0],
): PlacementDecision {
  const decision = placement.place(request);
  if (decision.kind !== "unavailable") placement.commit(decision.reservationId);
  return decision;
}

function accepted(decision: PlacementDecision): AcceptedPlacementDecision {
  if (decision.kind === "unavailable") {
    throw new Error(`Expected placement, received ${decision.code}`);
  }
  return decision;
}

describe("map placement matrix", () => {
  it("places an empty logical map into a new public map instance", () => {
    const placement = new InMemoryMapPlacement({
      softPopulationTarget: 2,
      hardCapacity: 3,
    });

    const decision = accepted(
      reserveAndCommit(placement, {
        logicalMapId: "map:village",
        createInstance: () => ({
          instanceId: "room:village:1",
          logicalMapId: "map:village",
          createdAtMs: 1,
        }),
      }),
    );

    expect(decision.kind).toBe("new");
    expect(decision.instance.reservedSeats).toBe(1);
    expect(placement.list()[0]?.connectedSeats).toBe(1);
  });

  it("prefers an existing instance below the soft target", () => {
    const placement = new InMemoryMapPlacement({
      softPopulationTarget: 2,
      hardCapacity: 3,
    });
    placement.registerInstance({
      instanceId: "room:village:1",
      logicalMapId: "map:village",
      createdAtMs: 1,
    });
    placement.setPopulation("room:village:1", { connectedSeats: 1 });
    const decision = accepted(
      reserveAndCommit(placement, {
        logicalMapId: "map:village",
      }),
    );

    expect(decision.kind).toBe("existing");
    expect(decision.instance.instanceId).toBe("room:village:1");
  });

  it("uses a new instance when the current one reaches the soft target", () => {
    const placement = new InMemoryMapPlacement({
      softPopulationTarget: 2,
      hardCapacity: 3,
    });
    placement.registerInstance({
      instanceId: "room:village:1",
      logicalMapId: "map:village",
      createdAtMs: 1,
    });
    placement.setPopulation("room:village:1", { connectedSeats: 2 });

    const decision = accepted(
      reserveAndCommit(placement, {
        logicalMapId: "map:village",
        createInstance: () => ({
          instanceId: "room:village:2",
          logicalMapId: "map:village",
          createdAtMs: 2,
        }),
      }),
    );

    expect(decision.kind).toBe("new");
    expect(decision.instance.instanceId).toBe("room:village:2");
  });

  it("honors reconnect and future party reservations before public placement", () => {
    const placement = new InMemoryMapPlacement({
      softPopulationTarget: 2,
      hardCapacity: 3,
    });
    placement.registerInstance({
      instanceId: "room:village:1",
      logicalMapId: "map:village",
      createdAtMs: 1,
    });
    placement.registerInstance({
      instanceId: "room:village:2",
      logicalMapId: "map:village",
      createdAtMs: 2,
    });
    placement.setPopulation("room:village:1", { connectedSeats: 2 });

    const reconnect = accepted(
      reserveAndCommit(placement, {
        logicalMapId: "map:village",
        reconnectInstanceId: "room:village:1",
      }),
    );
    expect(reconnect.kind).toBe("reconnect");
    expect(reconnect.instance.instanceId).toBe("room:village:1");

    const party = accepted(
      reserveAndCommit(placement, {
        logicalMapId: "map:village",
        partyReservation: { instanceId: "room:village:2", seats: 4 },
      }),
    );
    expect(party.kind).toBe("party");
    expect(party.instance.instanceId).toBe("room:village:2");
  });

  it("falls back to hard-capacity overflow only when no new instance is available", () => {
    const placement = new InMemoryMapPlacement({
      softPopulationTarget: 1,
      hardCapacity: 2,
    });
    placement.registerInstance({
      instanceId: "room:village:1",
      logicalMapId: "map:village",
      createdAtMs: 1,
    });
    placement.setPopulation("room:village:1", { connectedSeats: 1 });

    const decision = accepted(
      reserveAndCommit(placement, {
        logicalMapId: "map:village",
      }),
    );

    expect(decision.kind).toBe("overflow");
    expect(decision.instance.reservedSeats).toBe(1);
    expect(placement.list()[0]?.connectedSeats).toBe(2);
  });

  it("does not place into a disposing instance and removes it only after cleanup", () => {
    const placement = new InMemoryMapPlacement({
      softPopulationTarget: 2,
      hardCapacity: 2,
    });
    placement.registerInstance({
      instanceId: "room:village:1",
      logicalMapId: "map:village",
      createdAtMs: 1,
    });
    placement.setPopulation("room:village:1", { connectedSeats: 0 });
    placement.beginDisposal("room:village:1");

    const decision = placement.place({ logicalMapId: "map:village" });
    expect(decision.kind).toBe("unavailable");
    expect(placement.completeDisposal("room:village:1")).toBe(true);
    expect(placement.list()).toEqual([]);
  });
});

describe("concurrent placement reservations", () => {
  it("never reserves more seats than hard capacity", async () => {
    const placement = new InMemoryMapPlacement({
      softPopulationTarget: 4,
      hardCapacity: 4,
    });
    placement.registerInstance({
      instanceId: "room:forest:1",
      logicalMapId: "map:forest",
      createdAtMs: 1,
    });

    const decisions = await Promise.all(
      Array.from({ length: 32 }, () =>
        Promise.resolve(placement.place({ logicalMapId: "map:forest" })),
      ),
    );
    const accepted = decisions.filter(
      (
        decision,
      ): decision is Exclude<PlacementDecision, { kind: "unavailable" }> =>
        decision.kind !== "unavailable",
    );

    expect(accepted).toHaveLength(4);
    expect(placement.list()[0]?.reservedSeats).toBe(4);
    for (const decision of accepted) placement.commit(decision.reservationId);
    expect(placement.list()[0]?.connectedSeats).toBe(4);
    expect(placement.list()[0]?.reservedSeats).toBe(0);
  });

  it("releases failed reservations without creating capacity", () => {
    const placement = new InMemoryMapPlacement({
      softPopulationTarget: 1,
      hardCapacity: 1,
    });
    placement.registerInstance({
      instanceId: "room:village:1",
      logicalMapId: "map:village",
      createdAtMs: 1,
    });
    const first = placement.place({ logicalMapId: "map:village" });
    expect(first.kind).toBe("existing");
    if (first.kind === "unavailable") return;
    expect(placement.place({ logicalMapId: "map:village" }).kind).toBe(
      "unavailable",
    );
    placement.release(first.reservationId);
    expect(placement.place({ logicalMapId: "map:village" }).kind).toBe(
      "existing",
    );
  });
});
