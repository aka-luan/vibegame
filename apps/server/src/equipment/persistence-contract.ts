import { describe, expect, it } from "vitest";

import type { DurableEquipmentItem } from "@gameish/database";

import type { EquipmentPersistence } from "./persistence.js";

/**
 * Shared behavioral contract for {@link EquipmentPersistence} implementations.
 * Run the same set of cases against every adapter (in-memory, Postgres, ...)
 * so the decider-driven equip/unequip rules in `rules.ts` behave identically
 * regardless of storage.
 */
export interface EquipmentPersistenceContractHarness {
  persistence: EquipmentPersistence;
  characterId: string;
  /** Already equipped and owned at load time; used for the already_equipped case. */
  equippedItem: DurableEquipmentItem;
  /** Owned, rig-compatible, no unmet requirements; used for a successful replace. */
  replacementItem: DurableEquipmentItem;
  /** Never granted to the character; used for the item_not_owned case. */
  unownedItem: DurableEquipmentItem;
  /** Owned, but built for a rig other than the character's; used for incompatible_item. */
  wrongRigItem: DurableEquipmentItem;
  /**
   * Owned, requiring a level higher than 1; used to prove requirements are
   * rejected below the required level and accepted at or above it.
   */
  levelLockedItem: DurableEquipmentItem;
  /** Torn down once this harness is no longer needed. */
  cleanup?: () => Promise<void>;
}

export function runEquipmentPersistenceContract(
  name: string,
  makeHarness: (options: {
    level: number;
  }) => Promise<EquipmentPersistenceContractHarness>,
): void {
  describe(`EquipmentPersistence contract: ${name}`, () => {
    it("rejects equip with a stale expected revision", async () => {
      const harness = await makeHarness({ level: 1 });
      try {
        const initial = await harness.persistence.load(harness.characterId);
        const result = await harness.persistence.equipItem({
          characterId: harness.characterId,
          item: harness.replacementItem,
          expectedCharacterRevision: initial.characterRevision + 1,
          now: new Date(),
        });
        expect(result).toMatchObject({
          applied: false,
          reason: "stale_revision",
        });
      } finally {
        await harness.cleanup?.();
      }
    });

    it("rejects equipping an item the character does not own", async () => {
      const harness = await makeHarness({ level: 1 });
      try {
        const initial = await harness.persistence.load(harness.characterId);
        const result = await harness.persistence.equipItem({
          characterId: harness.characterId,
          item: harness.unownedItem,
          expectedCharacterRevision: initial.characterRevision,
          now: new Date(),
        });
        expect(result).toMatchObject({
          applied: false,
          reason: "item_not_owned",
        });
      } finally {
        await harness.cleanup?.();
      }
    });

    it("rejects equipping an owned item built for a different rig", async () => {
      const harness = await makeHarness({ level: 1 });
      try {
        const initial = await harness.persistence.load(harness.characterId);
        const result = await harness.persistence.equipItem({
          characterId: harness.characterId,
          item: harness.wrongRigItem,
          expectedCharacterRevision: initial.characterRevision,
          now: new Date(),
        });
        expect(result).toMatchObject({
          applied: false,
          reason: "incompatible_item",
        });
      } finally {
        await harness.cleanup?.();
      }
    });

    it("rejects re-equipping the currently equipped item as already_equipped", async () => {
      const harness = await makeHarness({ level: 1 });
      try {
        const initial = await harness.persistence.load(harness.characterId);
        const result = await harness.persistence.equipItem({
          characterId: harness.characterId,
          item: harness.equippedItem,
          expectedCharacterRevision: initial.characterRevision,
          now: new Date(),
        });
        expect(result).toMatchObject({
          applied: false,
          reason: "already_equipped",
        });
      } finally {
        await harness.cleanup?.();
      }
    });

    it("equips a compatible owned item, applying exactly one revision bump", async () => {
      const harness = await makeHarness({ level: 1 });
      try {
        const initial = await harness.persistence.load(harness.characterId);
        const result = await harness.persistence.equipItem({
          characterId: harness.characterId,
          item: harness.replacementItem,
          expectedCharacterRevision: initial.characterRevision,
          now: new Date(),
        });
        expect(result).toMatchObject({
          applied: true,
          snapshot: {
            characterRevision: initial.characterRevision + 1,
            appearanceRevision: initial.appearanceRevision + 1,
            appearance: { armorLayerId: harness.replacementItem.layerId },
            equipment: [
              { slot: "body", itemId: harness.replacementItem.itemId },
            ],
          },
        });
      } finally {
        await harness.cleanup?.();
      }
    });

    it("rejects unequip when the slot is empty", async () => {
      const harness = await makeHarness({ level: 1 });
      try {
        const initial = await harness.persistence.load(harness.characterId);
        await harness.persistence.unequipItem({
          characterId: harness.characterId,
          slot: "body",
          expectedCharacterRevision: initial.characterRevision,
          now: new Date(),
        });
        const afterUnequip = await harness.persistence.load(
          harness.characterId,
        );
        const result = await harness.persistence.unequipItem({
          characterId: harness.characterId,
          slot: "body",
          expectedCharacterRevision: afterUnequip.characterRevision,
          now: new Date(),
        });
        expect(result).toMatchObject({
          applied: false,
          reason: "not_equipped",
        });
      } finally {
        await harness.cleanup?.();
      }
    });

    it("unequips, applying exactly one revision bump", async () => {
      const harness = await makeHarness({ level: 1 });
      try {
        const initial = await harness.persistence.load(harness.characterId);
        const result = await harness.persistence.unequipItem({
          characterId: harness.characterId,
          slot: "body",
          expectedCharacterRevision: initial.characterRevision,
          now: new Date(),
        });
        expect(result).toMatchObject({
          applied: true,
          snapshot: {
            characterRevision: initial.characterRevision + 1,
            appearanceRevision: initial.appearanceRevision + 1,
            appearance: { armorLayerId: "" },
            equipment: [],
          },
        });
      } finally {
        await harness.cleanup?.();
      }
    });

    it("rejects a level-gated item below the required level, and accepts it once the level is met", async () => {
      const belowLevel = await makeHarness({ level: 1 });
      try {
        const initial = await belowLevel.persistence.load(
          belowLevel.characterId,
        );
        const rejected = await belowLevel.persistence.equipItem({
          characterId: belowLevel.characterId,
          item: belowLevel.levelLockedItem,
          expectedCharacterRevision: initial.characterRevision,
          now: new Date(),
        });
        expect(rejected).toMatchObject({
          applied: false,
          reason: "requirements_not_met",
        });
      } finally {
        await belowLevel.cleanup?.();
      }

      const atLevel = await makeHarness({ level: 2 });
      try {
        const initial = await atLevel.persistence.load(atLevel.characterId);
        const accepted = await atLevel.persistence.equipItem({
          characterId: atLevel.characterId,
          item: atLevel.levelLockedItem,
          expectedCharacterRevision: initial.characterRevision,
          now: new Date(),
        });
        expect(accepted).toMatchObject({
          applied: true,
          snapshot: {
            equipment: [
              { slot: "body", itemId: atLevel.levelLockedItem.itemId },
            ],
          },
        });
      } finally {
        await atLevel.cleanup?.();
      }
    });
  });
}
