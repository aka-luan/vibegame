import { useEffect, useRef, useState } from "react";
import villageCombat from "@gameish/content/village-combat";

import {
  connectDevelopmentVillage,
  type VillagePresence,
  type VillagePresenceSnapshot,
} from "../network/village-presence.js";
import {
  createWorldRenderer,
  type WorldRenderer,
  type WorldSnapshot,
} from "../world/create-world-renderer.js";

const initialSnapshot: WorldSnapshot = {
  x: 128,
  y: 224,
  facing: "east",
  state: "idle",
  interaction: null,
  publicPlayerCount: 0,
  connectionStatus: "connected",
  predictionError: 0,
  serverTimeOffsetMs: 0,
};

const developmentLoginEnabled =
  (import.meta.env.MODE === "development" || import.meta.env.MODE === "test") &&
  import.meta.env.VITE_DEVELOPMENT_LOGIN_ENABLED === "true";

function requestedDisplayName(): string {
  const name = new URLSearchParams(window.location.search).get("name")?.trim();
  return name || `Ranger ${crypto.randomUUID().slice(0, 6)}`;
}

function requestedSimulatedLatency(): number {
  const value = Number(
    new URLSearchParams(window.location.search).get("latency") ?? 0,
  );
  return Number.isFinite(value) ? Math.max(0, Math.min(500, value)) : 0;
}

const basicAttack = villageCombat.attacks.find(
  (attack) => attack.id === villageCombat.classes[0]?.basicAttackId,
);
const classDefinition = villageCombat.classes[0];
const abilitySlots = classDefinition?.abilityIds.map((id, index) => ({
  id,
  slot: `ability_${index + 1}` as const,
  definition: villageCombat.abilities.find((ability) => ability.id === id),
}));

export function App({ worldRoot }: { worldRoot: HTMLElement }) {
  const renderer = useRef<WorldRenderer | null>(null);
  const presence = useRef<VillagePresence | null>(null);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [developmentRoomId, setDevelopmentRoomId] = useState<string | null>(
    null,
  );
  const [simulatedLatencyMs, setSimulatedLatencyMs] = useState(
    requestedSimulatedLatency,
  );
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [combatSnapshot, setCombatSnapshot] = useState<
    Pick<
      VillagePresenceSnapshot,
      | "monsters"
      | "selectedTargetEntityId"
      | "combatResult"
      | "combatState"
      | "telegraphs"
      | "serverTimeOffsetMs"
    >
  >({
    monsters: [],
    selectedTargetEntityId: null,
    combatResult: undefined,
    combatState: undefined,
    telegraphs: [],
    serverTimeOffsetMs: 0,
  });

  useEffect(() => {
    let active = true;
    let unsubscribeCombat: (() => void) | undefined;
    if (!developmentLoginEnabled) {
      setConnectionError("Multiplayer development login is disabled.");
      return () => undefined;
    }

    void connectDevelopmentVillage(requestedDisplayName(), {
      simulatedLatencyMs,
    })
      .then((connectedPresence) => {
        if (!active) return connectedPresence.close();
        presence.current = connectedPresence;
        setDevelopmentRoomId(connectedPresence.developmentRoomId);
        unsubscribeCombat = connectedPresence.subscribe((presenceSnapshot) => {
          setCombatSnapshot({
            monsters: presenceSnapshot.monsters,
            selectedTargetEntityId: presenceSnapshot.selectedTargetEntityId,
            combatResult: presenceSnapshot.combatResult,
            combatState: presenceSnapshot.combatState,
            telegraphs: presenceSnapshot.telegraphs,
            serverTimeOffsetMs: presenceSnapshot.serverTimeOffsetMs,
          });
        });
        renderer.current = createWorldRenderer(
          worldRoot,
          connectedPresence,
          setSnapshot,
        );
      })
      .catch(() => {
        if (active)
          setConnectionError("Could not enter the development village.");
      });

    return () => {
      active = false;
      renderer.current?.destroy();
      renderer.current = null;
      unsubscribeCombat?.();
      const connectedPresence = presence.current;
      presence.current = null;
      if (connectedPresence) void connectedPresence.close();
    };
  }, [worldRoot]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  const estimatedServerTimeMs = clockMs + combatSnapshot.serverTimeOffsetMs;
  const cooldownRemaining = (actionId: string): number =>
    Math.max(
      0,
      (combatSnapshot.combatState?.cooldowns[actionId] ?? 0) -
        estimatedServerTimeMs,
    );
  const actionDisabled = (actionId: string): boolean =>
    !combatSnapshot.selectedTargetEntityId || cooldownRemaining(actionId) > 0;
  const combatFeedback = (() => {
    const result = combatSnapshot.combatResult;
    if (!result) return undefined;
    if (!result.accepted) return result.code;
    const feedback = result.abilityId
      ? villageCombat.abilities.find(
          (ability) => ability.id === result.abilityId,
        )?.feedback
      : basicAttack?.feedback;
    return `${feedback ?? "Action resolved."} ${
      result.defeated ? "Mossback defeated." : `Hit for ${result.damage}.`
    }`;
  })();

  return (
    <aside className="world-panel" aria-labelledby="world-heading">
      <p className="eyebrow">Authoritative multiplayer village</p>
      <h1 id="world-heading">Village presence test</h1>
      <p className="control-hint">Move with WASD or arrow keys.</p>
      {connectionError ? <p role="alert">{connectionError}</p> : null}
      <p className="world-status" aria-live="polite">
        {snapshot.publicPlayerCount} players connected. Facing {snapshot.facing}
        ; {snapshot.state}. Network {snapshot.connectionStatus}.
      </p>
      {snapshot.interaction ? (
        <p className="interaction-hint">E — {snapshot.interaction}</p>
      ) : null}
      <section aria-labelledby="combat-heading" className="combat-panel">
        <h2 id="combat-heading">Nearby encounters</h2>
        {combatSnapshot.monsters.map((monster) => (
          <div className="monster-row" key={monster.entityId}>
            <button
              type="button"
              aria-pressed={
                combatSnapshot.selectedTargetEntityId === monster.entityId
              }
              onClick={() => presence.current?.selectTarget(monster.entityId)}
            >
              {monster.displayName} ({Math.round(monster.healthFraction * 100)}
              %)
            </button>
            {combatSnapshot.selectedTargetEntityId === monster.entityId ? (
              <button
                type="button"
                onClick={() => presence.current?.basicAttack()}
                disabled={monster.animation === "defeated"}
              >
                1 — {basicAttack?.displayName ?? "Basic attack"}
              </button>
            ) : null}
          </div>
        ))}
        {combatSnapshot.combatResult ? (
          <p className="combat-feedback" role="status">
            {combatFeedback}
          </p>
        ) : null}
        <div
          className="resource-meter"
          role="progressbar"
          aria-label="Focus resource"
          aria-valuemin={0}
          aria-valuemax={combatSnapshot.combatState?.maximumResource ?? 100}
          aria-valuenow={combatSnapshot.combatState?.resource ?? 0}
        >
          <span>
            Focus {Math.round(combatSnapshot.combatState?.resource ?? 0)} /
            {combatSnapshot.combatState?.maximumResource ?? 100}
          </span>
          <span
            className="resource-meter-fill"
            style={{
              width: `${((combatSnapshot.combatState?.resource ?? 0) / (combatSnapshot.combatState?.maximumResource ?? 100)) * 100}%`,
            }}
          />
        </div>
        <div className="hotbar" aria-label="Five-slot action hotbar">
          <button
            type="button"
            className="hotbar-action"
            disabled={actionDisabled(basicAttack?.id ?? "")}
            onClick={() => presence.current?.basicAttack()}
          >
            <span>1</span>
            {basicAttack?.displayName ?? "Basic attack"}
            {cooldownRemaining(basicAttack?.id ?? "") > 0
              ? ` (${Math.ceil(cooldownRemaining(basicAttack?.id ?? "") / 100) / 10}s)`
              : null}
          </button>
          {abilitySlots?.map(({ id, slot, definition }, index) => (
            <button
              type="button"
              className="hotbar-action"
              key={id}
              disabled={actionDisabled(id)}
              onClick={() => presence.current?.useAbility(id)}
            >
              <span>{index + 2}</span>
              {definition?.displayName ?? slot}
              {cooldownRemaining(id) > 0
                ? ` (${Math.ceil(cooldownRemaining(id) / 100) / 10}s)`
                : null}
            </button>
          ))}
        </div>
        <p className="combat-state" aria-live="polite">
          State: {combatSnapshot.combatState?.controlState ?? "normal"}
          {combatSnapshot.telegraphs.length > 0
            ? " — incoming telegraph; use Disrupting Roar if it is interruptible."
            : ""}
        </p>
      </section>
      <button type="button" onClick={() => renderer.current?.focus()}>
        Return to world
      </button>
      {developmentLoginEnabled && developmentRoomId ? (
        <details className="development-overlay">
          <summary>Development room inspection</summary>
          <code>{developmentRoomId}</code>
          <label>
            Simulated round-trip latency: {simulatedLatencyMs} ms
            <input
              aria-label="Simulated round-trip latency"
              type="range"
              min="0"
              max="500"
              step="25"
              value={simulatedLatencyMs}
              onChange={(event) => {
                const latencyMs = Number(event.currentTarget.value);
                setSimulatedLatencyMs(latencyMs);
                presence.current?.setSimulatedLatency(latencyMs);
              }}
            />
          </label>
          <span>
            Prediction error: {snapshot.predictionError.toFixed(2)} px; server
            offset: {snapshot.serverTimeOffsetMs.toFixed(0)} ms.
          </span>
        </details>
      ) : null}
    </aside>
  );
}
