import { z } from "zod";

const namespacedId = z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
const abilitySlot = z.enum([
  "ability_1",
  "ability_2",
  "ability_3",
  "ability_4",
]);
const displayData = z
  .object({ displayName: z.string().trim().min(1) })
  .strict();

const statusDefinitionSchema = z
  .object({
    id: z.string().regex(/^status:[a-z][a-z0-9_]*$/),
    clientVisible: displayData,
    serverOnly: z
      .object({
        durationMs: z.number().int().positive(),
        controlState: z.enum(["normal", "rooted", "stunned"]),
        movementMultiplier: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();

const effectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("damage"),
      amount: z.number().int().positive(),
      target: z.literal("target"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("apply_status"),
      statusId: z.string().regex(/^status:[a-z][a-z0-9_]*$/),
      target: z.enum(["target", "self"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restore_resource"),
      amount: z.number().int().positive(),
      target: z.literal("self"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interrupt"),
      target: z.literal("target"),
    })
    .strict(),
]);

const classDefinitionSchema = z
  .object({
    id: z.string().regex(/^class:[a-z][a-z0-9_]*$/),
    clientVisible: displayData,
    serverOnly: z
      .object({
        basicAttackId: z.string().regex(/^attack:[a-z][a-z0-9_]*$/),
        abilityIds: z
          .array(z.string().regex(/^ability:[a-z][a-z0-9_]*$/))
          .length(4),
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
    if (new Set(definition.serverOnly.abilityIds).size !== 4) {
      context.addIssue({
        code: "custom",
        path: ["serverOnly", "abilityIds"],
        message: "A class must provide four distinct abilities",
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
        feedback: z.string().trim().min(1),
      })
      .strict(),
    serverOnly: z
      .object({
        damage: z.number().int().positive(),
        range: z.number().positive(),
        cooldownMs: z.number().int().positive(),
        resourceCost: z.number().int().nonnegative(),
        actionRateLimitMs: z.number().int().positive(),
        castTimeMs: z.literal(0),
        recoveryMs: z.literal(0),
        movementLock: z.literal("none"),
      })
      .strict(),
  })
  .strict();

const abilityDefinitionSchema = z
  .object({
    id: z.string().regex(/^ability:[a-z][a-z0-9_]*$/),
    slot: abilitySlot,
    clientVisible: z
      .object({
        displayName: z.string().trim().min(1),
        animation: abilitySlot,
        feedback: z.string().trim().min(1),
      })
      .strict(),
    serverOnly: z
      .object({
        range: z.number().positive(),
        cooldownMs: z.number().int().positive(),
        resourceCost: z.number().int().nonnegative(),
        actionRateLimitMs: z.number().int().positive(),
        castTimeMs: z.number().int().nonnegative(),
        recoveryMs: z.number().int().nonnegative(),
        movementLock: z.enum(["none", "cast", "cast_and_recovery"]),
        effects: z.array(effectSchema).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    const expectedAnimation = definition.slot;
    if (definition.clientVisible.animation !== expectedAnimation) {
      context.addIssue({
        code: "custom",
        path: ["clientVisible", "animation"],
        message: `Ability animation must match its slot: ${expectedAnimation}`,
      });
    }
    if (
      definition.serverOnly.movementLock === "cast" &&
      definition.serverOnly.castTimeMs === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["serverOnly", "movementLock"],
        message: "Cast movement lock requires a cast time",
      });
    }
  });

const monsterActionDefinitionSchema = z
  .object({
    id: z.string().regex(/^monster_action:[a-z][a-z0-9_]*$/),
    clientVisible: displayData,
    serverOnly: z
      .object({
        damage: z.number().int().positive(),
        range: z.number().positive(),
        cooldownMs: z.number().int().positive(),
        castTimeMs: z.number().int().positive(),
        telegraphDurationMs: z.number().int().positive(),
        recoveryMs: z.number().int().nonnegative(),
        interruptible: z.boolean(),
        effects: z.array(effectSchema).min(1),
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
        behaviorProfile: z.enum(["melee", "telegraphed_boss"]),
        bossActionId: z
          .string()
          .regex(/^monster_action:[a-z][a-z0-9_]*$/)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    const isBoss = definition.serverOnly.behaviorProfile === "telegraphed_boss";
    if (isBoss && !definition.serverOnly.bossActionId) {
      context.addIssue({
        code: "custom",
        path: ["serverOnly", "bossActionId"],
        message: "Telegraphed boss monsters require a boss action",
      });
    }
    if (!isBoss && definition.serverOnly.bossActionId) {
      context.addIssue({
        code: "custom",
        path: ["serverOnly", "bossActionId"],
        message: "Only telegraphed boss monsters may define a boss action",
      });
    }
  });

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
    abilities: z.array(abilityDefinitionSchema).length(4),
    statuses: z.array(statusDefinitionSchema).min(1),
    monsterActions: z.array(monsterActionDefinitionSchema).min(1),
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
      catalog.abilities.map((definition) => definition.id),
      "abilities",
    );
    const slots = new Set<string>();
    catalog.abilities.forEach((definition, index) => {
      if (slots.has(definition.slot)) {
        context.addIssue({
          code: "custom",
          path: ["abilities", index, "slot"],
          message: `Duplicate ability slot: ${definition.slot}`,
        });
      }
      slots.add(definition.slot);
    });
    checkUnique(
      catalog.statuses.map((definition) => definition.id),
      "statuses",
    );
    checkUnique(
      catalog.monsterActions.map((definition) => definition.id),
      "monsterActions",
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
    const abilities = new Set(
      catalog.abilities.map((definition) => definition.id),
    );
    const statuses = new Set(
      catalog.statuses.map((definition) => definition.id),
    );
    const monsterActions = new Set(
      catalog.monsterActions.map((definition) => definition.id),
    );
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
      definition.serverOnly.abilityIds.forEach((abilityId, abilityIndex) => {
        if (!abilities.has(abilityId)) {
          context.addIssue({
            code: "custom",
            path: ["classes", index, "serverOnly", "abilityIds", abilityIndex],
            message: `Class references an unknown ability: ${abilityId}`,
          });
        }
      });
    });
    catalog.abilities.forEach((definition, index) => {
      definition.serverOnly.effects.forEach((effect, effectIndex) => {
        if (effect.kind === "apply_status" && !statuses.has(effect.statusId)) {
          context.addIssue({
            code: "custom",
            path: [
              "abilities",
              index,
              "serverOnly",
              "effects",
              effectIndex,
              "statusId",
            ],
            message: `Ability references an unknown status: ${effect.statusId}`,
          });
        }
      });
    });
    catalog.monsterActions.forEach((definition, index) => {
      definition.serverOnly.effects.forEach((effect, effectIndex) => {
        if (effect.kind === "apply_status" && !statuses.has(effect.statusId)) {
          context.addIssue({
            code: "custom",
            path: [
              "monsterActions",
              index,
              "serverOnly",
              "effects",
              effectIndex,
              "statusId",
            ],
            message: `Monster action references an unknown status: ${effect.statusId}`,
          });
        }
      });
    });
    catalog.monsters.forEach((definition, index) => {
      if (
        definition.serverOnly.bossActionId &&
        !monsterActions.has(definition.serverOnly.bossActionId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["monsters", index, "serverOnly", "bossActionId"],
          message: `Monster references an unknown boss action: ${definition.serverOnly.bossActionId}`,
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
export type AbilityDefinition = CombatCatalog["abilities"][number];
export type StatusDefinition = CombatCatalog["statuses"][number];
export type MonsterActionDefinition = CombatCatalog["monsterActions"][number];
export type MonsterDefinition = CombatCatalog["monsters"][number];
export type EncounterDefinition = CombatCatalog["encounters"][number];
export type LootDefinition = CombatCatalog["loot"][number];
export type CombatEffect = z.infer<typeof effectSchema>;

export interface ClientCombatCatalog {
  classes: {
    id: string;
    displayName: string;
    basicAttackId: string;
    abilityIds: string[];
  }[];
  attacks: {
    id: string;
    displayName: string;
    animation: "attack_basic";
    feedback: string;
  }[];
  abilities: {
    id: string;
    slot: z.infer<typeof abilitySlot>;
    displayName: string;
    animation: z.infer<typeof abilitySlot>;
    feedback: string;
  }[];
  statuses: { id: string; displayName: string }[];
  monsters: { id: string; displayName: string }[];
  monsterActions: { id: string; displayName: string }[];
}

export function compileClientCombatCatalog(
  catalog: CombatCatalog,
): ClientCombatCatalog {
  return {
    classes: catalog.classes.map((definition) => ({
      id: definition.id,
      displayName: definition.clientVisible.displayName,
      basicAttackId: definition.serverOnly.basicAttackId,
      abilityIds: [...definition.serverOnly.abilityIds],
    })),
    attacks: catalog.attacks.map((definition) => ({
      id: definition.id,
      displayName: definition.clientVisible.displayName,
      animation: definition.clientVisible.animation,
      feedback: definition.clientVisible.feedback,
    })),
    abilities: catalog.abilities.map((definition) => ({
      id: definition.id,
      slot: definition.slot,
      displayName: definition.clientVisible.displayName,
      animation: definition.clientVisible.animation,
      feedback: definition.clientVisible.feedback,
    })),
    statuses: catalog.statuses.map((definition) => ({
      id: definition.id,
      displayName: definition.clientVisible.displayName,
    })),
    monsters: catalog.monsters.map((definition) => ({
      id: definition.id,
      displayName: definition.clientVisible.displayName,
    })),
    monsterActions: catalog.monsterActions.map((definition) => ({
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
