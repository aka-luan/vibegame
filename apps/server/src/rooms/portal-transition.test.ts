import { describe, expect, it } from "vitest";

import forestMap from "@gameish/content/forest-map-server";
import villageMap from "@gameish/content/village-map-server";

import { evaluatePortalTransition } from "./portal-transition.js";

const villageGatePortal = villageMap.portals.find(
  (portal) => portal.id === "portal_forest_gate",
)!;
const villageGateFoot = {
  x: villageGatePortal.x + 1,
  y: villageGatePortal.y + 1,
};

describe("evaluatePortalTransition", () => {
  it("accepts a valid transition within range, off cooldown, to a known destination", () => {
    const result = evaluatePortalTransition({
      sourceMap: villageMap,
      portalId: "portal_forest_gate",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: villageGateFoot,
    });
    expect(result).toEqual({
      ok: true,
      destinationMapId: "map:forest",
      destinationEntranceId: "forest_edge",
      destinationRoomName: "forest",
    });
  });

  it("rejects a portal id that does not exist on this map", () => {
    const result = evaluatePortalTransition({
      sourceMap: villageMap,
      portalId: "does_not_exist",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: villageGateFoot,
    });
    expect(result).toEqual({ ok: false, code: "PORTAL_NOT_FOUND" });
  });

  it("rejects a portal id that belongs to a different (remote/foreign) map", () => {
    // "portal_village_gate" is a real portal, just not on villageMap.
    const result = evaluatePortalTransition({
      sourceMap: villageMap,
      portalId: "portal_village_gate",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: villageGateFoot,
    });
    expect(result).toEqual({ ok: false, code: "PORTAL_NOT_FOUND" });
  });

  it("rejects a player outside the proximity radius", () => {
    const result = evaluatePortalTransition({
      sourceMap: villageMap,
      portalId: "portal_forest_gate",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: { x: villageGatePortal.x - 500, y: villageGatePortal.y },
    });
    expect(result).toEqual({ ok: false, code: "PORTAL_OUT_OF_RANGE" });
  });

  it("rejects a request still inside the per-player cooldown window", () => {
    const result = evaluatePortalTransition({
      sourceMap: villageMap,
      portalId: "portal_forest_gate",
      now: 10_500,
      lastTransitionAtMs: 10_000,
      playerFoot: villageGateFoot,
    });
    expect(result).toEqual({ ok: false, code: "PORTAL_ON_COOLDOWN" });
  });

  it("accepts a repeat request once the cooldown has elapsed (replay only within window is blocked)", () => {
    const result = evaluatePortalTransition({
      sourceMap: villageMap,
      portalId: "portal_forest_gate",
      now: 12_001,
      lastTransitionAtMs: 10_000,
      playerFoot: villageGateFoot,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a locked portal", () => {
    const lockedMap = {
      ...villageMap,
      portals: villageMap.portals.map((portal) => ({
        ...portal,
        locked: true,
      })),
    };
    const result = evaluatePortalTransition({
      sourceMap: lockedMap,
      portalId: "portal_forest_gate",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: villageGateFoot,
    });
    expect(result).toEqual({ ok: false, code: "MAP_LOCKED" });
  });

  it("rejects an unknown destination map", () => {
    const brokenMap = {
      ...villageMap,
      portals: villageMap.portals.map((portal) => ({
        ...portal,
        destinationMapId: "map:atlantis",
      })),
    };
    const result = evaluatePortalTransition({
      sourceMap: brokenMap,
      portalId: "portal_forest_gate",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: villageGateFoot,
    });
    expect(result).toEqual({ ok: false, code: "DESTINATION_NOT_ALLOWED" });
  });

  it("rejects a missing destination entrance", () => {
    const brokenMap = {
      ...villageMap,
      portals: villageMap.portals.map((portal) => ({
        ...portal,
        destinationEntranceId: "does_not_exist",
      })),
    };
    const result = evaluatePortalTransition({
      sourceMap: brokenMap,
      portalId: "portal_forest_gate",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: villageGateFoot,
    });
    expect(result).toEqual({ ok: false, code: "ENTRANCE_NOT_FOUND" });
  });

  it("rejects a destination whose content version has drifted from the source", () => {
    const staleMap = { ...villageMap, contentVersion: "content:village_m1_v3" };
    const result = evaluatePortalTransition({
      sourceMap: staleMap,
      portalId: "portal_forest_gate",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: villageGateFoot,
    });
    expect(result).toEqual({ ok: false, code: "STALE_CONTENT_VERSION" });
  });

  it("evaluates the forest's return portal symmetrically", () => {
    const forestPortal = forestMap.portals.find(
      (portal) => portal.id === "portal_village_gate",
    )!;
    const result = evaluatePortalTransition({
      sourceMap: forestMap,
      portalId: "portal_village_gate",
      now: 10_000,
      lastTransitionAtMs: undefined,
      playerFoot: { x: forestPortal.x + 1, y: forestPortal.y + 1 },
    });
    expect(result).toEqual({
      ok: true,
      destinationMapId: "map:village",
      destinationEntranceId: "village_gate",
      destinationRoomName: "village",
    });
  });
});
