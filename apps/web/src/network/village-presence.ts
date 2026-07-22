import { Client, type Room } from "@colyseus/sdk";
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
  type PublicMonsterPresence,
  type PublicPlayerPresence,
  type PublicVillageState,
  type QuestRewardMessage,
  type QuestStateMessage,
} from "@gameish/protocol";
import { ServerTimeEstimator } from "./movement-synchronizer.js";

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
  setSimulatedLatency(latencyMs: number): void;
  subscribe(listener: (snapshot: VillagePresenceSnapshot) => void): () => void;
  close(): Promise<void>;
}

export async function connectDevelopmentVillage(
  displayName: string,
  options: { simulatedLatencyMs?: number } = {},
): Promise<VillagePresence> {
  const response = await fetch("/development/play-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) throw new Error("Development admission is unavailable");
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string") {
    throw new Error("Development admission returned an invalid ticket");
  }

  return connectVillageWithTicket(body.ticket, options);
}

export async function connectVillageWithTicket(
  ticket: string,
  options: { simulatedLatencyMs?: number } = {},
): Promise<VillagePresence> {
  const room: Room<unknown, PublicVillageState> = await new Client(
    window.location.origin,
  ).joinOrCreate(ROOM_NAMES.village, { ticket });
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
  const serverClock = new ServerTimeEstimator();

  room.reconnection.minUptime = 0;
  room.reconnection.minDelay = 100;
  room.reconnection.delay = 100;
  room.reconnection.maxDelay = 500;
  room.reconnection.maxRetries = 10;
  room.reconnection.maxEnqueuedMessages = 120;

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

  const publish = (state: PublicVillageState) => {
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
    };
    afterNetworkDelay(() => {
      for (const listener of listeners) listener(snapshot);
    });
  };
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
  room.onMessage<unknown>(SERVER_MESSAGES.targetSelected, (unsafeSelection) => {
    const selection = targetSelectedSchema.safeParse(unsafeSelection);
    if (!selection.success) return;
    selectedTargetEntityId = selection.data.targetEntityId;
    publish(room.state);
  });
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
  room.onMessage<unknown>(SERVER_MESSAGES.combatRejected, (unsafeRejection) => {
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
  });
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
  room.send(CLIENT_MESSAGES.questStateRequest);
  room.send(CLIENT_MESSAGES.equipmentStateRequest);
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

  return {
    developmentRoomId: room.roomId,
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
