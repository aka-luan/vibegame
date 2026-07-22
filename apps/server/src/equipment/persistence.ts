import type {
  DurableEquipmentItem,
  DurableEquipmentMutationResult,
  DurableEquipmentSlot,
  DurableEquipmentSnapshot,
  DurableStateRepository,
  EquipmentRulesContext,
} from "@gameish/database";

import { decideEquip, decideUnequip, equipmentDecider } from "./rules.js";

export interface EquipmentAppearance {
  rigId: string;
  baseLayerId: string;
  armorLayerId: string;
}

export interface EquipmentSeed {
  appearance: EquipmentAppearance;
  inventory: { itemId: string; quantity: number }[];
  equipment: { slot: DurableEquipmentSlot; itemId: string }[];
  /** Character facts the rules decider needs to judge item requirements. */
  context: EquipmentRulesContext;
}

export interface EquipmentPersistence {
  load(
    characterId: string,
    initialAppearance?: EquipmentAppearance,
  ): Promise<DurableEquipmentSnapshot>;
  equipItem(input: {
    characterId: string;
    item: DurableEquipmentItem;
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult>;
  unequipItem(input: {
    characterId: string;
    slot: "body";
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult>;
}

export class PostgresEquipmentPersistence implements EquipmentPersistence {
  constructor(readonly repository: DurableStateRepository) {}

  load(
    characterId: string,
    initialAppearance?: EquipmentAppearance,
  ): Promise<DurableEquipmentSnapshot> {
    void initialAppearance;
    return this.repository.loadEquipment(characterId);
  }

  equipItem(input: {
    characterId: string;
    item: DurableEquipmentItem;
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    return this.repository.equipItem({ ...input, decide: equipmentDecider });
  }

  unequipItem(input: {
    characterId: string;
    slot: "body";
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    return this.repository.unequipItem({
      ...input,
      decide: equipmentDecider,
    });
  }
}

export class UnavailableEquipmentPersistence implements EquipmentPersistence {
  load(): Promise<DurableEquipmentSnapshot> {
    return Promise.reject(new Error("Equipment persistence is not configured"));
  }

  equipItem(): Promise<DurableEquipmentMutationResult> {
    return Promise.reject(new Error("Equipment persistence is not configured"));
  }

  unequipItem(): Promise<DurableEquipmentMutationResult> {
    return Promise.reject(new Error("Equipment persistence is not configured"));
  }
}

export class InMemoryEquipmentPersistence implements EquipmentPersistence {
  readonly #snapshots = new Map<string, DurableEquipmentSnapshot>();

  constructor(readonly seed: EquipmentSeed) {}

  load(
    characterId: string,
    initialAppearance: EquipmentAppearance = this.seed.appearance,
  ): Promise<DurableEquipmentSnapshot> {
    const existing = this.#snapshots.get(characterId);
    if (existing) return Promise.resolve(cloneSnapshot(existing));
    const snapshot: DurableEquipmentSnapshot = {
      characterRevision: 0,
      appearanceRevision: 0,
      appearance: { ...initialAppearance },
      inventory: this.seed.inventory.map((item) => ({ ...item })),
      equipment: this.seed.equipment.map((item) => ({ ...item })),
    };
    this.#snapshots.set(characterId, snapshot);
    return Promise.resolve(cloneSnapshot(snapshot));
  }

  async equipItem(input: {
    characterId: string;
    item: DurableEquipmentItem;
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    void input.now;
    const snapshot = await this.load(input.characterId);
    const result = decideEquip(snapshot, this.seed.context, {
      item: input.item,
      expectedCharacterRevision: input.expectedCharacterRevision,
    });
    if (result.applied) this.#snapshots.set(input.characterId, result.snapshot);
    return withClonedSnapshot(result);
  }

  async unequipItem(input: {
    characterId: string;
    slot: DurableEquipmentSlot;
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    void input.now;
    const snapshot = await this.load(input.characterId);
    const result = decideUnequip(snapshot, this.seed.context, {
      slot: input.slot,
      expectedCharacterRevision: input.expectedCharacterRevision,
    });
    if (result.applied) this.#snapshots.set(input.characterId, result.snapshot);
    return withClonedSnapshot(result);
  }
}

function withClonedSnapshot(
  result: DurableEquipmentMutationResult,
): DurableEquipmentMutationResult {
  if (result.applied) {
    return { applied: true, snapshot: cloneSnapshot(result.snapshot) };
  }
  return {
    applied: false,
    reason: result.reason,
    snapshot: cloneSnapshot(result.snapshot),
  };
}

function cloneSnapshot(
  snapshot: DurableEquipmentSnapshot,
): DurableEquipmentSnapshot {
  return {
    characterRevision: snapshot.characterRevision,
    appearanceRevision: snapshot.appearanceRevision,
    appearance: { ...snapshot.appearance },
    inventory: snapshot.inventory.map((item) => ({ ...item })),
    equipment: snapshot.equipment.map((item) => ({ ...item })),
  };
}
