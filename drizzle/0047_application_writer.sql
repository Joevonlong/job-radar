-- The application writer: the questions of a job's application form (with the material chosen for each) and the answer
-- versions with the evidence check of every sentence. The writer_job control request kind queues a draft for the
-- ai-worker; its material is cleared from the request once it is done, failed or expired. A request writes each variant
-- once (unique control_request_id + variant_id), so a re-run never duplicates versions. Every statement can run again
-- (a migration test replays everything after an earlier migration).
ALTER TYPE "public"."control_request_kind" ADD VALUE IF NOT EXISTS 'writer_job';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_answer_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "application_answer_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"question_id" bigint NOT NULL,
	"mode" text NOT NULL,
	"variant_id" text,
	"text" text NOT NULL,
	"sentences" jsonb NOT NULL,
	"supported_count" integer DEFAULT 0 NOT NULL,
	"partial_count" integer DEFAULT 0 NOT NULL,
	"unsupported_count" integer DEFAULT 0 NOT NULL,
	"framing_count" integer DEFAULT 0 NOT NULL,
	"user_written_count" integer DEFAULT 0 NOT NULL,
	"web_unverified_count" integer DEFAULT 0 NOT NULL,
	"coach" jsonb,
	"parent_version_id" bigint,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"materials_hash" text,
	"control_request_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_questions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "application_questions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"length_unit" text NOT NULL,
	"length_value" integer NOT NULL,
	"output_language" text NOT NULL,
	"tone" text NOT NULL,
	"selected_materials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"final_version_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_answer_versions" ADD CONSTRAINT "application_answer_versions_question_id_application_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."application_questions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_answer_versions_question_idx" ON "application_answer_versions" USING btree ("question_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "application_answer_versions_request_variant_idx" ON "application_answer_versions" USING btree ("control_request_id","variant_id") WHERE "application_answer_versions"."control_request_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_questions_job_idx" ON "application_questions" USING btree ("job_id","position");