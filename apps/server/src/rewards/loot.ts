import type { LootDefinition } from "@gameish/content/combat";

export function rollPersonalLoot(
  loot: LootDefinition,
  rng: () => number,
): string {
  const totalWeight = loot.entries.reduce(
    (total, entry) => total + entry.weight,
    0,
  );
  const randomValue = rng();
  if (!Number.isFinite(randomValue)) {
    throw new Error("Loot random source returned a non-finite value");
  }
  let threshold =
    Math.min(0.999_999_999, Math.max(0, randomValue)) * totalWeight;
  for (const entry of loot.entries) {
    threshold -= entry.weight;
    if (threshold < 0) return entry.id;
  }
  return loot.entries[loot.entries.length - 1]!.id;
}
