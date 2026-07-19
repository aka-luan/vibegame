CREATE TABLE "character_discoveries" (
	"character_id" text NOT NULL,
	"discovery_id" text NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_discoveries_character_id_discovery_id_pk" PRIMARY KEY("character_id","discovery_id")
);
--> statement-breakpoint
CREATE TABLE "character_quests" (
	"character_id" text NOT NULL,
	"quest_id" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_quests_character_id_quest_id_pk" PRIMARY KEY("character_id","quest_id"),
	CONSTRAINT "character_quests_progress_nonnegative" CHECK ("character_quests"."progress" >= 0),
	CONSTRAINT "character_quests_status_valid" CHECK ("character_quests"."status" in ('available', 'active', 'ready', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "durable_action_records" (
	"action_id" text PRIMARY KEY NOT NULL,
	"character_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quest_objective_events" (
	"character_id" text NOT NULL,
	"quest_id" text NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quest_objective_events_character_id_quest_id_event_id_pk" PRIMARY KEY("character_id","quest_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "reward_grants" (
	"grant_id" text PRIMARY KEY NOT NULL,
	"character_id" text NOT NULL,
	"source_id" text NOT NULL,
	"defeat_sequence" integer NOT NULL,
	"item_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reward_grants_quantity_positive" CHECK ("reward_grants"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "character_locations" ADD COLUMN "position_x" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_locations" ADD COLUMN "position_y" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_locations" ADD COLUMN "safe_spawn_x" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_locations" ADD COLUMN "safe_spawn_y" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_locations" ADD COLUMN "connection_state" text DEFAULT 'offline' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_discoveries" ADD CONSTRAINT "character_discoveries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_quests" ADD CONSTRAINT "character_quests_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "durable_action_records" ADD CONSTRAINT "durable_action_records_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_objective_events" ADD CONSTRAINT "quest_objective_events_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_grants" ADD CONSTRAINT "reward_grants_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_grants_character_source_sequence_unique" ON "reward_grants" USING btree ("character_id","source_id","defeat_sequence");