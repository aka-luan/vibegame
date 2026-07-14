import { useEffect, useRef, useState } from "react";

import {
  connectDevelopmentVillage,
  type VillagePresence,
} from "../network/village-presence.js";
import {
  createWorldRenderer,
  type WorldRenderer,
  type WorldSnapshot,
} from "../world/create-world-renderer.js";

const initialSnapshot: WorldSnapshot = {
  x: 128,
  y: 224,
  facing: "south",
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

  useEffect(() => {
    let active = true;
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
      const connectedPresence = presence.current;
      presence.current = null;
      if (connectedPresence) void connectedPresence.close();
    };
  }, [worldRoot]);

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
