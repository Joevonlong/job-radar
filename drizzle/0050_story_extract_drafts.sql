-- Story extraction: a control request kind, and the drafts it leaves for review on /me.
ALTER TYPE "public"."control_request_kind" ADD VALUE IF NOT EXISTS 'story_extract';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_story_drafts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "profile_story_drafts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"draft" jsonb NOT NULL,
	"origin" text NOT NULL,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_story_drafts_status_idx" ON "profile_story_drafts" USING btree ("status","created_at");