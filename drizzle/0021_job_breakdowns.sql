ALTER TYPE "public"."control_request_kind" ADD VALUE 'breakdown_job' BEFORE 'score_jobs';--> statement-breakpoint
CREATE TABLE "job_breakdowns" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"source_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"provider" text,
	"model" text,
	"content" jsonb NOT NULL,
	"dropped_items" integer DEFAULT 0 NOT NULL,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_breakdowns" ADD CONSTRAINT "job_breakdowns_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;