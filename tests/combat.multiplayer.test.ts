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
  type RewardSummaryMessage,
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
  it("delivers independent private rewards only to active participants", async () => {
    const endpoint = await startDevelopmentServer();
    const first = await joinVillage(endpoint, "First Reward Ranger");
    const second = await joinVillage(endpoint, "Second Reward Ranger");
    const spectator = await joinVillage(endpoint, "Spectator Ranger");
    const targetEntityId = monsterId(first);
    const firstRewards: RewardSummaryMessage[] = [];
    const secondRewards: RewardSummaryMessage[] = [];
    const spectatorRewards: RewardSummaryMessage[] = [];
    const firstResults: CombatResult[] = [];
    const secondResults: CombatResult[] = [];
    const selected = { first: false, second: false };
    first.onMessage<CombatResult>(SERVER_MESSAGES.combatResult, (result) =>
      firstResults.push(result),
    );
    second.onMessage<CombatResult>(SERVER_MESSAGES.combatResult, (result) =>
      secondResults.push(result),
    );
    first.onMessage(SERVER_MESSAGES.targetSelected, () => {
      selected.first = true;
    });
    second.onMessage(SERVER_MESSAGES.targetSelected, () => {
      selected.second = true;
    });
    first.onMessage<RewardSummaryMessage>(
      SERVER_MESSAGES.rewardSummary,
      (reward) => firstRewards.push(reward),
    );
    second.onMessage<RewardSummaryMessage>(
      SERVER_MESSAGES.rewardSummary,
      (reward) => secondRewards.push(reward),
    );
    spectator.onMessage<RewardSummaryMessage>(
      SERVER_MESSAGES.rewardSummary,
      (reward) => spectatorRewards.push(reward),
    );

    first.send(CLIENT_MESSAGES.targetSelection, { targetEntityId });
    second.send(CLIENT_MESSAGES.targetSelection, { targetEntityId });
    await vi.waitFor(() =>
      expect(selected).toEqual({ first: true, second: true }),
    );
    await vi.waitFor(
      () => {
        const state = JSON.parse(JSON.stringify(first.state)) as {
          players: Record<string, { x: number; y: number }>;
          monsters: Record<string, { x: number; y: number }>;
        };
        const player = state.players[first.sessionId];
        const monster = state.monsters[targetEntityId];
        expect(player).toBeDefined();
        expect(monster).toBeDefined();
        expect(
          Math.hypot(player!.x - monster!.x, player!.y - monster!.y),
        ).toBeLessThanOrEqual(84);
      },
      { timeout: 5_000, interval: 20 },
    );

    const attack = (room: Room, actionId: string) => {
      room.send(CLIENT_MESSAGES.basicAttack, {
        actionId,
        targetEntityId,
      });
    };
    attack(first, "first-hit");
    await vi.waitFor(() =>
      expect(firstResults).toContainEqual(
        expect.objectContaining({ accepted: true, actionId: "first-hit" }),
      ),
    );
    attack(second, "second-hit");
    await vi.waitFor(() =>
      expect(secondResults).toContainEqual(
        expect.objectContaining({ accepted: true, actionId: "second-hit" }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    attack(first, "defeating-hit");
    await vi.waitFor(() =>
      expect(firstResults).toContainEqual(
        expect.objectContaining({
          accepted: true,
          actionId: "defeating-hit",
          defeated: true,
        }),
      ),
    );

    await vi.waitFor(
      () => {
        expect(firstRewards).toHaveLength(1);
        expect(secondRewards).toHaveLength(1);
      },
      { timeout: 3_000, interval: 20 },
    );
    expect(spectatorRewards).toEqual([]);
    expect(firstRewards[0]).toEqual({
      sourceMonsterId: "monster:mossback",
      items: [{ itemId: "item:mossback_scale", quantity: 1 }],
    });
    expect(secondRewards[0]).toEqual({
      sourceMonsterId: "monster:mossback",
      items: [{ itemId: "item:mossback_scale", quantity: 1 }],
    });
    expect(JSON.stringify(spectator.state)).not.toContain("reward_summary");
  });

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

  it("runs all four server-authoritative abilities with private cooldown state and public telegraphs", async () => {
    const endpoint = await startDevelopmentServer();
    const player = await joinVillage(endpoint, "Ability Ranger");
    const observer = await joinVillage(endpoint, "Telegraph Witness");
    const targetEntityId = monsterId(player);
    const results: CombatResult[] = [];
    const observerResults: CombatResult[] = [];
    const states: unknown[] = [];
    const telegraphs: unknown[] = [];
    player.onMessage<CombatResult>(SERVER_MESSAGES.combatResult, (result) =>
      results.push(result),
    );
    player.onMessage(SERVER_MESSAGES.combatState, (state) =>
      states.push(state),
    );
    observer.onMessage<CombatResult>(SERVER_MESSAGES.combatResult, (result) =>
      observerResults.push(result),
    );
    observer.onMessage(SERVER_MESSAGES.combatTelegraph, (telegraph) =>
      telegraphs.push(telegraph),
    );

    player.send(CLIENT_MESSAGES.targetSelection, { targetEntityId });
    await vi.waitFor(
      () => {
        const state = JSON.parse(JSON.stringify(player.state)) as {
          players: Record<string, { x: number; y: number }>;
          monsters: Record<string, { x: number; y: number }>;
        };
        const local = state.players[player.sessionId];
        const monster = state.monsters[targetEntityId];
        expect(local).toBeDefined();
        expect(monster).toBeDefined();
        expect(
          Math.hypot(local!.x - monster!.x, local!.y - monster!.y),
        ).toBeLessThanOrEqual(80);
      },
      { timeout: 5_000, interval: 20 },
    );

    player.send(CLIENT_MESSAGES.ability, {
      actionId: "unknown-ability",
      abilityId: "ability:stale-client-action",
      targetEntityId,
    });
    await vi.waitFor(() =>
      expect(results).toContainEqual({
        accepted: false,
        actionId: "unknown-ability",
        code: ERROR_CODES.abilityNotFound,
      }),
    );

    const abilityIds = [
      "ability:thorn_arc",
      "ability:binding_briar",
      "ability:warding_breath",
      "ability:disrupting_roar",
    ];
    for (const [index, abilityId] of abilityIds.entries()) {
      const actionId = `ability-${String(index)}`;
      player.send(CLIENT_MESSAGES.ability, {
        actionId,
        abilityId,
        targetEntityId,
      });
      await vi.waitFor(
        () =>
          expect(
            results.some(
              (result) => result.accepted && result.actionId === actionId,
            ),
          ).toBe(true),
        { timeout: 2_000, interval: 20 },
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    observer.send(CLIENT_MESSAGES.targetSelection, { targetEntityId });
    observer.send(CLIENT_MESSAGES.ability, {
      actionId: "cooperative-thorn-arc",
      abilityId: "ability:thorn_arc",
      targetEntityId,
    });
    await vi.waitFor(() =>
      expect(observerResults).toContainEqual(
        expect.objectContaining({
          accepted: true,
          actionId: "cooperative-thorn-arc",
          abilityId: "ability:thorn_arc",
        }),
      ),
    );

    player.send(CLIENT_MESSAGES.ability, {
      actionId: "ability-3",
      abilityId: "ability:warding_breath",
      targetEntityId,
    });
    await vi.waitFor(() =>
      expect(results).toContainEqual({
        accepted: false,
        actionId: "ability-3",
        code: ERROR_CODES.staleAction,
      }),
    );
    expect(states.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(telegraphs.length).toBeGreaterThan(0), {
      timeout: 5_000,
      interval: 20,
    });
    expect(JSON.stringify(observer.state)).not.toContain("cooldowns");
    expect(telegraphs[0]).toMatchObject({
      abilityId: "monster_action:mossback_splinter_roar",
      durationMs: 600,
      interruptible: true,
    });
  });
});
