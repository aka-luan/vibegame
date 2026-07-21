import { describe, expect, it } from "vitest";

import type {
  DurableEquipmentItem,
  DurableEquipmentSnapshot,
  EquipmentRulesContext,
} from "@gameish/database";

import { decideEquip, decideUnequip } from "./rules.js";

const context: EquipmentRulesContext = {
  classId: "class:trailwarden",
  level: 1,
};

const item: DurableEquipmentItem = {
  itemId: "item:canopy_vest",
  slot: "body",
  rigId: "rig:village_placeholder",
  layerId: "vest",
  requirements: {},
};

const snapshot = (): DurableEquipmentSnapshot => ({
  characterRevision: 0,
  appearanceRevision: 0,
  appearance: {
    rigId: "rig:village_placeholder",
    baseLayerId: "base",
    armorLayerId: "tunic",
  },
  inventory: [{ itemId: "item:trailwarden_tunic", quantity: 1 }],
  equipment: [{ slot: "body", itemId: "item:trailwarden_tunic" }],
});

describe("decideEquip", () => {
  it("rejects a stale expected revision", () => {
    const result = decideEquip(snapshot(), context, {
      item,
      expectedCharacterRevision: 1,
    });
    expect(result).toMatchObject({ applied: false, reason: "stale_revision" });
  });

  it("rejects an item the character does not own", () => {
    const result = decideEquip(snapshot(), context, {
      item,
      expectedCharacterRevision: 0,
    });
    expect(result).toMatchObject({
      applied: false,
      reason: "item_not_owned",
    });
  });

  it("rejects an item built for a different rig", () => {
    const owned = {
      ...snapshot(),
      inventory: [{ itemId: item.itemId, quantity: 1 }],
    };
    const result = decideEquip(owned, context, {
      item: { ...item, rigId: "rig:other" },
      expectedCharacterRevision: 0,
    });
    expect(result).toMatchObject({
      applied: false,
      reason: "incompatible_item",
    });
  });

  it("rejects an item whose class requirement is unmet", () => {
    const owned = {
      ...snapshot(),
      inventory: [{ itemId: item.itemId, quantity: 1 }],
    };
    const result = decideEquip(owned, context, {
      item: { ...item, requirements: { classId: "class:other" } },
      expectedCharacterRevision: 0,
    });
    expect(result).toMatchObject({
      applied: false,
      reason: "requirements_not_met",
    });
  });

  it("rejects an item whose level requirement is unmet, and accepts it once the level is met", () => {
    const owned = {
      ...snapshot(),
      inventory: [{ itemId: item.itemId, quantity: 1 }],
    };
    const gatedItem = { ...item, requirements: { minimumLevel: 2 } };

    const belowLevel = decideEquip(owned, context, {
      item: gatedItem,
      expectedCharacterRevision: 0,
    });
    expect(belowLevel).toMatchObject({
      applied: false,
      reason: "requirements_not_met",
    });

    const atLevel = decideEquip(
      owned,
      { ...context, level: 2 },
      { item: gatedItem, expectedCharacterRevision: 0 },
    );
    expect(atLevel).toMatchObject({
      applied: true,
      snapshot: {
        equipment: [{ slot: "body", itemId: gatedItem.itemId }],
        appearance: { armorLayerId: gatedItem.layerId },
      },
    });
  });

  it("rejects re-equipping the already-equipped item", () => {
    const owned = {
      ...snapshot(),
      inventory: [
        { itemId: "item:trailwarden_tunic", quantity: 1 },
        { itemId: item.itemId, quantity: 1 },
      ],
    };
    const result = decideEquip(owned, context, {
      item: { ...item, itemId: "item:trailwarden_tunic", layerId: "tunic" },
      expectedCharacterRevision: 0,
    });
    expect(result).toMatchObject({
      applied: false,
      reason: "already_equipped",
    });
  });

  it("equips a compatible owned item, replacing the previous armor layer and bumping both revisions", () => {
    const owned = {
      ...snapshot(),
      inventory: [
        { itemId: "item:trailwarden_tunic", quantity: 1 },
        { itemId: item.itemId, quantity: 1 },
      ],
    };
    const result = decideEquip(owned, context, {
      item,
      expectedCharacterRevision: 0,
    });
    expect(result).toMatchObject({
      applied: true,
      snapshot: {
        characterRevision: 1,
        appearanceRevision: 1,
        appearance: { armorLayerId: item.layerId },
        equipment: [{ slot: "body", itemId: item.itemId }],
      },
    });
  });
});

describe("decideUnequip", () => {
  it("rejects a stale expected revision", () => {
    const result = decideUnequip(snapshot(), context, {
      slot: "body",
      expectedCharacterRevision: 1,
    });
    expect(result).toMatchObject({ applied: false, reason: "stale_revision" });
  });

  it("rejects unequipping an empty slot", () => {
    const empty = { ...snapshot(), equipment: [] };
    const result = decideUnequip(empty, context, {
      slot: "body",
      expectedCharacterRevision: 0,
    });
    expect(result).toMatchObject({ applied: false, reason: "not_equipped" });
  });

  it("unequips, clearing the armor layer and bumping both revisions", () => {
    const result = decideUnequip(snapshot(), context, {
      slot: "body",
      expectedCharacterRevision: 0,
    });
    expect(result).toMatchObject({
      applied: true,
      snapshot: {
        characterRevision: 1,
        appearanceRevision: 1,
        appearance: { armorLayerId: "" },
        equipment: [],
      },
    });
  });
});
