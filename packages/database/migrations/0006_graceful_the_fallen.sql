ALTER TABLE "play_tickets" ADD COLUMN "entrance_id" text;--> statement-breakpoint
UPDATE "play_tickets" SET "entrance_id" = "character_locations"."entrance_id" FROM "character_locations" WHERE "character_locations"."character_id" = "play_tickets"."character_id" AND "play_tickets"."entrance_id" IS NULL;--> statement-breakpoint
DELETE FROM "play_tickets" WHERE "entrance_id" IS NULL;--> statement-breakpoint
ALTER TABLE "play_tickets" ALTER COLUMN "entrance_id" SET NOT NULL;
