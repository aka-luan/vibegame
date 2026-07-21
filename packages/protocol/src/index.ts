export const ERROR_CODES = {
  databaseUnavailable: "DATABASE_UNAVAILABLE",
  invalidOrigin: "INVALID_ORIGIN",
  sessionRequired: "SESSION_REQUIRED",
  characterNotFound: "CHARACTER_NOT_FOUND",
  characterNameTaken: "CHARACTER_NAME_TAKEN",
  invalidCharacterName: "INVALID_CHARACTER_NAME",
  invalidCharacterRequest: "INVALID_CHARACTER_REQUEST",
  destinationNotAllowed: "DESTINATION_NOT_ALLOWED",
  staleContentVersion: "STALE_CONTENT_VERSION",
  invalidJoinOptions: "INVALID_JOIN_OPTIONS",
  invalidMovementIntention: "INVALID_MOVEMENT_INTENTION",
  invalidTargetSelection: "INVALID_TARGET_SELECTION",
  invalidCombatIntention: "INVALID_COMBAT_INTENTION",
  invalidCombatState: "INVALID_COMBAT_STATE",
  targetNotFound: "TARGET_NOT_FOUND",
  targetNotSelected: "TARGET_NOT_SELECTED",
  targetDefeated: "TARGET_DEFEATED",
  targetOutOfRange: "TARGET_OUT_OF_RANGE",
  actionOnCooldown: "ABILITY_ON_COOLDOWN",
  insufficientResource: "INSUFFICIENT_RESOURCE",
  actionRateLimited: "ACTION_RATE_LIMITED",
  abilityNotFound: "ABILITY_NOT_FOUND",
  staleAction: "STALE_ACTION",
  actionInterrupted: "ACTION_INTERRUPTED",
  invalidInteraction: "INVALID_INTERACTION",
  interactionNotFound: "INTERACTION_NOT_FOUND",
  interactionOutOfRange: "INTERACTION_OUT_OF_RANGE",
  interactionRateLimited: "INTERACTION_RATE_LIMITED",
  dialogueBlocked: "DIALOGUE_BLOCKED",
  dialogueChoiceInvalid: "DIALOGUE_CHOICE_INVALID",
  dialogueNotActive: "DIALOGUE_NOT_ACTIVE",
  questNotFound: "QUEST_NOT_FOUND",
  questTransitionInvalid: "QUEST_TRANSITION_INVALID",
  questObjectiveInvalid: "QUEST_OBJECTIVE_INVALID",
  questPersistenceUnavailable: "QUEST_PERSISTENCE_UNAVAILABLE",
  invalidPlayTicket: "INVALID_PLAY_TICKET",
  playTicketExpired: "PLAY_TICKET_EXPIRED",
  playTicketReplayed: "PLAY_TICKET_REPLAYED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ROOM_NAMES = {
  village: "village",
} as const;

export const CLIENT_MESSAGES = {
  movement: "movement",
  targetSelection: "target_selection",
  basicAttack: "basic_attack",
  ability: "ability",
  interaction: "interaction",
  dialogueChoice: "dialogue_choice",
  dialogueClose: "dialogue_close",
  questStateRequest: "quest_state_request",
} as const;

export const SERVER_MESSAGES = {
  authoritativeMovement: "authoritative_movement",
  intentionRejected: "intention_rejected",
  targetSelected: "target_selected",
  combatResult: "combat_result",
  combatRejected: "combat_rejected",
  combatEvent: "combat_event",
  damageTaken: "damage_taken",
  combatState: "combat_state",
  combatTelegraph: "combat_telegraph",
  rewardSummary: "reward_summary",
  dialogueNode: "dialogue_node",
  dialogueClosed: "dialogue_closed",
  dialogueRejected: "dialogue_rejected",
  questState: "quest_state",
  questReward: "quest_reward",
  questRejected: "quest_rejected",
} as const;

export interface MovementIntention {
  x: number;
  y: number;
  sequence: number;
}

export interface AuthoritativeMovementSnapshot {
  x: number;
  y: number;
  lastProcessedSequence: number;
  serverTimeMs: number;
}

export interface PublicAppearance {
  rigId: string;
  baseLayerId: string;
  armorLayerId: string;
}

/**
 * Read-only structural subset of a Colyseus `MapSchema` that consumers of
 * public room state need: keyed iteration over synchronized values.
 */
export interface PublicRoomStateMap<T> {
  forEach(callback: (value: T, key: string) => void): void;
}

export interface PublicPlayerState {
  displayName: string;
  x: number;
  y: number;
  facing: "east" | "west";
  animation: "idle" | "walk";
  appearance: PublicAppearance;
}

export interface PublicPlayerPresence extends PublicPlayerState {
  entityId: string;
}

export interface TargetSelectionIntention {
  targetEntityId: string;
}

export interface BasicAttackIntention {
  actionId: string;
  targetEntityId: string;
}

export interface AbilityIntention {
  actionId: string;
  abilityId: string;
  targetEntityId: string;
}

export type PublicMonsterAnimation =
  "idle" | "walk" | "attack" | "hit" | "defeated";

export interface PublicMonsterState {
  displayName: string;
  x: number;
  y: number;
  animation: PublicMonsterAnimation;
  healthFraction: number;
}

export interface PublicMonsterPresence extends PublicMonsterState {
  entityId: string;
}

/**
 * The public village room state shape: what a nearby player's client needs
 * to render everyone in the room. Mirrors the server's Colyseus `Schema`
 * classes structurally; the server's classes are asserted to conform to
 * this type (see `apps/server/src/rooms/village-room.ts`).
 */
export interface PublicVillageState {
  serverTimeMs: number;
  players: PublicRoomStateMap<PublicPlayerState>;
  monsters: PublicRoomStateMap<PublicMonsterState>;
}

export interface CombatPublicEvent {
  kind:
    | "spawned"
    | "aggro"
    | "hit"
    | "defeated"
    | "respawned"
    | "attack"
    | "cast_started"
    | "interrupted";
  entityId: string;
  healthFraction?: number;
}

export interface TargetSelectedMessage {
  targetEntityId: string;
}

export interface CombatResultAccepted {
  accepted: true;
  actionId: string;
  targetEntityId: string;
  damage: number;
  remainingResource: number;
  cooldownEndsAtMs: number;
  defeated: boolean;
  abilityId?: string;
  slot?: "basic" | "ability_1" | "ability_2" | "ability_3" | "ability_4";
  effects?: CombatEffectFeedback[];
  movementLockedUntilMs?: number;
}

export interface CombatResultRejected {
  accepted: false;
  actionId: string;
  code: ErrorCode;
}

export type CombatResult = CombatResultAccepted | CombatResultRejected;

export interface DamageTakenMessage {
  amount: number;
  remainingHealth: number;
}

export type CombatControlState = "normal" | "rooted" | "stunned" | "casting";

export interface CombatStateMessage {
  serverTimeMs: number;
  resource: number;
  maximumResource: number;
  cooldowns: Record<string, number>;
  movementLockedUntilMs: number;
  controlState: CombatControlState;
  statuses: string[];
}

export type CombatEffectFeedback =
  | { kind: "damage"; amount: number }
  | { kind: "status"; statusId: string; durationMs: number }
  | { kind: "resource"; amount: number }
  | { kind: "interrupt" };

export interface CombatTelegraphMessage {
  entityId: string;
  abilityId: string;
  startTimeMs: number;
  durationMs: number;
  interruptible: boolean;
}

export interface RewardSummaryMessage {
  sourceMonsterId: string;
  items: { itemId: string; quantity: number }[];
}

export interface InteractionIntention {
  actionId: string;
  interactiveId: string;
}

export interface DialogueChoiceIntention {
  actionId: string;
  npcId: string;
  nodeId: string;
  choiceId: string;
}

export interface DialogueCloseIntention {
  actionId: string;
}

export interface DialogueNodeMessage {
  dialogueId: string;
  npcId: string;
  nodeId: string;
  speaker: string;
  text: string;
  choices: { id: string; label: string }[];
}

export type QuestStatus = "available" | "active" | "ready" | "completed";

export interface QuestStateMessage {
  questId: string;
  status: QuestStatus;
  progress: number;
  requiredCount: number;
  title: string;
  description: string;
  guidance: { label: string; targetId: string };
}

export interface QuestRewardMessage {
  questId: string;
  itemId: string;
  quantity: number;
  experience: number;
  currency: number;
}
