import villageMap from "@gameish/content/village-map-server";
import { ERROR_CODES } from "@gameish/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  PortalCooldownRegistry,
  PortalTransitionCoordinator,
} from "./portal-transition-handler.js";

describe("cohesive portal transition", () => {
  it("reserves all party seats before issuing every member ticket", async () => {
    const order: string[] = [];
    const coordinator = new PortalTransitionCoordinator({
      sourceMap: villageMap,
      cooldowns: new PortalCooldownRegistry(),
      now: () => 1_000,
      transitionTickets: {
        issue: vi.fn(({ characterId }) => {
          order.push(`ticket:${characterId}`);
          return Promise.resolve({
            ticket: `ticket:${characterId}`,
            expiresAtMs: 16_000,
          });
        }),
      },
    });
    const reserveCapacity = vi.fn(() => {
      order.push("reserve:3");
      return true;
    });

    const outcome = await coordinator.evaluateCohesive({
      initiatorSessionId: "entity:one",
      unsafeIntention: {
        actionId: "party-portal",
        portalId: "portal_forest_gate",
      },
      reservationId: "party-travel:test",
      members: ["one", "two", "three"].map((id) => ({
        sessionId: `entity:${id}`,
        playerFoot: { x: 1476, y: 328 },
        identity: { userId: `user:${id}`, characterId: `character:${id}` },
        checkpoint: () => {
          order.push(`checkpoint:${id}`);
          return Promise.resolve(true);
        },
      })),
      reserveCapacity,
      releaseCapacity: vi.fn(),
      extendCapacity: vi.fn(() => true),
      revalidateMembers: () => true,
    });

    expect(outcome).toMatchObject({
      kind: "approved",
      reservationId: "party-travel:test",
      destinationMapId: "map:forest",
    });
    expect(outcome.kind === "approved" ? outcome.admissions : []).toHaveLength(
      3,
    );
    expect(reserveCapacity).toHaveBeenCalledWith({
      reservationId: "party-travel:test",
      destinationMapId: "map:forest",
      memberIds: ["character:one", "character:two", "character:three"],
      expiresAtMs: 16_000,
    });
    expect(order[0]).toBe("reserve:3");
    expect(
      order.slice(1, 4).every((entry) => entry.startsWith("checkpoint:")),
    ).toBe(true);
  });

  it("issues no tickets when whole-party capacity is lost", async () => {
    const issue = vi.fn();
    const coordinator = new PortalTransitionCoordinator({
      sourceMap: villageMap,
      cooldowns: new PortalCooldownRegistry(),
      now: () => 1_000,
      transitionTickets: { issue },
    });

    await expect(
      coordinator.evaluateCohesive({
        initiatorSessionId: "entity:leader",
        unsafeIntention: {
          actionId: "party-portal-full",
          portalId: "portal_forest_gate",
        },
        reservationId: "party-travel:full",
        members: [
          {
            sessionId: "entity:leader",
            playerFoot: { x: 1476, y: 328 },
            identity: {
              userId: "user:leader",
              characterId: "character:leader",
            },
            checkpoint: () => Promise.resolve(true),
          },
        ],
        reserveCapacity: () => false,
        releaseCapacity: vi.fn(),
        extendCapacity: vi.fn(() => true),
        revalidateMembers: () => true,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      actionId: "party-portal-full",
      code: "INSTANCE_UNAVAILABLE",
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it("releases the reservation and rejects safely when ticket issuance fails", async () => {
    const releaseCapacity = vi.fn();
    const coordinator = new PortalTransitionCoordinator({
      sourceMap: villageMap,
      cooldowns: new PortalCooldownRegistry(),
      now: () => 1_000,
      transitionTickets: {
        issue: vi.fn().mockRejectedValue(new Error("database unavailable")),
      },
    });

    await expect(
      coordinator.evaluateCohesive({
        initiatorSessionId: "entity:leader",
        unsafeIntention: {
          actionId: "party-portal-failure",
          portalId: "portal_forest_gate",
        },
        reservationId: "party-travel:failure",
        members: [
          {
            sessionId: "entity:leader",
            playerFoot: { x: 1476, y: 328 },
            identity: {
              userId: "user:leader",
              characterId: "character:leader",
            },
            checkpoint: () => Promise.resolve(true),
          },
        ],
        reserveCapacity: () => true,
        releaseCapacity,
        extendCapacity: vi.fn(() => true),
        revalidateMembers: () => true,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      actionId: "party-portal-failure",
      code: ERROR_CODES.transitionUnavailable,
    });
    expect(releaseCapacity).toHaveBeenCalledWith("party-travel:failure");
  });

  it("revalidates party availability before issuing any tickets", async () => {
    const issue = vi.fn();
    const releaseCapacity = vi.fn();
    const coordinator = new PortalTransitionCoordinator({
      sourceMap: villageMap,
      cooldowns: new PortalCooldownRegistry(),
      now: () => 1_000,
      transitionTickets: { issue },
    });

    await expect(
      coordinator.evaluateCohesive({
        initiatorSessionId: "entity:leader",
        unsafeIntention: {
          actionId: "party-portal-disconnect",
          portalId: "portal_forest_gate",
        },
        reservationId: "party-travel:disconnect",
        members: [
          {
            sessionId: "entity:leader",
            playerFoot: { x: 1476, y: 328 },
            identity: {
              userId: "user:leader",
              characterId: "character:leader",
            },
            checkpoint: () => Promise.resolve(true),
          },
        ],
        reserveCapacity: () => true,
        releaseCapacity,
        extendCapacity: vi.fn(() => true),
        revalidateMembers: () => false,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      actionId: "party-portal-disconnect",
      code: ERROR_CODES.partyMemberUnavailable,
    });
    expect(issue).not.toHaveBeenCalled();
    expect(releaseCapacity).toHaveBeenCalledWith("party-travel:disconnect");
  });

  it("extends the reservation to cover tickets issued after a slow checkpoint", async () => {
    let nowMs = 1_000;
    const extendCapacity = vi.fn(() => true);
    const coordinator = new PortalTransitionCoordinator({
      sourceMap: villageMap,
      cooldowns: new PortalCooldownRegistry(),
      now: () => nowMs,
      transitionTickets: {
        issue: vi.fn().mockImplementation(() => {
          nowMs = 15_000;
          return Promise.resolve({ ticket: "ticket", expiresAtMs: 30_000 });
        }),
      },
    });

    await expect(
      coordinator.evaluateCohesive({
        initiatorSessionId: "entity:leader",
        unsafeIntention: {
          actionId: "party-portal-slow",
          portalId: "portal_forest_gate",
        },
        reservationId: "party-travel:slow",
        members: [
          {
            sessionId: "entity:leader",
            playerFoot: { x: 1476, y: 328 },
            identity: {
              userId: "user:leader",
              characterId: "character:leader",
            },
            checkpoint: () => Promise.resolve(true),
          },
        ],
        reserveCapacity: () => true,
        releaseCapacity: vi.fn(),
        extendCapacity,
        revalidateMembers: () => true,
      }),
    ).resolves.toMatchObject({ kind: "approved" });
    expect(extendCapacity).toHaveBeenCalledWith("party-travel:slow", 35_000);
  });
});
