-- The fit note of an application: one row per job, with its checked quotes. The writer_fit control request kind queues it for
-- the ai-worker. Every statement can run again (a migration test replays everything after an earlier migration).
ALTER TYPE "public"."control_request_kind" ADD VALUE IF NOT EXISTS 'writer_fit' BEFORE 'models_sync';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_fit_notes" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"company_research_id" bigint NOT NULL,
	"materials_hash" text NOT NULL,
	"story_ids" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text NOT NULL,
	"control_request_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_fit_notes" ADD CONSTRAINT "application_fit_notes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
