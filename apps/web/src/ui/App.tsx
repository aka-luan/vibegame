import { useEffect, useRef, useState } from "react";
import villageCombat from "@gameish/content/village-combat";
import villageEquipment from "@gameish/content/village-equipment";

import {
  connectDevelopmentVillage,
  connectVillageWithTicket,
  type VillagePresence,
  type VillagePresenceSnapshot,
} from "../network/village-presence.js";
import {
  createWorldRenderer,
  type WorldRenderer,
  type WorldSnapshot,
} from "../world/create-world-renderer.js";
import { DialogueDialog } from "./DialogueDialog.js";

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
const accountFlowForced =
  import.meta.env.MODE === "test" &&
  developmentLoginEnabled &&
  new URLSearchParams(window.location.search).get("account") === "1";
const useDevelopmentLogin = developmentLoginEnabled && !accountFlowForced;

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

interface AccountCharacter {
  id: string;
  name: string;
}

export function App({ worldRoot }: { worldRoot: HTMLElement }) {
  const renderer = useRef<WorldRenderer | null>(null);
  const presence = useRef<VillagePresence | null>(null);
  const unsubscribeCombat = useRef<(() => void) | undefined>(undefined);
  const chatInput = useRef<HTMLInputElement | null>(null);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [accountCharacters, setAccountCharacters] = useState<
    AccountCharacter[]
  >([]);
  const [accountName, setAccountName] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountReady, setAccountReady] = useState(useDevelopmentLogin);
  const [joined, setJoined] = useState(useDevelopmentLogin);
  const [developmentRoomId, setDevelopmentRoomId] = useState<string | null>(
    null,
  );
  const [simulatedLatencyMs, setSimulatedLatencyMs] = useState(
    requestedSimulatedLatency,
  );
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [dialogueTextScale, setDialogueTextScale] = useState(1);
  const [guidanceEnabled, setGuidanceEnabled] = useState(true);
  const [chatText, setChatText] = useState("");
  const [combatSnapshot, setCombatSnapshot] = useState<
    Pick<
      VillagePresenceSnapshot,
      | "monsters"
      | "selectedTargetEntityId"
      | "combatResult"
      | "combatState"
      | "telegraphs"
      | "dialogueNode"
      | "dialogueError"
      | "questState"
      | "questReward"
      | "questError"
      | "equipmentState"
      | "equipmentResult"
      | "previewAppearance"
      | "serverTimeOffsetMs"
      | "chatEnabled"
      | "chatMessages"
      | "chatError"
    >
  >({
    monsters: [],
    selectedTargetEntityId: null,
    combatResult: undefined,
    combatState: undefined,
    telegraphs: [],
    dialogueNode: undefined,
    dialogueError: undefined,
    questState: undefined,
    questReward: undefined,
    questError: undefined,
    equipmentState: undefined,
    equipmentResult: undefined,
    previewAppearance: undefined,
    serverTimeOffsetMs: 0,
    chatEnabled: false,
    chatMessages: [],
    chatError: undefined,
  });

  useEffect(() => {
    let active = true;
    if (!useDevelopmentLogin) {
      void fetch("/api/guest/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Guest session unavailable");
          return (await response.json()) as { characters?: AccountCharacter[] };
        })
        .then((account) => {
          const characters = account.characters ?? [];
          setAccountCharacters(characters);
          setAccountReady(true);
        })
        .catch(() => setConnectionError("Could not create a guest session."));
      return () => undefined;
    }

    void connectDevelopmentVillage(requestedDisplayName(), {
      simulatedLatencyMs,
    })
      .then((connectedPresence) => {
        if (!active) return connectedPresence.close();
        presence.current = connectedPresence;
        setJoined(true);
        setDevelopmentRoomId(connectedPresence.developmentRoomId);
        unsubscribeCombat.current = connectedPresence.subscribe(
          (presenceSnapshot) => {
            setCombatSnapshot({
              monsters: presenceSnapshot.monsters,
              selectedTargetEntityId: presenceSnapshot.selectedTargetEntityId,
              combatResult: presenceSnapshot.combatResult,
              combatState: presenceSnapshot.combatState,
              telegraphs: presenceSnapshot.telegraphs,
              dialogueNode: presenceSnapshot.dialogueNode,
              dialogueError: presenceSnapshot.dialogueError,
              questState: presenceSnapshot.questState,
              questReward: presenceSnapshot.questReward,
              questError: presenceSnapshot.questError,
              equipmentState: presenceSnapshot.equipmentState,
              equipmentResult: presenceSnapshot.equipmentResult,
              previewAppearance: presenceSnapshot.previewAppearance,
              serverTimeOffsetMs: presenceSnapshot.serverTimeOffsetMs,
              chatEnabled: presenceSnapshot.chatEnabled,
              chatMessages: presenceSnapshot.chatMessages,
              chatError: presenceSnapshot.chatError,
            });
          },
        );
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
      unsubscribeCombat.current?.();
      unsubscribeCombat.current = undefined;
      const connectedPresence = presence.current;
      presence.current = null;
      if (connectedPresence) void connectedPresence.close();
    };
  }, [worldRoot]);

  async function joinProductionCharacter(characterId: string): Promise<void> {
    setAccountBusy(true);
    setConnectionError(null);
    try {
      const selected = await fetch(
        `/api/characters/${encodeURIComponent(characterId)}/select`,
        { method: "POST" },
      );
      if (!selected.ok) throw new Error("Character selection failed");
      const ticketResponse = await fetch("/api/play-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId }),
      });
      if (!ticketResponse.ok) throw new Error("Play ticket unavailable");
      const body = (await ticketResponse.json()) as { ticket?: unknown };
      if (typeof body.ticket !== "string")
        throw new Error("Invalid play ticket");
      const connectedPresence = await connectVillageWithTicket(body.ticket);
      presence.current = connectedPresence;
      setJoined(true);
      unsubscribeCombat.current = connectedPresence.subscribe(
        (presenceSnapshot) => {
          setCombatSnapshot({
            monsters: presenceSnapshot.monsters,
            selectedTargetEntityId: presenceSnapshot.selectedTargetEntityId,
            combatResult: presenceSnapshot.combatResult,
            combatState: presenceSnapshot.combatState,
            telegraphs: presenceSnapshot.telegraphs,
            dialogueNode: presenceSnapshot.dialogueNode,
            dialogueError: presenceSnapshot.dialogueError,
            questState: presenceSnapshot.questState,
            questReward: presenceSnapshot.questReward,
            questError: presenceSnapshot.questError,
            equipmentState: presenceSnapshot.equipmentState,
            equipmentResult: presenceSnapshot.equipmentResult,
            previewAppearance: presenceSnapshot.previewAppearance,
            serverTimeOffsetMs: presenceSnapshot.serverTimeOffsetMs,
            chatEnabled: presenceSnapshot.chatEnabled,
            chatMessages: presenceSnapshot.chatMessages,
            chatError: presenceSnapshot.chatError,
          });
        },
      );
      renderer.current = createWorldRenderer(
        worldRoot,
        connectedPresence,
        setSnapshot,
      );
    } catch {
      setConnectionError("Could not enter the village.");
    } finally {
      setAccountBusy(false);
    }
  }

  async function createProductionCharacter(): Promise<void> {
    setAccountBusy(true);
    setConnectionError(null);
    try {
      const response = await fetch("/api/characters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: accountName,
          requestId: crypto.randomUUID(),
        }),
      });
      if (!response.ok) throw new Error("Character creation failed");
      const body = (await response.json()) as {
        character?: AccountCharacter;
      };
      if (!body.character) throw new Error("Invalid character response");
      setAccountCharacters((characters) => [...characters, body.character!]);
      await joinProductionCharacter(body.character.id);
    } catch {
      setConnectionError("Could not create that character.");
      setAccountBusy(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!combatSnapshot.dialogueNode) renderer.current?.focus();
  }, [combatSnapshot.dialogueNode]);

  useEffect(() => {
    if (!combatSnapshot.chatEnabled) return;
    const focusChat = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || combatSnapshot.dialogueNode) return;
      if (document.activeElement === chatInput.current) return;
      event.preventDefault();
      chatInput.current?.focus();
    };
    window.addEventListener("keydown", focusChat);
    return () => window.removeEventListener("keydown", focusChat);
  }, [combatSnapshot.chatEnabled, combatSnapshot.dialogueNode]);

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

  if (!useDevelopmentLogin && accountReady && !joined) {
    return (
      <aside
        className="world-panel account-panel"
        aria-labelledby="account-heading"
      >
        <p className="eyebrow">A browser-bound guest identity</p>
        <h1 id="account-heading">Enter the village</h1>
        <p>
          Your guest credential stays in this browser. Losing it is
          unrecoverable in this slice.
        </p>
        {connectionError ? <p role="alert">{connectionError}</p> : null}
        {accountCharacters.length === 0 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createProductionCharacter();
            }}
          >
            <label>
              Character name
              <input
                value={accountName}
                onChange={(event) => setAccountName(event.currentTarget.value)}
                minLength={2}
                maxLength={24}
                required
              />
            </label>
            <button type="submit" disabled={accountBusy}>
              Create character
            </button>
          </form>
        ) : (
          <section aria-labelledby="characters-heading">
            <h2 id="characters-heading">Choose a character</h2>
            {accountCharacters.map((character) => (
              <button
                type="button"
                key={character.id}
                disabled={accountBusy}
                onClick={() => void joinProductionCharacter(character.id)}
              >
                Enter as {character.name}
              </button>
            ))}
          </section>
        )}
      </aside>
    );
  }

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
      {combatSnapshot.chatEnabled ? (
        <section aria-labelledby="chat-heading" className="chat-panel">
          <h2 id="chat-heading">Map chat</h2>
          <ol
            className="chat-messages"
            aria-live="polite"
            aria-relevant="additions"
          >
            {combatSnapshot.chatMessages.map((message, index) => (
              <li key={`${message.serverTimeMs}-${message.entityId}-${index}`}>
                <strong>{message.displayName}:</strong>{" "}
                <span>{message.text}</span>
              </li>
            ))}
          </ol>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              presence.current?.sendChat(chatText);
              setChatText("");
            }}
          >
            <label htmlFor="map-chat-input">Message current map</label>
            <input
              id="map-chat-input"
              ref={chatInput}
              value={chatText}
              onChange={(event) => setChatText(event.currentTarget.value)}
              maxLength={240}
              autoComplete="off"
              required
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.blur();
                  renderer.current?.focus();
                }
              }}
            />
            <button type="submit">Send</button>
          </form>
          {combatSnapshot.chatError ? (
            <p role="alert">{combatSnapshot.chatError}</p>
          ) : null}
        </section>
      ) : null}
      {snapshot.interaction ? (
        <p className="interaction-hint">E — {snapshot.interaction}</p>
      ) : null}
      <section aria-labelledby="quest-heading" className="quest-panel">
        <h2 id="quest-heading">Quest tracker</h2>
        {combatSnapshot.questState ? (
          <>
            <h3>{combatSnapshot.questState.title}</h3>
            <p>{combatSnapshot.questState.description}</p>
            <p aria-live="polite">
              Status: {combatSnapshot.questState.status}; progress{" "}
              {combatSnapshot.questState.progress}/
              {combatSnapshot.questState.requiredCount}
            </p>
            <label>
              <input
                type="checkbox"
                checked={guidanceEnabled}
                onChange={(event) =>
                  setGuidanceEnabled(event.currentTarget.checked)
                }
              />
              Show guidance
            </label>
            {guidanceEnabled &&
            (combatSnapshot.questState.status === "active" ||
              combatSnapshot.questState.status === "ready") ? (
              <p className="quest-guidance" role="status">
                Guidance: {combatSnapshot.questState.guidance.label}
              </p>
            ) : null}
            {combatSnapshot.questError ? (
              <p role="alert">{combatSnapshot.questError}</p>
            ) : null}
            {combatSnapshot.questReward ? (
              <p className="quest-reward" role="status">
                Reward received: {combatSnapshot.questReward.itemId} ×
                {combatSnapshot.questReward.quantity},{" "}
                {combatSnapshot.questReward.experience} XP and{" "}
                {combatSnapshot.questReward.currency} currency.
              </p>
            ) : null}
          </>
        ) : (
          <p>Loading quest state…</p>
        )}
      </section>
      <section aria-labelledby="equipment-heading" className="equipment-panel">
        <h2 id="equipment-heading">Inventory and equipment</h2>
        {combatSnapshot.equipmentState ? (
          <>
            <p>
              Appearance revision{" "}
              {combatSnapshot.equipmentState.appearanceRevision}.
            </p>
            <ul className="equipment-list">
              {combatSnapshot.equipmentState.inventory.map((entry) => {
                const definition = villageEquipment.items.find(
                  (item) => item.id === entry.itemId,
                );
                const equipped = combatSnapshot.equipmentState?.equipment.some(
                  (item) => item.itemId === entry.itemId,
                );
                return (
                  <li
                    key={entry.itemId}
                    data-testid={`inventory-${entry.itemId}`}
                  >
                    <span>
                      {definition?.displayName ?? entry.itemId} ×
                      {entry.quantity}
                    </span>
                    {definition ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            const appearance =
                              combatSnapshot.equipmentState?.appearance;
                            if (!appearance) return;
                            presence.current?.previewAppearance({
                              ...appearance,
                              armorLayerId: definition.layerId,
                            });
                          }}
                        >
                          Preview
                        </button>
                        {equipped ? (
                          <button
                            type="button"
                            onClick={() =>
                              presence.current?.unequipItem("body")
                            }
                          >
                            Unequip
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              presence.current?.equipItem(entry.itemId)
                            }
                          >
                            Equip
                          </button>
                        )}
                      </>
                    ) : (
                      <span>Not wearable</span>
                    )}
                  </li>
                );
              })}
            </ul>
            {combatSnapshot.previewAppearance ? (
              <p role="status">
                Previewing{" "}
                {combatSnapshot.previewAppearance.armorLayerId || "no armor"}.{" "}
                <button
                  type="button"
                  onClick={() => presence.current?.previewAppearance(undefined)}
                >
                  Clear preview
                </button>
              </p>
            ) : null}
            {combatSnapshot.equipmentResult &&
            !combatSnapshot.equipmentResult.accepted ? (
              <p role="alert">{combatSnapshot.equipmentResult.code}</p>
            ) : null}
          </>
        ) : (
          <p>Loading inventory…</p>
        )}
      </section>
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
      {useDevelopmentLogin && developmentRoomId ? (
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
      {combatSnapshot.dialogueNode ? (
        <DialogueDialog
          node={combatSnapshot.dialogueNode}
          error={combatSnapshot.dialogueError}
          textScale={dialogueTextScale}
          onTextScaleChange={setDialogueTextScale}
          onChoice={(choiceId) => {
            const node = combatSnapshot.dialogueNode;
            if (node) {
              presence.current?.selectDialogueChoice(
                node.npcId,
                node.nodeId,
                choiceId,
              );
            }
          }}
          onClose={() => {
            presence.current?.closeDialogue();
          }}
        />
      ) : null}
    </aside>
  );
}
