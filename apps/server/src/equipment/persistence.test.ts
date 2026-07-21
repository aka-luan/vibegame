import { randomUUID } from "node:crypto";

import type { DurableEquipmentItem } from "@gameish/database";

import { InMemoryEquipmentPersistence } from "./persistence.js";
import { runEquipmentPersistenceContract } from "./persistence-contract.js";

const rigId = "rig:equipment_persistence_contract";
const classId = "class:equipment_persistence_contract";

function contractItem(
  overrides: Partial<DurableEquipmentItem> & { itemId: string },
): DurableEquipmentItem {
  return {
    slot: "body",
    rigId,
    layerId: overrides.itemId,
    requirements: {},
    ...overrides,
  };
}

runEquipmentPersistenceContract("in-memory", ({ level }) => {
  const equippedItem = contractItem({
    itemId: "item:equipment_persistence_contract_equipped",
  });
  const replacementItem = contractItem({
    itemId: "item:equipment_persistence_contract_replacement",
  });
  const unownedItem = contractItem({
    itemId: "item:equipment_persistence_contract_unowned",
  });
  const wrongRigItem = contractItem({
    itemId: "item:equipment_persistence_contract_wrong_rig",
    rigId: "rig:equipment_persistence_contract_other",
  });
  const levelLockedItem = contractItem({
    itemId: "item:equipment_persistence_contract_level_locked",
    requirements: { minimumLevel: 2 },
  });

  const persistence = new InMemoryEquipmentPersistence({
    appearance: {
      rigId,
      baseLayerId: "base",
      armorLayerId: equippedItem.layerId,
    },
    inventory: [
      { itemId: equippedItem.itemId, quantity: 1 },
      { itemId: replacementItem.itemId, quantity: 1 },
      { itemId: wrongRigItem.itemId, quantity: 1 },
      { itemId: levelLockedItem.itemId, quantity: 1 },
    ],
    equipment: [{ slot: "body", itemId: equippedItem.itemId }],
    context: { classId, level },
  });

  return Promise.resolve({
    persistence,
    characterId: `character:contract-${randomUUID()}`,
    equippedItem,
    replacementItem,
    unownedItem,
    wrongRigItem,
    levelLockedItem,
  });
});
