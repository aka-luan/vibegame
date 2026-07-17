import { Client, type Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startFoundationServer,
  type RunningFoundationServer,
} from "../apps/server/src/server.js";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  ROOM_NAMES,
  SERVER_MESSAGES,
  type CombatResult,
} from "../packages/protocol/src/index.js";

let runningServer: RunningFoundationServer | undefined;
const joinedRooms: Room[] = [];

afterEach(async () => {
  await Promise.all(joinedRooms.splice(0).map((room) => room.leave()));
  await runningServer?.close();
  runningServer = undefined;
});

async function startDevelopmentServer() {
  runningServer = await startFoundationServer({
    host: "127.0.0.1",
    port: 0,
    logger: false,
    readinessProbe: { check: () => Promise.resolve() },
    developmentLoginEnabled: true,
    runtimeEnvironment: "test",
  });
  return `http://127.0.0.1:${String(runningServer.port)}`;
}

async function joinVillage(endpoint: string, displayName: string) {
  const response = await fetch(`${endpoint}/development/play-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { ticket: string };
  const room = await new Client(endpoint).joinOrCreate(ROOM_NAMES.village, {
    ticket: body.ticket,
  });
  joinedRooms.push(room);
  return room;
}

function monsterId(room: Room): string {
  const state = JSON.parse(JSON.stringify(room.state)) as {
    monsters: Record<string, unknown>;
  };
  const id = Object.keys(state.monsters)[0];
  if (!id) throw new Error("Monster did not spawn");
  return id;
}

describe("authoritative combat room boundary", () => {
  it("rejects forged outcomes and keeps action results private", async () => {
    const endpoint = await startDevelopmentServer();
    const attacker = await joinVillage(endpoint, "Combat Ranger");
    const observer = await joinVillage(endpoint, "Watching Ranger");
    const targetEntityId = monsterId(attacker);
    const attackerResults: CombatResult[] = [];
    const observerResults: CombatResult[] = [];
    const rejections: string[] = [];
    const publicEvents: unknown[] = [];
    attacker.onMessage<CombatResult>(SERVER_MESSAGES.combatResult, (result) =>
      attackerResults.push(result),
    );
    observer.onMessage<CombatResult>(SERVER_MESSAGES.combatResult, (result) =>
      observerResults.push(result),
    );
    attacker.onMessage(SERVER_MESSAGES.targetSelected, () => undefined);
    observer.onMessage(SERVER_MESSAGES.combatEvent, () => undefined);
    attacker.onMessage<{ code: string }>(
      SERVER_MESSAGES.combatRejected,
      ({ code }) => rejections.push(code),
    );
    attacker.onMessage(SERVER_MESSAGES.combatEvent, (event) =>
      publicEvents.push(event),
    );

    attacker.send(CLIENT_MESSAGES.targetSelection, { targetEntityId });
    await vi.waitFor(() => expect(attackerResults).toEqual([]));
    attacker.send(CLIENT_MESSAGES.targetSelection, {
      targetEntityId: "monster:missing",
    });
    await vi.waitFor(() =>
      expect(rejections).toContain(ERROR_CODES.targetNotFound),
    );
    attacker.send(CLIENT_MESSAGES.basicAttack, null);
    await vi.waitFor(() => {
      expect(attackerResults).toContainEqual({
        accepted: false,
        actionId: "invalid",
        code: ERROR_CODES.invalidCombatIntention,
      });
    });
    attacker.send(CLIENT_MESSAGES.basicAttack, {
      actionId: "forged-outcome",
      targetEntityId,
      damage: 9_999,
      remainingResource: 0,
      cooldownEndsAtMs: 0,
      drop: "item:forged",
    });

    await vi.waitFor(() => {
      expect(attackerResults).toContainEqual({
        accepted: false,
        actionId: "invalid",
        code: ERROR_CODES.invalidCombatIntention,
      });
    });
    expect(observerResults).toEqual([]);
    expect(JSON.stringify(observer.state)).not.toContain("forged-outcome");
    expect(
      publicEvents.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "kind" in event &&
          (event.kind === "hit" || event.kind === "defeated"),
      ),
    ).toEqual([]);
  });

  it("damages and respawns one server-controlled monster without broadcasting private action results", async () => {
    const endpoint = await startDevelopmentServer();
    const attacker = await joinVillage(endpoint, "Mossback Hunter");
    const observer = await joinVillage(endpoint, "Mossback Witness");
    const targetEntityId = monsterId(attacker);
    const results: CombatResult[] = [];
    const observerResults: CombatResult[] = [];
    attacker.onMessage<CombatResult>(SERVER_MESSAGES.combatResult, (result) =>
      results.push(result),
    );
    observer.onMessage<CombatResult>(SERVER_MESSAGES.combatResult, (result) =>
      observerResults.push(result),
    );
    attacker.onMessage(SERVER_MESSAGES.targetSelected, () => undefined);
    attacker.onMessage(SERVER_MESSAGES.combatEvent, () => undefined);
    observer.onMessage(SERVER_MESSAGES.combatEvent, () => undefined);
    attacker.send(CLIENT_MESSAGES.targetSelection, { targetEntityId });

    await vi.waitFor(
      () => {
        const state = JSON.parse(JSON.stringify(attacker.state)) as {
          players: Record<string, { x: number; y: number }>;
          monsters: Record<
            string,
            { x: number; y: number; healthFraction: number }
          >;
        };
        const player = state.players[attacker.sessionId];
        const monster = state.monsters[targetEntityId];
        expect(player).toBeDefined();
        expect(monster).toBeDefined();
        expect(
          Math.hypot(player!.x - monster!.x, player!.y - monster!.y),
        ).toBeLessThanOrEqual(84);
      },
      { timeout: 5_000, interval: 20 },
    );

    for (let index = 0; index < 3; index += 1) {
      const actionId = `strike-${String(index)}`;
      attacker.send(CLIENT_MESSAGES.basicAttack, {
        actionId,
        targetEntityId,
      });
      if (index === 0) {
        attacker.send(CLIENT_MESSAGES.basicAttack, {
          actionId: "rate-abuse",
          targetEntityId,
        });
        await vi.waitFor(
          () =>
            expect(results).toContainEqual({
              accepted: false,
              actionId: "rate-abuse",
              code: ERROR_CODES.actionRateLimited,
            }),
          { timeout: 2_000, interval: 20 },
        );
      }
      await vi.waitFor(
        () =>
          expect(
            results.some(
              (result) => result.accepted && result.actionId === actionId,
            ),
          ).toBe(true),
        { timeout: 2_000, interval: 20 },
      );
      if (index < 2) await new Promise((resolve) => setTimeout(resolve, 650));
    }

    await vi.waitFor(() => {
      const state = JSON.parse(JSON.stringify(observer.state)) as {
        monsters: Record<string, { animation: string; healthFraction: number }>;
      };
      expect(state.monsters[targetEntityId]?.animation).toBe("defeated");
      expect(state.monsters[targetEntityId]?.healthFraction).toBe(0);
    });
    expect(observerResults).toEqual([]);

    await vi.waitFor(
      () => {
        const state = JSON.parse(JSON.stringify(observer.state)) as {
          monsters: Record<
            string,
            { animation: string; healthFraction: number }
          >;
        };
        expect(state.monsters[targetEntityId]?.animation).not.toBe("defeated");
        expect(state.monsters[targetEntityId]?.healthFraction).toBe(1);
      },
      { timeout: 5_000, interval: 20 },
    );
  });
});
