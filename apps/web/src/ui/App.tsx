import { useEffect, useRef, useState } from "react";
import forestMap from "@gameish/content/forest-map";
import { LOGICAL_MAP_DIRECTORY } from "@gameish/content";
import villageCombat from "@gameish/content/village-combat";
import villageEquipment from "@gameish/content/village-equipment";
import villageMap from "@gameish/content/village-map";
import type { ClientMapArtifact } from "@gameish/content";

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
import { MapPanel } from "./MapPanel.js";

/**
 * The client-safe map artifact for every logical map the world renderer can
 * be rebuilt for. Keyed by the map id the presence snapshot names as
 * `currentMapId`, which mirrors `village-presence.ts`'s own lookup.
 */
const MAP_ARTIFACTS_BY_ID: Record<string, ClientMapArtifact> = {
  [villageMap.id]: villageMap,
  [forestMap.id]: forestMap,
};

function mapArtifactFor(mapId: string | undefined): ClientMapArtifact {
  return (mapId && MAP_ARTIFACTS_BY_ID[mapId]) || villageMap;
}

type CombatSnapshot = Pick<
  VillagePresenceSnapshot,
  | "localEntityId"
  | "players"
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
  | "currentMapId"
  | "activePortalPrompt"
  | "transitionStatus"
  | "lastTransitionErrorCode"
  | "partyState"
  | "partyInvitation"
  | "partyResult"
  | "mapOverview"
>;

function pickCombatSnapshot(
  presenceSnapshot: VillagePresenceSnapshot,
): CombatSnapshot {
  return {
    localEntityId: presenceSnapshot.localEntityId,
    players: presenceSnapshot.players,
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
    currentMapId: presenceSnapshot.currentMapId,
    activePortalPrompt: presenceSnapshot.activePortalPrompt,
    transitionStatus: presenceSnapshot.transitionStatus,
    lastTransitionErrorCode: presenceSnapshot.lastTransitionErrorCode,
    partyState: presenceSnapshot.partyState,
    partyInvitation: presenceSnapshot.partyInvitation,
    partyResult: presenceSnapshot.partyResult,
    mapOverview: presenceSnapshot.mapOverview,
  };
}

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

/**
 * Dev/test-only spawn override read from the URL, forwarded to
 * `connectDevelopmentVillage` so a headless or e2e test can land directly
 * at a named entrance (e.g. next to a portal) instead of spending real time
 * walking there. Only wired up under development login (see
 * `useDevelopmentLogin` below) — production admission never reads these.
 */
function requestedSpawnOverride(): { mapId?: string; entranceId?: string } {
  const params = new URLSearchParams(window.location.search);
  const mapId = params.get("mapId")?.trim();
  const entranceId = params.get("entranceId")?.trim();
  return {
    ...(mapId ? { mapId } : {}),
    ...(entranceId ? { entranceId } : {}),
  };
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
  const [mapOpen, setMapOpen] = useState(false);
  const [guidanceEnabled, setGuidanceEnabled] = useState(true);
  const [chatText, setChatText] = useState("");
  const [combatSnapshot, setCombatSnapshot] = useState<CombatSnapshot>({
    localEntityId: "",
    players: [],
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
    currentMapId: villageMap.id,
    activePortalPrompt: null,
    transitionStatus: "idle",
    lastTransitionErrorCode: undefined,
    partyState: { members: [] },
    partyInvitation: undefined,
    partyResult: undefined,
    mapOverview: undefined,
  });
  const renderedMapId = useRef<string | null>(null);

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
      ...requestedSpawnOverride(),
    })
      .then((connectedPresence) => {
        if (!active) return connectedPresence.close();
        presence.current = connectedPresence;
        setJoined(true);
        setDevelopmentRoomId(connectedPresence.developmentRoomId);
        unsubscribeCombat.current = connectedPresence.subscribe(
          (presenceSnapshot) => {
            setCombatSnapshot(pickCombatSnapshot(presenceSnapshot));
          },
        );
        const initialMap = mapArtifactFor(requestedSpawnOverride().mapId);
        renderedMapId.current = initialMap.id;
        renderer.current = createWorldRenderer(
          worldRoot,
          connectedPresence,
          initialMap,
          setSnapshot,
        );
        renderer.current.setQuestGuidanceEnabled(guidanceEnabled);
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
      const body = (await ticketResponse.json()) as {
        ticket?: unknown;
        mapId?: unknown;
      };
      if (typeof body.ticket !== "string")
        throw new Error("Invalid play ticket");
      // The ticket is bound to the character's checkpointed logical map, so
      // the room to join follows the server's answer, never a client guess:
      // a character who logged out in the forest resumes in the forest.
      const admittedMapId =
        typeof body.mapId === "string" ? body.mapId : villageMap.id;
      const connectedPresence = await connectVillageWithTicket(
        body.ticket,
        admittedMapId,
      );
      presence.current = connectedPresence;
      setJoined(true);
      unsubscribeCombat.current = connectedPresence.subscribe(
        (presenceSnapshot) => {
          setCombatSnapshot(pickCombatSnapshot(presenceSnapshot));
        },
      );
      renderedMapId.current = admittedMapId;
      renderer.current = createWorldRenderer(
        worldRoot,
        connectedPresence,
        mapArtifactFor(admittedMapId),
        setSnapshot,
      );
      renderer.current.setQuestGuidanceEnabled(guidanceEnabled);
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
    renderer.current?.setQuestGuidanceEnabled(guidanceEnabled);
  }, [guidanceEnabled]);

  useEffect(() => {
    if (!combatSnapshot.chatEnabled) return;
    const focusChat = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || combatSnapshot.dialogueNode) return;
      if (document.activeElement === chatInput.current) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(
            target.tagName,
          ))
      ) {
        return;
      }
      event.preventDefault();
      chatInput.current?.focus();
    };
    window.addEventListener("keydown", focusChat);
    return () => window.removeEventListener("keydown", focusChat);
  }, [combatSnapshot.chatEnabled, combatSnapshot.dialogueNode]);

  useEffect(() => {
    const openMap = (event: KeyboardEvent) => {
      if (!joined || mapOpen || event.key.toLowerCase() !== "m") return;
      if (combatSnapshot.dialogueNode) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(
            target.tagName,
          ))
      ) {
        return;
      }
      event.preventDefault();
      setMapOpen(true);
    };
    window.addEventListener("keydown", openMap);
    return () => window.removeEventListener("keydown", openMap);
  }, [combatSnapshot.dialogueNode, joined, mapOpen]);

  // React owns swapping the rendered map artifact whenever the presence
  // snapshot reports a new logical map (i.e. after a portal transition
  // completes); Phaser only owns the canvas underneath it. The world
  // renderer itself has no notion of "switch maps" — it is rebuilt fresh
  // against the new map artifact, same as the initial connect above.
  useEffect(() => {
    const connectedPresence = presence.current;
    if (!connectedPresence) return;
    if (!combatSnapshot.currentMapId) return;
    if (renderedMapId.current === combatSnapshot.currentMapId) return;
    const destinationMapId = combatSnapshot.currentMapId;
    renderedMapId.current = destinationMapId;
    renderer.current?.destroy();
    renderer.current = null;
    // Phaser tears a game down on the next step of its loop rather than
    // synchronously, so building the destination renderer in the same task
    // races the outgoing one: whichever canvas the pending teardown reaches
    // last is the one removed from the parent. Waiting a frame lets the old
    // canvas go first, leaving exactly one canvas mounted.
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      renderer.current = createWorldRenderer(
        worldRoot,
        connectedPresence,
        mapArtifactFor(destinationMapId),
        setSnapshot,
      );
      renderer.current.setQuestGuidanceEnabled(guidanceEnabled);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [combatSnapshot.currentMapId, worldRoot]);

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
  const localPartyMember = combatSnapshot.partyState.members.find(
    (member) => member.entityId === combatSnapshot.localEntityId,
  );
  const partyEntityIds = new Set(
    combatSnapshot.partyState.members.map((member) => member.entityId),
  );
  const partyInviteCandidates = combatSnapshot.players.filter(
    (player) =>
      player.entityId !== combatSnapshot.localEntityId &&
      !partyEntityIds.has(player.entityId),
  );
  const canInviteToParty =
    combatSnapshot.partyState.members.length === 0 ||
    localPartyMember?.leader === true;
  const currentMapName =
    combatSnapshot.mapOverview?.locations.find(
      (location) => location.logicalMapId === combatSnapshot.currentMapId,
    )?.displayName ??
    LOGICAL_MAP_DIRECTORY.find(
      (entry) => entry.logicalMapId === combatSnapshot.currentMapId,
    )?.displayName ??
    "Current area";

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
      <p className="control-hint">
        Move with WASD or arrow keys. Press M for the map.
      </p>
      {connectionError ? <p role="alert">{connectionError}</p> : null}
      <button type="button" onClick={() => setMapOpen(true)}>
        Map (M)
      </button>
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
      <section aria-labelledby="party-heading" className="party-panel">
        <h2 id="party-heading">Party</h2>
        {combatSnapshot.partyInvitation ? (
          <div className="party-invitation" role="status">
            <p>
              {combatSnapshot.partyInvitation.inviter.displayName} invited you
              to a party.
            </p>
            <button
              type="button"
              onClick={() =>
                presence.current?.acceptPartyInvitation(
                  combatSnapshot.partyInvitation!.invitationId,
                )
              }
            >
              Accept invitation from{" "}
              {combatSnapshot.partyInvitation.inviter.displayName}
            </button>
            <button
              type="button"
              onClick={() =>
                presence.current?.declinePartyInvitation(
                  combatSnapshot.partyInvitation!.invitationId,
                )
              }
            >
              Decline invitation from{" "}
              {combatSnapshot.partyInvitation.inviter.displayName}
            </button>
          </div>
        ) : null}
        {combatSnapshot.partyState.members.length > 0 ? (
          <>
            <ul className="party-members">
              {combatSnapshot.partyState.members.map((member) => (
                <li key={member.entityId}>
                  <span>
                    {member.displayName}
                    {member.leader ? " — leader" : ""} — {member.logicalMapId}
                    {member.connected ? "" : " — reconnecting"}
                  </span>
                  {member.entityId !== combatSnapshot.localEntityId ? (
                    <>
                      {combatSnapshot.partyState.members.some(
                        (candidate) =>
                          candidate.entityId === combatSnapshot.localEntityId &&
                          candidate.leader,
                      ) ? (
                        <button
                          type="button"
                          disabled={!member.connected}
                          onClick={() =>
                            presence.current?.changePartyLeader(member.entityId)
                          }
                        >
                          Make {member.displayName} leader
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={
                          !member.connected ||
                          combatSnapshot.transitionStatus === "pending"
                        }
                        onClick={() =>
                          presence.current?.travelToPartyMember(member.entityId)
                        }
                      >
                        Travel to {member.displayName}
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => presence.current?.leaveParty()}
            >
              Leave party
            </button>
          </>
        ) : null}
        {canInviteToParty && partyInviteCandidates.length > 0 ? (
          <ul className="party-candidates">
            {partyInviteCandidates.map((player) => (
              <li key={player.entityId}>
                <span>{player.displayName}</span>
                <button
                  type="button"
                  onClick={() =>
                    presence.current?.inviteToParty(player.entityId)
                  }
                >
                  Invite {player.displayName}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {combatSnapshot.partyResult && !combatSnapshot.partyResult.accepted ? (
          <p role="alert">{combatSnapshot.partyResult.code}</p>
        ) : null}
      </section>
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
              <>
                {combatSnapshot.questState.guidance ? (
                  <p className="quest-guidance" role="status">
                    Guidance: {combatSnapshot.questState.guidance.label}
                  </p>
                ) : null}
                {combatSnapshot.questState.markers?.map((marker) => (
                  <p className="quest-guidance" role="status" key={marker.id}>
                    Marker: {marker.label}
                  </p>
                ))}
              </>
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
      {combatSnapshot.lastTransitionErrorCode ? (
        <p role="alert">{combatSnapshot.lastTransitionErrorCode}</p>
      ) : null}
      {combatSnapshot.activePortalPrompt ? (
        <button
          type="button"
          disabled={combatSnapshot.transitionStatus === "pending"}
          onClick={() => {
            const portalId = combatSnapshot.activePortalPrompt?.portalId;
            const localPartyMember = combatSnapshot.partyState.members.find(
              (member) => member.entityId === combatSnapshot.localEntityId,
            );
            if (portalId)
              presence.current?.requestPortalTransition(
                portalId,
                localPartyMember?.leader === false,
              );
          }}
        >
          {combatSnapshot.partyState.members.some(
            (member) =>
              member.entityId === combatSnapshot.localEntityId &&
              !member.leader,
          )
            ? `${combatSnapshot.activePortalPrompt.label} alone — party stays here`
            : combatSnapshot.activePortalPrompt.label}
        </button>
      ) : null}
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
      {mapOpen ? (
        <MapPanel
          currentMap={mapArtifactFor(combatSnapshot.currentMapId)}
          currentMapName={currentMapName}
          overview={combatSnapshot.mapOverview}
          localPosition={{ x: snapshot.x, y: snapshot.y }}
          onClose={() => setMapOpen(false)}
        />
      ) : null}
    </aside>
  );
}
