CREATE TYPE "public"."trap_layer" AS ENUM('rule', 'ai');--> statement-breakpoint
CREATE TYPE "public"."trap_quote_source" AS ENUM('description', 'raw');--> statement-breakpoint
CREATE TYPE "public"."trap_severity" AS ENUM('trap', 'suspicious');--> statement-breakpoint
CREATE TABLE "job_traps" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_traps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"raw_posting_id" bigint,
	"layer" "trap_layer" NOT NULL,
	"technique" text NOT NULL,
	"method" text,
	"severity" "trap_severity" NOT NULL,
	"quote" text NOT NULL,
	"quote_source" "trap_quote_source" NOT NULL,
	"quote_offset" integer,
	"location" text NOT NULL,
	"evidence" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_verdict" text,
	"reason" text,
	"in_description" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_traps_quote_not_empty" CHECK (length(btrim("job_traps"."quote")) > 0),
	CONSTRAINT "job_traps_evidence_length" CHECK ("job_traps"."evidence" is null or length("job_traps"."evidence") <= 200)
);
--> statement-breakpoint
CREATE TABLE "trap_scans" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"description_hash" text NOT NULL,
	"sources_hash" text NOT NULL,
	"rules_hash" text NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trap_count" integer DEFAULT 0 NOT NULL,
	"suspicious_count" integer DEFAULT 0 NOT NULL,
	"needs_ai" boolean DEFAULT false NOT NULL,
	"spans_hash" text,
	"found_at" timestamp with time zone,
	"ai_description_hash" text,
	"ai_prompt_version" text,
	"ai_provider" text,
	"ai_model" text,
	"ai_checked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_traps" ADD CONSTRAINT "job_traps_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_traps" ADD CONSTRAINT "job_traps_raw_posting_id_raw_postings_id_fk" FOREIGN KEY ("raw_posting_id") REFERENCES "public"."raw_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trap_scans" ADD CONSTRAINT "trap_scans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_traps_job_id_idx" ON "job_traps" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "trap_scans_trap_count_idx" ON "trap_scans" USING btree ("trap_count") WHERE "trap_scans"."trap_count" > 0;