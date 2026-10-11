CREATE TABLE "source_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"source_group" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"enabled" boolean NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_config" boolean DEFAULT true NOT NULL,
	"removed_at" timestamp with time zone,
	"config_hash" text NOT NULL,
	"first_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_registry_type_check" CHECK ("source_registry"."type" in ('channel', 'ats_board'))
);
--> statement-breakpoint
ALTER TABLE "ats_boards" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ats_boards" ADD COLUMN "last_ok_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "source_registry_in_config_type_idx" ON "source_registry" USING btree ("in_config","type");