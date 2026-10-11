CREATE TABLE "signal_scans" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"description_hash" text NOT NULL,
	"rules_hash" text NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"ai_description_hash" text,
	"ai_prompt_version" text,
	"ai_provider" text,
	"ai_model" text,
	"ai_scanned_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "signal_scans" ADD CONSTRAINT "signal_scans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;