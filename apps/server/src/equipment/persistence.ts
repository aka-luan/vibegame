import type {
  DurableEquipmentItem,
  DurableEquipmentMutationResult,
  DurableEquipmentSnapshot,
  DurableStateRepository,
} from "@gameish/database";

export interface EquipmentAppearance {
  rigId: string;
  baseLayerId: string;
  armorLayerId: string;
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

  load(characterId: string): Promise<DurableEquipmentSnapshot> {
    return this.repository.loadEquipment(characterId);
  }

  equipItem(input: {
    characterId: string;
    item: DurableEquipmentItem;
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    return this.repository.equipItem(input);
  }

  unequipItem(input: {
    characterId: string;
    slot: "body";
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    return this.repository.unequipItem(input);
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

  load(
    characterId: string,
    initialAppearance: EquipmentAppearance = {
      rigId: "rig:village_placeholder",
      baseLayerId: "base",
      armorLayerId: "tunic",
    },
  ): Promise<DurableEquipmentSnapshot> {
    const existing = this.#snapshots.get(characterId);
    if (existing) return Promise.resolve(cloneSnapshot(existing));
    const snapshot: DurableEquipmentSnapshot = {
      characterRevision: 0,
      appearanceRevision: 0,
      appearance: { ...initialAppearance },
      inventory: [{ itemId: "item:trailwarden_tunic", quantity: 1 }],
      equipment: [{ slot: "body", itemId: "item:trailwarden_tunic" }],
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
    if (snapshot.characterRevision !== input.expectedCharacterRevision) {
      return rejected(snapshot, "stale_revision");
    }
    const owned = snapshot.inventory.find(
      (entry) => entry.itemId === input.item.itemId,
    );
    if (!owned || owned.quantity <= 0)
      return rejected(snapshot, "item_not_owned");
    if (input.item.rigId !== snapshot.appearance.rigId) {
      return rejected(snapshot, "incompatible_item");
    }
    if (
      input.item.requirements.classId !== undefined &&
      input.item.requirements.classId !== "class:trailwarden"
    ) {
      return rejected(snapshot, "requirements_not_met");
    }
    if ((input.item.requirements.minimumLevel ?? 1) > 1) {
      return rejected(snapshot, "requirements_not_met");
    }
    const current = snapshot.equipment.find(
      (entry) => entry.slot === input.item.slot,
    );
    if (current?.itemId === input.item.itemId) {
      return rejected(snapshot, "already_equipped");
    }
    snapshot.equipment = snapshot.equipment.filter(
      (entry) => entry.slot !== input.item.slot,
    );
    snapshot.equipment.push({
      slot: input.item.slot,
      itemId: input.item.itemId,
    });
    snapshot.appearance.armorLayerId = input.item.layerId;
    snapshot.characterRevision += 1;
    snapshot.appearanceRevision += 1;
    this.#snapshots.set(input.characterId, snapshot);
    return { applied: true, snapshot: cloneSnapshot(snapshot) };
  }

  async unequipItem(input: {
    characterId: string;
    slot: "body";
    expectedCharacterRevision: number;
    now: Date;
  }): Promise<DurableEquipmentMutationResult> {
    void input.now;
    const snapshot = await this.load(input.characterId);
    if (snapshot.characterRevision !== input.expectedCharacterRevision) {
      return rejected(snapshot, "stale_revision");
    }
    const equipped = snapshot.equipment.some(
      (entry) => entry.slot === input.slot,
    );
    if (!equipped) return rejected(snapshot, "not_equipped");
    snapshot.equipment = snapshot.equipment.filter(
      (entry) => entry.slot !== input.slot,
    );
    snapshot.appearance.armorLayerId = "";
    snapshot.characterRevision += 1;
    snapshot.appearanceRevision += 1;
    this.#snapshots.set(input.characterId, snapshot);
    return { applied: true, snapshot: cloneSnapshot(snapshot) };
  }
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

function rejected(
  snapshot: DurableEquipmentSnapshot,
  reason: Extract<DurableEquipmentMutationResult, { applied: false }>["reason"],
): DurableEquipmentMutationResult {
  return { applied: false, reason, snapshot: cloneSnapshot(snapshot) };
}
