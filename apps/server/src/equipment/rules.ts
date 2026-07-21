import type {
  DurableEquipmentItem,
  DurableEquipmentMutationResult,
  DurableEquipmentSnapshot,
  EquipItemRequest,
  EquipmentDecider,
  EquipmentRulesContext,
  UnequipItemRequest,
} from "@gameish/database";

/**
 * The single equip decision. No I/O, no `Date`, no SQL: every persistence
 * adapter (Postgres, in-memory) applies this decision instead of
 * re-deriving it. Requirements come from the item definition supplied by
 * the caller (sourced from the content catalog), never from a literal.
 */
export function decideEquip(
  snapshot: DurableEquipmentSnapshot,
  context: EquipmentRulesContext,
  request: EquipItemRequest,
): DurableEquipmentMutationResult {
  const { item, expectedCharacterRevision } = request;
  if (snapshot.characterRevision !== expectedCharacterRevision) {
    return rejected(snapshot, "stale_revision");
  }
  const owned = snapshot.inventory.find(
    (entry) => entry.itemId === item.itemId,
  );
  if (!owned || owned.quantity <= 0) {
    return rejected(snapshot, "item_not_owned");
  }
  if (item.rigId !== snapshot.appearance.rigId || item.slot !== "body") {
    return rejected(snapshot, "incompatible_item");
  }
  if (!meetsRequirements(item, context)) {
    return rejected(snapshot, "requirements_not_met");
  }
  const existing = snapshot.equipment.find((entry) => entry.slot === item.slot);
  if (existing?.itemId === item.itemId) {
    return rejected(snapshot, "already_equipped");
  }
  const equipment = snapshot.equipment.filter(
    (entry) => entry.slot !== item.slot,
  );
  equipment.push({ slot: item.slot, itemId: item.itemId });
  return {
    applied: true,
    snapshot: {
      ...snapshot,
      appearance: { ...snapshot.appearance, armorLayerId: item.layerId },
      equipment,
      characterRevision: snapshot.characterRevision + 1,
      appearanceRevision: snapshot.appearanceRevision + 1,
    },
  };
}

/**
 * The single unequip decision. Mirrors {@link decideEquip}: pure, no I/O.
 */
export function decideUnequip(
  snapshot: DurableEquipmentSnapshot,
  context: EquipmentRulesContext,
  request: UnequipItemRequest,
): DurableEquipmentMutationResult {
  void context;
  const { slot, expectedCharacterRevision } = request;
  if (snapshot.characterRevision !== expectedCharacterRevision) {
    return rejected(snapshot, "stale_revision");
  }
  const equipped = snapshot.equipment.some((entry) => entry.slot === slot);
  if (!equipped) return rejected(snapshot, "not_equipped");
  return {
    applied: true,
    snapshot: {
      ...snapshot,
      appearance: { ...snapshot.appearance, armorLayerId: "" },
      equipment: snapshot.equipment.filter((entry) => entry.slot !== slot),
      characterRevision: snapshot.characterRevision + 1,
      appearanceRevision: snapshot.appearanceRevision + 1,
    },
  };
}

/**
 * The single {@link EquipmentDecider} instance, satisfying the
 * `@gameish/database` contract structurally. Persistence adapters inject
 * this per call; it is never baked into a constructor.
 */
export const equipmentDecider: EquipmentDecider = {
  decideEquip,
  decideUnequip,
};

function meetsRequirements(
  item: DurableEquipmentItem,
  context: EquipmentRulesContext,
): boolean {
  if (
    item.requirements.classId !== undefined &&
    item.requirements.classId !== context.classId
  ) {
    return false;
  }
  return (
    item.requirements.minimumLevel === undefined ||
    context.level >= item.requirements.minimumLevel
  );
}

function rejected(
  snapshot: DurableEquipmentSnapshot,
  reason: Extract<DurableEquipmentMutationResult, { applied: false }>["reason"],
): DurableEquipmentMutationResult {
  return { applied: false, reason, snapshot };
}
