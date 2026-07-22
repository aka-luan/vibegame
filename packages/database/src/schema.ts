import { sql } from "drizzle-orm";
import {
  integer,
  pgTable,
  primaryKey,
  check,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

function timestamps() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  };
}

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  ...timestamps(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull(),
    ...timestamps(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }).notNull(),
    selectedCharacterId: text("selected_character_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("sessions_secret_hash_unique").on(table.secretHash)],
);

export const characters = pgTable(
  "characters",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    creationRequestId: text("creation_request_id").notNull(),
    revision: integer("revision").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("characters_user_name_unique").on(
      table.userId,
      table.normalizedName,
    ),
    uniqueIndex("characters_user_creation_request_unique").on(
      table.userId,
      table.creationRequestId,
    ),
  ],
);

export const characterAppearance = pgTable("character_appearance", {
  characterId: text("character_id")
    .primaryKey()
    .references(() => characters.id, { onDelete: "cascade" }),
  rigId: text("rig_id").notNull(),
  baseLayerId: text("base_layer_id").notNull(),
  armorLayerId: text("armor_layer_id").notNull(),
  appearanceRevision: integer("appearance_revision").notNull().default(0),
  ...timestamps(),
});

export const characterProgression = pgTable(
  "character_progression",
  {
    characterId: text("character_id")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    level: integer("level").notNull().default(1),
    experience: integer("experience").notNull().default(0),
    currency: integer("currency").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    check("character_progression_level_positive", sql`${table.level} > 0`),
    check(
      "character_progression_experience_nonnegative",
      sql`${table.experience} >= 0`,
    ),
    check(
      "character_progression_currency_nonnegative",
      sql`${table.currency} >= 0`,
    ),
  ],
);

export const characterLoadouts = pgTable("character_loadouts", {
  characterId: text("character_id")
    .primaryKey()
    .references(() => characters.id, { onDelete: "cascade" }),
  contentVersion: text("content_version").notNull(),
  classId: text("class_id").notNull(),
  basicAttackId: text("basic_attack_id").notNull(),
  ability1Id: text("ability_1_id").notNull(),
  ability2Id: text("ability_2_id").notNull(),
  ability3Id: text("ability_3_id").notNull(),
  ability4Id: text("ability_4_id").notNull(),
  ...timestamps(),
});

export const characterLocations = pgTable(
  "character_locations",
  {
    characterId: text("character_id")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    logicalMapId: text("logical_map_id").notNull(),
    entranceId: text("entrance_id").notNull(),
    positionX: real("position_x").notNull().default(0),
    positionY: real("position_y").notNull().default(0),
    safeSpawnX: real("safe_spawn_x").notNull().default(0),
    safeSpawnY: real("safe_spawn_y").notNull().default(0),
    connectionState: text("connection_state").notNull().default("offline"),
    ...timestamps(),
  },
  (table) => [
    check(
      "character_locations_connection_state_valid",
      sql`${table.connectionState} in ('online', 'disconnected', 'offline')`,
    ),
  ],
);

export const characterInventory = pgTable(
  "character_inventory",
  {
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.characterId, table.itemId] }),
    check(
      "character_inventory_quantity_nonnegative",
      sql`${table.quantity} >= 0`,
    ),
  ],
);

export const characterEquipment = pgTable(
  "character_equipment",
  {
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    itemId: text("item_id").notNull(),
    ...timestamps(),
  },
  (table) => [primaryKey({ columns: [table.characterId, table.slot] })],
);

export const contentReferences = pgTable(
  "content_references",
  {
    id: text("id").primaryKey(),
    contentVersion: text("content_version").notNull(),
    kind: text("kind").notNull(),
    contentId: text("content_id").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("content_references_version_kind_id_unique").on(
      table.contentVersion,
      table.kind,
      table.contentId,
    ),
  ],
);

export const playTickets = pgTable(
  "play_tickets",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    logicalDestination: text("logical_destination").notNull(),
    entranceId: text("entrance_id").notNull(),
    contentVersion: text("content_version").notNull(),
    nonce: text("nonce").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("play_tickets_nonce_unique").on(table.nonce)],
);

export const characterQuests = pgTable(
  "character_quests",
  {
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    questId: text("quest_id").notNull(),
    status: text("status").notNull().default("available"),
    progress: integer("progress").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.characterId, table.questId] }),
    check("character_quests_progress_nonnegative", sql`${table.progress} >= 0`),
    check(
      "character_quests_status_valid",
      sql`${table.status} in ('available', 'active', 'ready', 'completed')`,
    ),
  ],
);

export const questObjectiveEvents = pgTable(
  "quest_objective_events",
  {
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    questId: text("quest_id").notNull(),
    eventId: text("event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.characterId, table.questId, table.eventId] }),
  ],
);

export const rewardGrants = pgTable(
  "reward_grants",
  {
    grantId: text("grant_id").primaryKey(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    defeatSequence: integer("defeat_sequence").notNull(),
    itemId: text("item_id").notNull(),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("reward_grants_character_source_sequence_unique").on(
      table.characterId,
      table.sourceId,
      table.defeatSequence,
    ),
    check("reward_grants_quantity_positive", sql`${table.quantity} > 0`),
  ],
);

export const durableActionRecords = pgTable("durable_action_records", {
  actionId: text("action_id").primaryKey(),
  characterId: text("character_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const characterDiscoveries = pgTable(
  "character_discoveries",
  {
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    discoveryId: text("discovery_id").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.characterId, table.discoveryId] })],
);
