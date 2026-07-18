export const ERROR_CODES = {
  databaseUnavailable: "DATABASE_UNAVAILABLE",
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

export interface PublicPlayerPresence {
  entityId: string;
  displayName: string;
  x: number;
  y: number;
  facing: "east" | "west";
  animation: "idle" | "walk";
  appearance: PublicAppearance;
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

export interface PublicMonsterPresence {
  entityId: string;
  displayName: string;
  x: number;
  y: number;
  animation: PublicMonsterAnimation;
  healthFraction: number;
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
