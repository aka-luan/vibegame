CREATE TABLE "character_appearance" (
	"character_id" text PRIMARY KEY NOT NULL,
	"rig_id" text NOT NULL,
	"base_layer_id" text NOT NULL,
	"armor_layer_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_equipment" (
	"character_id" text NOT NULL,
	"slot" text NOT NULL,
	"item_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_equipment_character_id_slot_pk" PRIMARY KEY("character_id","slot")
);
--> statement-breakpoint
CREATE TABLE "character_inventory" (
	"character_id" text NOT NULL,
	"item_id" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_inventory_character_id_item_id_pk" PRIMARY KEY("character_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "character_loadouts" (
	"character_id" text PRIMARY KEY NOT NULL,
	"content_version" text NOT NULL,
	"class_id" text NOT NULL,
	"basic_attack_id" text NOT NULL,
	"ability_1_id" text NOT NULL,
	"ability_2_id" text NOT NULL,
	"ability_3_id" text NOT NULL,
	"ability_4_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_locations" (
	"character_id" text PRIMARY KEY NOT NULL,
	"logical_map_id" text NOT NULL,
	"entrance_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_progression" (
	"character_id" text PRIMARY KEY NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"experience" integer DEFAULT 0 NOT NULL,
	"currency" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"creation_request_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_references" (
	"id" text PRIMARY KEY NOT NULL,
	"content_version" text NOT NULL,
	"kind" text NOT NULL,
	"content_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_tickets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"character_id" text NOT NULL,
	"logical_destination" text NOT NULL,
	"content_version" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_appearance" ADD CONSTRAINT "character_appearance_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_equipment" ADD CONSTRAINT "character_equipment_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_inventory" ADD CONSTRAINT "character_inventory_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_loadouts" ADD CONSTRAINT "character_loadouts_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_locations" ADD CONSTRAINT "character_locations_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_progression" ADD CONSTRAINT "character_progression_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_tickets" ADD CONSTRAINT "play_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_tickets" ADD CONSTRAINT "play_tickets_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "characters_user_name_unique" ON "characters" USING btree ("user_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "characters_user_creation_request_unique" ON "characters" USING btree ("user_id","creation_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_references_version_kind_id_unique" ON "content_references" USING btree ("content_version","kind","content_id");--> statement-breakpoint
CREATE UNIQUE INDEX "play_tickets_nonce_unique" ON "play_tickets" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_secret_hash_unique" ON "sessions" USING btree ("secret_hash");