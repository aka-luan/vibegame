import { z } from "zod";

const namespacedId = z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);

const displayData = z
  .object({ displayName: z.string().trim().min(1) })
  .strict();

const classDefinitionSchema = z
  .object({
    id: z.string().regex(/^class:[a-z][a-z0-9_]*$/),
    clientVisible: displayData,
    serverOnly: z
      .object({
        basicAttackId: z.string().regex(/^attack:[a-z][a-z0-9_]*$/),
        maximumResource: z.number().int().positive(),
        startingResource: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (
      definition.serverOnly.startingResource >
      definition.serverOnly.maximumResource
    ) {
      context.addIssue({
        code: "custom",
        path: ["serverOnly", "startingResource"],
        message: "Starting resource cannot exceed maximum resource",
      });
    }
  });

const basicAttackDefinitionSchema = z
  .object({
    id: z.string().regex(/^attack:[a-z][a-z0-9_]*$/),
    clientVisible: z
      .object({
        displayName: z.string().trim().min(1),
        animation: z.literal("attack_basic"),
      })
      .strict(),
    serverOnly: z
      .object({
        damage: z.number().int().positive(),
        range: z.number().positive(),
        cooldownMs: z.number().int().positive(),
        resourceCost: z.number().int().nonnegative(),
        actionRateLimitMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const monsterDefinitionSchema = z
  .object({
    id: z.string().regex(/^monster:[a-z][a-z0-9_]*$/),
    clientVisible: displayData,
    serverOnly: z
      .object({
        maxHealth: z.number().int().positive(),
        attackDamage: z.number().int().positive(),
        attackRange: z.number().positive(),
        attackCooldownMs: z.number().int().positive(),
        moveSpeed: z.number().positive(),
        aggroRange: z.number().positive(),
        leashRange: z.number().positive(),
        respawnMs: z.number().int().positive(),
        collision: z.object({
          width: z.number().positive(),
          height: z.number().positive(),
        }),
      })
      .strict(),
  })
  .strict();

const encounterDefinitionSchema = z
  .object({
    id: z.string().regex(/^encounter:[a-z][a-z0-9_]*$/),
    monsterId: z.string().regex(/^monster:[a-z][a-z0-9_]*$/),
    spawn: z.object({ x: z.number(), y: z.number() }),
  })
  .strict();

const lootDefinitionSchema = z
  .object({
    id: z.string().regex(/^loot:[a-z][a-z0-9_]*$/),
    monsterId: z.string().regex(/^monster:[a-z][a-z0-9_]*$/),
    entries: z
      .array(
        z.object({
          id: namespacedId,
          weight: z.number().positive(),
        }),
      )
      .min(1),
  })
  .strict();

export const combatCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    classes: z.array(classDefinitionSchema).min(1),
    attacks: z.array(basicAttackDefinitionSchema).min(1),
    monsters: z.array(monsterDefinitionSchema).min(1),
    encounters: z.array(encounterDefinitionSchema).min(1),
    loot: z.array(lootDefinitionSchema).min(1),
  })
  .strict()
  .superRefine((catalog, context) => {
    const checkUnique = (ids: string[], path: string) => {
      const seen = new Set<string>();
      ids.forEach((id, index) => {
        if (seen.has(id)) {
          context.addIssue({
            code: "custom",
            path: [path, index, "id"],
            message: `Duplicate combat identifier: ${id}`,
          });
        }
        seen.add(id);
      });
    };
    checkUnique(
      catalog.classes.map((definition) => definition.id),
      "classes",
    );
    checkUnique(
      catalog.attacks.map((definition) => definition.id),
      "attacks",
    );
    checkUnique(
      catalog.monsters.map((definition) => definition.id),
      "monsters",
    );
    checkUnique(
      catalog.encounters.map((definition) => definition.id),
      "encounters",
    );
    checkUnique(
      catalog.loot.map((definition) => definition.id),
      "loot",
    );

    const attacks = new Set(catalog.attacks.map((definition) => definition.id));
    const monsters = new Set(
      catalog.monsters.map((definition) => definition.id),
    );
    catalog.classes.forEach((definition, index) => {
      if (!attacks.has(definition.serverOnly.basicAttackId)) {
        context.addIssue({
          code: "custom",
          path: ["classes", index, "serverOnly", "basicAttackId"],
          message: `Class references an unknown attack: ${definition.serverOnly.basicAttackId}`,
        });
      }
    });
    catalog.encounters.forEach((definition, index) => {
      if (!monsters.has(definition.monsterId)) {
        context.addIssue({
          code: "custom",
          path: ["encounters", index, "monsterId"],
          message: `Encounter references an unknown monster: ${definition.monsterId}`,
        });
      }
    });
    catalog.loot.forEach((definition, index) => {
      if (!monsters.has(definition.monsterId)) {
        context.addIssue({
          code: "custom",
          path: ["loot", index, "monsterId"],
          message: `Loot references an unknown monster: ${definition.monsterId}`,
        });
      }
    });
  });

export type CombatCatalog = z.infer<typeof combatCatalogSchema>;
export type CombatClassDefinition = CombatCatalog["classes"][number];
export type BasicAttackDefinition = CombatCatalog["attacks"][number];
export type MonsterDefinition = CombatCatalog["monsters"][number];
export type EncounterDefinition = CombatCatalog["encounters"][number];
export type LootDefinition = CombatCatalog["loot"][number];

export interface ClientCombatCatalog {
  classes: { id: string; displayName: string; basicAttackId: string }[];
  attacks: { id: string; displayName: string; animation: "attack_basic" }[];
  monsters: { id: string; displayName: string }[];
}

export function compileClientCombatCatalog(
  catalog: CombatCatalog,
): ClientCombatCatalog {
  return {
    classes: catalog.classes.map((definition) => ({
      id: definition.id,
      displayName: definition.clientVisible.displayName,
      basicAttackId: definition.serverOnly.basicAttackId,
    })),
    attacks: catalog.attacks.map((definition) => ({
      id: definition.id,
      displayName: definition.clientVisible.displayName,
      animation: definition.clientVisible.animation,
    })),
    monsters: catalog.monsters.map((definition) => ({
      id: definition.id,
      displayName: definition.clientVisible.displayName,
    })),
  };
}

export interface CombatValidationIssue {
  path: string;
  message: string;
}

export type CombatValidationResult =
  { success: true } | { success: false; issues: CombatValidationIssue[] };

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") return `${formatted}[${String(segment)}]`;
    return formatted.length === 0
      ? String(segment)
      : `${formatted}.${String(segment)}`;
  }, "");
}

export function validateCombatCatalog(input: unknown): CombatValidationResult {
  const result = combatCatalogSchema.safeParse(input);
  if (result.success) return { success: true };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: formatPath(issue.path),
      message: issue.message,
    })),
  };
}
