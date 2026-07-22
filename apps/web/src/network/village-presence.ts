import { Client, type Room } from "@colyseus/sdk";
import forestMap from "@gameish/content/forest-map";
import villageMap from "@gameish/content/village-map";
import { z } from "zod";
import {
  CLIENT_MESSAGES,
  ERROR_CODES,
  ROOM_NAMES,
  SERVER_MESSAGES,
  type AuthoritativeMovementSnapshot,
  type CombatStateMessage,
  type CombatTelegraphMessage,
  type CombatResult,
  type EquipmentResult,
  type EquipmentStateMessage,
  type DialogueNodeMessage,
  type ErrorCode,
  type MovementIntention,
  type MapChatMessage,
  type PublicMonsterPresence,
  type PublicPlayerPresence,
  type PublicPlayerState,
  type PublicRoomStateMap,
  type QuestRewardMessage,
  type QuestStateMessage,
} from "@gameish/protocol";
import { ServerTimeEstimator } from "./movement-synchronizer.js";
import {
  computeActivePortalPrompt,
  PORTAL_PROMPT_RADIUS,
  type ActivePortalPrompt,
} from "./portal-prompt.js";

const errorCodeSchema = z.enum(
  Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]],
);
const authoritativeMovementSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    lastProcessedSequence: z.number().int().nonnegative(),
    serverTimeMs: z.number().finite(),
  })
  .strict();
const targetSelectedSchema = z
  .object({ targetEntityId: z.string().min(1).max(80) })
  .strict();
const effectFeedbackSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("damage"), amount: z.number().nonnegative() })
    .strict(),
  z
    .object({
      kind: z.literal("status"),
      statusId: z.string(),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("resource"), amount: z.number() }).strict(),
  z.object({ kind: z.literal("interrupt") }).strict(),
]);
const combatResultSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      accepted: z.literal(true),
      actionId: z.string(),
      targetEntityId: z.string(),
      damage: z.number().nonnegative(),
      remainingResource: z.number().nonnegative(),
      cooldownEndsAtMs: z.number().finite(),
      defeated: z.boolean(),
      abilityId: z.string().optional(),
      slot: z
        .enum(["basic", "ability_1", "ability_2", "ability_3", "ability_4"])
        .optional(),
      effects: z.array(effectFeedbackSchema).optional(),
      movementLockedUntilMs: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      accepted: z.literal(false),
      actionId: z.string(),
      code: errorCodeSchema,
    })
    .strict(),
]);
const combatEventSchema = z
  .object({
    kind: z.enum([
      "spawned",
      "aggro",
      "hit",
      "defeated",
      "respawned",
      "attack",
      "cast_started",
      "interrupted",
    ]),
    entityId: z.string(),
    healthFraction: z.number().min(0).max(1).optional(),
  })
  .strict();
const combatStateSchema = z
  .object({
    serverTimeMs: z.number().finite(),
    resource: z.number().nonnegative(),
    maximumResource: z.number().positive(),
    cooldowns: z.record(z.string(), z.number().finite()),
    movementLockedUntilMs: z.number().finite(),
    controlState: z.enum(["normal", "rooted", "stunned", "casting"]),
    statuses: z.array(z.string()),
  })
  .strict();
const combatTelegraphSchema = z
  .object({
    entityId: z.string(),
    abilityId: z.string(),
    startTimeMs: z.number().finite(),
    durationMs: z.number().positive(),
    interruptible: z.boolean(),
  })
  .strict();
const dialogueNodeSchema = z
  .object({
    dialogueId: z.string().min(1),
    npcId: z.string().min(1),
    nodeId: z.string().min(1),
    speaker: z.string().min(1),
    text: z.string().min(1),
    choices: z.array(
      z.object({ id: z.string().min(1), label: z.string().min(1) }).strict(),
    ),
  })
  .strict();
const questStateSchema = z
  .object({
    questId: z.string().min(1),
    status: z.enum(["available", "active", "ready", "completed"]),
    progress: z.number().int().nonnegative(),
    requiredCount: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string().min(1),
    guidance: z
      .object({ label: z.string().min(1), targetId: z.string().min(1) })
      .strict(),
  })
  .strict();
const questRewardSchema = z
  .object({
    questId: z.string().min(1),
    itemId: z.string().min(1),
    quantity: z.number().int().positive(),
    experience: z.number().int().nonnegative(),
    currency: z.number().int().nonnegative(),
  })
  .strict();
const equipmentAppearanceSchema = z
  .object({
    rigId: z.string().min(1),
    baseLayerId: z.string().min(1),
    armorLayerId: z.string(),
  })
  .strict();
const equipmentStateSchema = z
  .object({
    characterRevision: z.number().int().nonnegative(),
    appearanceRevision: z.number().int().nonnegative(),
    appearance: equipmentAppearanceSchema,
    inventory: z.array(
      z
        .object({
          itemId: z.string().min(1),
          quantity: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    equipment: z.array(
      z.object({ slot: z.literal("body"), itemId: z.string().min(1) }).strict(),
    ),
  })
  .strict();
const equipmentResultSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      accepted: z.literal(true),
      actionId: z.string(),
      state: equipmentStateSchema,
    })
    .strict(),
  z
    .object({
      accepted: z.literal(false),
      actionId: z.string(),
      code: errorCodeSchema,
      state: equipmentStateSchema.optional(),
    })
    .strict(),
]);
const chatAvailabilitySchema = z.object({ enabled: z.boolean() }).strict();
const mapChatMessageSchema = z
  .object({
    entityId: z.string().min(1),
    displayName: z.string().min(1),
    text: z.string().min(1),
    serverTimeMs: z.number().finite(),
  })
  .strict();
const transitionTicketSchema = z
  .object({
    actionId: z.string().min(1).max(64),
    ticket: z.string().min(1),
    destinationRoomName: z.string().min(1),
    destinationMapId: z.string().min(1),
    expiresAtMs: z.number().finite(),
  })
  .strict();
const transitionRejectedSchema = z
  .object({
    actionId: z.string().min(1).max(64),
    code: errorCodeSchema,
  })
  .strict();

/**
 * Every room a client can join publishes at least this shape.
 * `monsters` is only present on the village room's state (see
 * `PublicVillageState`/`PublicForestState` in `@gameish/protocol`); it is
 * typed optional here so the same presence connection can be rebound across
 * either room without a cast, and `publish()` already reads it with `?.`.
 */
interface AnyPublicRoomState {
  serverTimeMs: number;
  players: PublicRoomStateMap<PublicPlayerState>;
  monsters?: PublicRoomStateMap<{
    displayName: string;
    x: number;
    y: number;
    animation: "idle" | "walk" | "attack" | "hit" | "defeated";
    healthFraction: number;
  }>;
}

/**
 * The client-safe map artifact for every logical map a player can be
 * transitioned into, keyed by the map id the server names in
 * `TransitionTicketMessage.destinationMapId` (and in the initial village
 * join). Only client artifacts are imported here — no server geometry, no
 * portal destinations (ADR-0008).
 */
const MAP_ARTIFACTS_BY_ID = {
  [villageMap.id]: villageMap,
  [forestMap.id]: forestMap,
};

export interface VillagePresenceSnapshot {
  localEntityId: string;
  serverTimeMs: number;
  connectionStatus: "connected" | "reconnecting" | "disconnected";
  localMovement: AuthoritativeMovementSnapshot | undefined;
  players: readonly PublicPlayerPresence[];
  monsters: readonly PublicMonsterPresence[];
  selectedTargetEntityId: string | null;
  combatResult: CombatResult | undefined;
  combatState: CombatStateMessage | undefined;
  telegraphs: readonly CombatTelegraphMessage[];
  dialogueNode: DialogueNodeMessage | undefined;
  dialogueError: ErrorCode | undefined;
  questState: QuestStateMessage | undefined;
  questReward: QuestRewardMessage | undefined;
  questError: ErrorCode | undefined;
  equipmentState: EquipmentStateMessage | undefined;
  equipmentResult: EquipmentResult | undefined;
  previewAppearance: PublicPlayerPresence["appearance"] | undefined;
  serverTimeOffsetMs: number;
  chatEnabled: boolean;
  chatMessages: readonly MapChatMessage[];
  chatError: ErrorCode | undefined;
  /** The logical map id the client is currently in — swap the rendered map
   * artifact (see `MAP_ARTIFACTS_BY_ID`) whenever this changes. */
  currentMapId: string;
  /** The portal prompt to surface in the UI, or `null` if the local player
   * isn't near a portal right now. Derived client-side from the current
   * map's `portalHints` purely for UI affordance — the server independently
   * re-validates proximity when a transition is requested. */
  activePortalPrompt: ActivePortalPrompt | null;
  /** Whether a portal transition request is in flight. */
  transitionStatus: "idle" | "pending";
  /** The stable error code from the most recent rejected or failed
   * transition, if any. */
  lastTransitionErrorCode: ErrorCode | undefined;
}

export interface VillagePresence {
  readonly developmentRoomId: string;
  readonly simulatedLatencyMs: number;
  sendMovement(intention: MovementIntention): void;
  selectTarget(targetEntityId: string): void;
  basicAttack(): void;
  useAbility(abilityId: string): void;
  equipItem(itemId: string): void;
  unequipItem(slot: "body"): void;
  previewAppearance(
    appearance: PublicPlayerPresence["appearance"] | undefined,
  ): void;
  interact(interactiveId: string): void;
  selectDialogueChoice(npcId: string, nodeId: string, choiceId: string): void;
  closeDialogue(): void;
  sendChat(text: string): void;
  requestPortalTransition(portalId: string): void;
  setSimulatedLatency(latencyMs: number): void;
  subscribe(listener: (snapshot: VillagePresenceSnapshot) => void): () => void;
  close(): Promise<void>;
}

function roomNameForMapId(mapId: string | undefined): string {
  return mapId === forestMap.id ? ROOM_NAMES.forest : ROOM_NAMES.village;
}

export async function connectDevelopmentVillage(
  displayName: string,
  options: {
    simulatedLatencyMs?: number;
    /**
     * Dev/test-only spawn override, forwarded to `/development/play-ticket`
     * (see `DevelopmentPlayTickets#issue`). Lets a headless or e2e test land
     * a development identity directly at a named entrance instead of
     * spending real time walking there — no client-selectable "choose your
     * spawn" surface is added by this (ADR-0007's fail-closed guard on this
     * endpoint outside development/test is unaffected).
     */
    mapId?: string;
    entranceId?: string;
  } = {},
): Promise<VillagePresence> {
  const response = await fetch("/development/play-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName,
      mapId: options.mapId,
      entranceId: options.entranceId,
    }),
  });
  if (!response.ok) throw new Error("Development admission is unavailable");
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string") {
    throw new Error("Development admission returned an invalid ticket");
  }

  return connectVillage(
    body.ticket,
    options,
    roomNameForMapId(options.mapId),
    options.mapId ?? villageMap.id,
    async () => {
      // Development recovery re-issues a brand-new development identity
      // (the `/development/play-ticket` endpoint has no notion of resuming
      // an existing one from HTTP); it always lands at the village's
      // default entrance rather than the checkpointed safe location. That
      // is a known development-only limitation — production recovery below
      // is precise.
      const recovered = await fetch("/development/play-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!recovered.ok) {
        throw new Error("Development recovery admission is unavailable");
      }
      const recoveredBody = (await recovered.json()) as { ticket?: unknown };
      if (typeof recoveredBody.ticket !== "string") {
        throw new Error("Development recovery returned an invalid ticket");
      }
      return {
        ticket: recoveredBody.ticket,
        roomName: ROOM_NAMES.village,
        mapId: villageMap.id,
      };
    },
  );
}

export async function connectVillageWithTicket(
  ticket: string,
  /**
   * The logical map the server bound this ticket to — the character's
   * checkpointed map, not a client choice. Defaults to the village only for
   * callers that predate multi-map admission.
   */
  admittedMapId: string = villageMap.id,
  options: { simulatedLatencyMs?: number } = {},
): Promise<VillagePresence> {
  return connectVillage(
    ticket,
    options,
    roomNameForMapId(admittedMapId),
    admittedMapId,
    async () => {
      // A fresh play ticket resumes the signed-in character at its most
      // recent checkpoint (see `GuestAccountService#issuePlayTicket`), which
      // for a just-failed transition is the safe location the source room
      // checkpointed before issuing the transition ticket (AC4). The server
      // names the map that ticket is bound to; the client follows it rather
      // than assuming the room it was leaving.
      const response = await fetch("/api/play-ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        throw new Error("Play ticket recovery is unavailable");
      }
      const body = (await response.json()) as {
        ticket?: unknown;
        mapId?: unknown;
      };
      if (typeof body.ticket !== "string") {
        throw new Error("Play ticket recovery returned an invalid ticket");
      }
      return {
        ticket: body.ticket,
        roomName: roomNameForMapId(
          typeof body.mapId === "string" ? body.mapId : undefined,
        ),
        mapId: typeof body.mapId === "string" ? body.mapId : villageMap.id,
      };
    },
  );
}

async function connectVillage(
  initialTicket: string,
  options: { simulatedLatencyMs?: number },
  initialRoomName: string,
  initialMapId: string,
  requestRecoveryTicket: (
    sourceRoomName: string,
  ) => Promise<{ ticket: string; roomName: string; mapId: string }>,
): Promise<VillagePresence> {
  const client = new Client(window.location.origin);
  let room: Room<unknown, AnyPublicRoomState> = await client.joinOrCreate(
    initialRoomName,
    { ticket: initialTicket },
  );
  let currentRoomName: string = initialRoomName;
  let currentMapId: string = initialMapId;

  const listeners = new Set<(snapshot: VillagePresenceSnapshot) => void>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let simulatedLatencyMs = options.simulatedLatencyMs ?? 0;
  let connectionStatus: VillagePresenceSnapshot["connectionStatus"] =
    "connected";
  let localMovement: AuthoritativeMovementSnapshot | undefined;
  let selectedTargetEntityId: string | null = null;
  let combatResult: CombatResult | undefined;
  let combatState: CombatStateMessage | undefined;
  let telegraphs: CombatTelegraphMessage[] = [];
  let dialogueNode: DialogueNodeMessage | undefined;
  let dialogueError: ErrorCode | undefined;
  let questState: QuestStateMessage | undefined;
  let questReward: QuestRewardMessage | undefined;
  let questError: ErrorCode | undefined;
  let equipmentState: EquipmentStateMessage | undefined;
  let equipmentResult: EquipmentResult | undefined;
  let previewAppearance: PublicPlayerPresence["appearance"] | undefined;
  let serverTimeOffsetMs = 0;
  let chatEnabled = false;
  let chatMessages: MapChatMessage[] = [];
  let chatError: ErrorCode | undefined;
  let transitionStatus: VillagePresenceSnapshot["transitionStatus"] = "idle";
  let lastTransitionErrorCode: ErrorCode | undefined;
  const serverClock = new ServerTimeEstimator();

  const afterNetworkDelay = (callback: () => void) => {
    const delayMs = simulatedLatencyMs / 2;
    if (delayMs === 0) {
      callback();
      return;
    }
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      callback();
    }, delayMs);
    pendingTimers.add(timer);
  };

  const publish = (state: AnyPublicRoomState) => {
    serverClock.observe(state.serverTimeMs, Date.now());
    serverTimeOffsetMs = serverClock.offsetMs;
    const players: PublicPlayerPresence[] = [];
    state.players?.forEach((player, entityId) => {
      players.push({
        entityId,
        displayName: player.displayName,
        x: player.x,
        y: player.y,
        facing: player.facing,
        animation: player.animation,
        appearanceRevision: player.appearanceRevision,
        appearance: {
          rigId: player.appearance.rigId,
          baseLayerId: player.appearance.baseLayerId,
          armorLayerId: player.appearance.armorLayerId,
        },
      });
    });
    const monsters: PublicMonsterPresence[] = [];
    state.monsters?.forEach((monster, entityId) => {
      monsters.push({
        entityId,
        displayName: monster.displayName,
        x: monster.x,
        y: monster.y,
        animation: monster.animation,
        healthFraction: monster.healthFraction,
      });
    });
    const localPlayer = players.find(
      (player) => player.entityId === room.sessionId,
    );
    const mapArtifact = MAP_ARTIFACTS_BY_ID[currentMapId];
    const activePortalPrompt =
      localPlayer && mapArtifact
        ? computeActivePortalPrompt(
            mapArtifact.portalHints,
            localPlayer,
            PORTAL_PROMPT_RADIUS,
          )
        : null;
    const snapshot: VillagePresenceSnapshot = {
      localEntityId: room.sessionId,
      serverTimeMs: state.serverTimeMs,
      connectionStatus,
      localMovement,
      players,
      monsters,
      selectedTargetEntityId,
      combatResult,
      combatState,
      telegraphs,
      dialogueNode,
      dialogueError,
      questState,
      questReward,
      questError,
      equipmentState,
      equipmentResult,
      previewAppearance,
      serverTimeOffsetMs,
      chatEnabled,
      chatMessages,
      chatError,
      currentMapId,
      activePortalPrompt,
      transitionStatus,
      lastTransitionErrorCode,
    };
    afterNetworkDelay(() => {
      // Transitions add and remove subscribers while snapshots are in
      // flight, so one failing listener must not starve the others.
      for (const listener of listeners) {
        try {
          listener(snapshot);
        } catch {
          // A subscriber's own failure is not a presence failure.
        }
      }
    });
  };

  function bindRoomListeners(): void {
    room.reconnection.minUptime = 0;
    room.reconnection.minDelay = 100;
    room.reconnection.delay = 100;
    room.reconnection.maxDelay = 500;
    room.reconnection.maxRetries = 10;
    room.reconnection.maxEnqueuedMessages = 120;

    room.onStateChange(publish);
    room.onMessage<unknown>(
      SERVER_MESSAGES.authoritativeMovement,
      (unsafeSnapshot) => {
        const snapshot = authoritativeMovementSchema.safeParse(unsafeSnapshot);
        if (!snapshot.success) return;
        localMovement = snapshot.data;
        publish(room.state);
      },
    );
    room.onMessage<unknown>(
      SERVER_MESSAGES.targetSelected,
      (unsafeSelection) => {
        const selection = targetSelectedSchema.safeParse(unsafeSelection);
        if (!selection.success) return;
        selectedTargetEntityId = selection.data.targetEntityId;
        publish(room.state);
      },
    );
    room.onMessage<unknown>(SERVER_MESSAGES.combatResult, (unsafeResult) => {
      const result = combatResultSchema.safeParse(unsafeResult);
      if (!result.success) return;
      combatResult = result.data as CombatResult;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.combatState, (unsafeState) => {
      const state = combatStateSchema.safeParse(unsafeState);
      if (!state.success) return;
      combatState = state.data;
      serverClock.observe(state.data.serverTimeMs, Date.now());
      publish(room.state);
    });
    room.onMessage<unknown>(
      SERVER_MESSAGES.combatTelegraph,
      (unsafeTelegraph) => {
        const telegraph = combatTelegraphSchema.safeParse(unsafeTelegraph);
        if (!telegraph.success) return;
        telegraphs = [
          ...telegraphs.filter(
            (candidate) =>
              candidate.startTimeMs + candidate.durationMs >
              telegraph.data.startTimeMs,
          ),
          telegraph.data,
        ];
        serverClock.observe(room.state.serverTimeMs, Date.now());
        publish(room.state);
      },
    );
    room.onMessage<unknown>(
      SERVER_MESSAGES.combatRejected,
      (unsafeRejection) => {
        const rejection = z
          .object({ code: errorCodeSchema })
          .strict()
          .safeParse(unsafeRejection);
        if (!rejection.success) return;
        combatResult = {
          accepted: false,
          actionId: "target-selection",
          code: rejection.data.code,
        };
        publish(room.state);
      },
    );
    room.onMessage<unknown>(SERVER_MESSAGES.combatEvent, (unsafeEvent) => {
      if (!combatEventSchema.safeParse(unsafeEvent).success) return;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.dialogueNode, (unsafeNode) => {
      const node = dialogueNodeSchema.safeParse(unsafeNode);
      if (!node.success) return;
      dialogueNode = node.data;
      dialogueError = undefined;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.dialogueClosed, () => {
      dialogueNode = undefined;
      dialogueError = undefined;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.dialogueRejected, (unsafeError) => {
      const rejection = z
        .object({ code: errorCodeSchema })
        .strict()
        .safeParse(unsafeError);
      if (!rejection.success) return;
      dialogueError = rejection.data.code;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.questState, (unsafeState) => {
      const state = questStateSchema.safeParse(unsafeState);
      if (!state.success) return;
      questState = state.data;
      questError = undefined;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.questReward, (unsafeReward) => {
      const reward = questRewardSchema.safeParse(unsafeReward);
      if (!reward.success) return;
      questReward = reward.data;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.questRejected, (unsafeError) => {
      const rejection = z
        .object({ code: errorCodeSchema })
        .strict()
        .safeParse(unsafeError);
      if (!rejection.success) return;
      questError = rejection.data.code;
      publish(room.state);
    });
    room.onMessage<unknown>(
      SERVER_MESSAGES.transitionTicket,
      (unsafeTicket) => {
        const ticket = transitionTicketSchema.safeParse(unsafeTicket);
        if (!ticket.success) return;
        void performTransition(ticket.data);
      },
    );
    room.onMessage<unknown>(
      SERVER_MESSAGES.transitionRejected,
      (unsafeRejection) => {
        const rejection = transitionRejectedSchema.safeParse(unsafeRejection);
        if (!rejection.success) return;
        transitionStatus = "idle";
        lastTransitionErrorCode = rejection.data.code;
        publish(room.state);
      },
    );
    room.onMessage<unknown>(SERVER_MESSAGES.equipmentState, (unsafeState) => {
      const state = equipmentStateSchema.safeParse(unsafeState);
      if (!state.success) return;
      equipmentState = state.data;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.equipmentResult, (unsafeResult) => {
      const result = equipmentResultSchema.safeParse(unsafeResult);
      if (!result.success) return;
      equipmentResult = result.data as EquipmentResult;
      if (result.data.state) equipmentState = result.data.state;
      if (result.data.accepted) previewAppearance = undefined;
      publish(room.state);
    });
    room.onMessage<unknown>(
      SERVER_MESSAGES.chatAvailability,
      (unsafeMessage) => {
        const message = chatAvailabilitySchema.safeParse(unsafeMessage);
        if (!message.success) return;
        chatEnabled = message.data.enabled;
        publish(room.state);
      },
    );
    room.onMessage<unknown>(SERVER_MESSAGES.mapChat, (unsafeMessage) => {
      const message = mapChatMessageSchema.safeParse(unsafeMessage);
      if (!message.success) return;
      chatMessages = [...chatMessages.slice(-49), message.data];
      chatError = undefined;
      publish(room.state);
    });
    room.onMessage<unknown>(SERVER_MESSAGES.chatRejected, (unsafeMessage) => {
      const rejection = z
        .object({ code: errorCodeSchema })
        .strict()
        .safeParse(unsafeMessage);
      if (!rejection.success) return;
      chatError = rejection.data.code;
      publish(room.state);
    });
    // Only the village room implements quests and equipment (forest is
    // traversable-only per issue #13's non-goals); sending these on the
    // forest room would hit an unregistered message handler server-side and
    // force-close the connection.
    if (currentRoomName === ROOM_NAMES.village) {
      room.send(CLIENT_MESSAGES.questStateRequest);
      room.send(CLIENT_MESSAGES.equipmentStateRequest);
    }
    room.onDrop(() => {
      connectionStatus = "reconnecting";
      publish(room.state);
    });
    room.onReconnect(() => {
      connectionStatus = "connected";
      publish(room.state);
    });
    room.onLeave(() => {
      connectionStatus = "disconnected";
      publish(room.state);
    });
  }

  function resetTransientEncounterState(): void {
    selectedTargetEntityId = null;
    combatResult = undefined;
    combatState = undefined;
    telegraphs = [];
    dialogueNode = undefined;
    dialogueError = undefined;
    questState = undefined;
    questReward = undefined;
    questError = undefined;
    chatEnabled = false;
    chatMessages = [];
    chatError = undefined;
  }

  async function leaveCurrentRoomQuietly(): Promise<void> {
    try {
      await room.leave();
    } catch {
      // The server has typically already closed this connection as part of
      // issuing the transition ticket; a failing leave() here just means
      // there is nothing left to clean up.
    }
  }

  /**
   * AC1-AC3: on an approved transition, leave the source room and join the
   * server-supplied destination room with the server-supplied ticket,
   * rebinding every listener so existing subscribers keep receiving
   * snapshots. Never holds two joined rooms at once — the source room is
   * left before the destination room is joined.
   */
  async function performTransition(ticket: {
    actionId: string;
    ticket: string;
    destinationRoomName: string;
    destinationMapId: string;
    expiresAtMs: number;
  }): Promise<void> {
    const sourceRoomName = currentRoomName;
    transitionStatus = "pending";
    publish(room.state);
    await leaveCurrentRoomQuietly();
    try {
      const destinationRoom: Room<unknown, AnyPublicRoomState> =
        await client.joinOrCreate(ticket.destinationRoomName, {
          ticket: ticket.ticket,
        });
      room = destinationRoom;
      currentRoomName = ticket.destinationRoomName;
      currentMapId = ticket.destinationMapId;
      resetTransientEncounterState();
      transitionStatus = "idle";
      lastTransitionErrorCode = undefined;
      connectionStatus = "connected";
      bindRoomListeners();
      publish(room.state);
    } catch {
      await recoverFromFailedTransition(sourceRoomName);
    }
  }

  /**
   * AC4: the destination join failed (e.g. the destination room rejected
   * the ticket, or the network dropped mid-join). Request a fresh play
   * ticket and rejoin at the checkpointed safe location rather than being
   * left with no room at all, surfacing a stable error code either way.
   */
  async function recoverFromFailedTransition(
    sourceRoomName: string,
  ): Promise<void> {
    try {
      const recovery = await requestRecoveryTicket(sourceRoomName);
      const recoveredMapId = recovery.mapId;
      const recoveredRoom: Room<unknown, AnyPublicRoomState> =
        await client.joinOrCreate(recovery.roomName, {
          ticket: recovery.ticket,
        });
      room = recoveredRoom;
      currentRoomName = recovery.roomName;
      currentMapId = recoveredMapId;
      resetTransientEncounterState();
      transitionStatus = "idle";
      lastTransitionErrorCode = ERROR_CODES.transitionUnavailable;
      connectionStatus = "connected";
      bindRoomListeners();
      publish(room.state);
    } catch {
      transitionStatus = "idle";
      lastTransitionErrorCode = ERROR_CODES.transitionUnavailable;
      connectionStatus = "disconnected";
      publish(room.state);
    }
  }

  bindRoomListeners();

  return {
    get developmentRoomId() {
      return room.roomId;
    },
    get simulatedLatencyMs() {
      return simulatedLatencyMs;
    },
    sendMovement(intention) {
      afterNetworkDelay(() => room.send(CLIENT_MESSAGES.movement, intention));
    },
    selectTarget(targetEntityId) {
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.targetSelection, { targetEntityId }),
      );
    },
    basicAttack() {
      if (!selectedTargetEntityId) return;
      const targetEntityId = selectedTargetEntityId;
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.basicAttack, {
          actionId: crypto.randomUUID(),
          targetEntityId,
        }),
      );
    },
    useAbility(abilityId) {
      if (!selectedTargetEntityId) return;
      const targetEntityId = selectedTargetEntityId;
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.ability, {
          actionId: crypto.randomUUID(),
          abilityId,
          targetEntityId,
        }),
      );
    },
    equipItem(itemId) {
      const expectedCharacterRevision = equipmentState?.characterRevision ?? 0;
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.equipmentEquip, {
          actionId: crypto.randomUUID(),
          itemId,
          expectedCharacterRevision,
        }),
      );
    },
    unequipItem(slot) {
      const expectedCharacterRevision = equipmentState?.characterRevision ?? 0;
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.equipmentUnequip, {
          actionId: crypto.randomUUID(),
          slot,
          expectedCharacterRevision,
        }),
      );
    },
    previewAppearance(appearance) {
      previewAppearance = appearance;
      publish(room.state);
    },
    interact(interactiveId) {
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.interaction, {
          actionId: crypto.randomUUID(),
          interactiveId,
        }),
      );
    },
    selectDialogueChoice(npcId, nodeId, choiceId) {
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.dialogueChoice, {
          actionId: crypto.randomUUID(),
          npcId,
          nodeId,
          choiceId,
        }),
      );
    },
    closeDialogue() {
      dialogueNode = undefined;
      dialogueError = undefined;
      publish(room.state);
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.dialogueClose, {
          actionId: crypto.randomUUID(),
        }),
      );
    },
    sendChat(text) {
      afterNetworkDelay(() => room.send(CLIENT_MESSAGES.mapChat, { text }));
    },
    requestPortalTransition(portalId) {
      afterNetworkDelay(() =>
        room.send(CLIENT_MESSAGES.portalTransition, {
          actionId: crypto.randomUUID(),
          portalId,
        }),
      );
    },
    setSimulatedLatency(latencyMs) {
      simulatedLatencyMs = Math.max(0, Math.min(500, latencyMs));
    },
    subscribe(listener) {
      listeners.add(listener);
      publish(room.state);
      return () => listeners.delete(listener);
    },
    async close() {
      room.onStateChange.remove(publish);
      listeners.clear();
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      await room.leave();
    },
  };
}
