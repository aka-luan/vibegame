import type { StatusDefinition } from "@gameish/content/combat";
import type { CombatControlState } from "@gameish/protocol";

export interface ActiveCombatStatus {
  statusId: string;
  expiresAtMs: number;
}

export function applyCombatStatus(
  statuses: Map<string, ActiveCombatStatus>,
  definition: StatusDefinition,
  nowMs: number,
): ActiveCombatStatus {
  const active = {
    statusId: definition.id,
    expiresAtMs: nowMs + definition.serverOnly.durationMs,
  };
  statuses.set(definition.id, active);
  return active;
}

export function expireCombatStatuses(
  statuses: Map<string, ActiveCombatStatus>,
  nowMs: number,
): void {
  for (const [statusId, status] of statuses) {
    if (status.expiresAtMs <= nowMs) statuses.delete(statusId);
  }
}

export function combatControlState(
  statuses: ReadonlyMap<string, ActiveCombatStatus>,
  definitions: readonly StatusDefinition[],
): CombatControlState {
  let state: CombatControlState = "normal";
  for (const status of statuses.values()) {
    const definition = definitions.find(
      (candidate) => candidate.id === status.statusId,
    );
    if (!definition) continue;
    if (definition.serverOnly.controlState === "stunned") return "stunned";
    if (definition.serverOnly.controlState === "rooted") state = "rooted";
  }
  return state;
}
