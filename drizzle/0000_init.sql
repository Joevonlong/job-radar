CREATE TYPE "public"."application_status" AS ENUM('new', 'interested', 'preparing', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived');--> statement-breakpoint
CREATE TYPE "public"."channel_health" AS ENUM('unknown', 'healthy', 'degraded', 'down');--> statement-breakpoint
CREATE TYPE "public"."circuit_state" AS ENUM('closed', 'open', 'half_open');--> statement-breakpoint
CREATE TYPE "public"."cycle_kind" AS ENUM('weekday_morning', 'weekday_evening', 'weekend', 'manual', 'catchup');--> statement-breakpoint
CREATE TYPE "public"."filter_result" AS ENUM('passed', 'filtered_out');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('active', 'possibly_closed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."parse_status" AS ENUM('pending', 'parsed', 'parse_failed');--> statement-breakpoint
CREATE TYPE "public"."profile_kind" AS ENUM('me', 'preferences', 'interests');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."signal_extractor" AS ENUM('rule', 'ai');--> statement-breakpoint
CREATE TYPE "public"."signal_tier" AS ENUM('T1', 'T2', 'T3', 'T4', 'tag');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."workplace" AS ENUM('onsite', 'hybrid', 'remote', 'unknown');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_usage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"task" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_estimate" numeric(12, 6) DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "application_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"application_id" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_status" "application_status",
	"to_status" "application_status" NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "applications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"status" "application_status" DEFAULT 'new' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_action" text,
	"next_action_at" timestamp with time zone,
	"notes_md" text,
	"resume_variant_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_job_id_uq" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health" "channel_health" DEFAULT 'unknown' NOT NULL,
	"circuit_state" "circuit_state" DEFAULT 'closed' NOT NULL,
	"month_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "companies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"ats_kind" text,
	"ats_token" text,
	"watched" boolean DEFAULT false NOT NULL,
	"blacklisted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_name_norm_uq" UNIQUE("name_norm")
);
--> statement-breakpoint
CREATE TABLE "cycles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cycles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "cycle_kind" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"summary_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"sender" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"parse_status" "parse_status" DEFAULT 'pending' NOT NULL,
	"raw_ref" text
);
--> statement-breakpoint
CREATE TABLE "interest_suggestions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "interest_suggestions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_sources" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_sources_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"raw_posting_id" bigint NOT NULL,
	"channel_id" text NOT NULL,
	"url" text,
	"priority" smallint DEFAULT 100 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_sources_job_raw_posting_uq" UNIQUE("job_id","raw_posting_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"title" text NOT NULL,
	"title_norm" text NOT NULL,
	"locations_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workplace" "workplace" DEFAULT 'unknown' NOT NULL,
	"seniority" text DEFAULT 'unknown' NOT NULL,
	"contract" text DEFAULT 'unknown' NOT NULL,
	"salary_json" jsonb,
	"description" text,
	"language" text DEFAULT 'unknown' NOT NULL,
	"german_level_required" text DEFAULT 'unknown' NOT NULL,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "job_status" DEFAULT 'active' NOT NULL,
	"simhash" text,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"cycle_id" bigint,
	"payload_json" jsonb,
	"sent_at" timestamp with time zone,
	"telegram_message_id" bigint
);
--> statement-breakpoint
CREATE TABLE "profile_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "profile_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "profile_kind" NOT NULL,
	"content_yaml" text NOT NULL,
	"hash" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_snapshots_kind_hash_uq" UNIQUE("kind","hash")
);
--> statement-breakpoint
CREATE TABLE "raw_postings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "raw_postings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel_id" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"payload_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parse_status" "parse_status" DEFAULT 'pending' NOT NULL,
	"run_id" bigint,
	CONSTRAINT "raw_postings_channel_external_uq" UNIQUE("channel_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "runner_heartbeats" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runner_heartbeats_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"process" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"cycle_id" bigint,
	"channel_id" text NOT NULL,
	"query_hash" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"cost" numeric(12, 6) DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scores_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"profile_snapshot_id" bigint,
	"provider" text,
	"model" text,
	"filter_result" "filter_result" NOT NULL,
	"filter_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"score" smallint,
	"signal_bonus" numeric(6, 2) DEFAULT 0 NOT NULL,
	"rank_value" numeric(6, 2),
	"fit_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"gaps" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary_zh" text,
	"summary_en" text,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_score_range" CHECK ("scores"."score" is null or "scores"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "signals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"tier" "signal_tier" NOT NULL,
	"kind" text NOT NULL,
	"value_json" jsonb,
	"quote" text NOT NULL,
	"quote_offset" integer,
	"extractor" "signal_extractor" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_quote_not_empty" CHECK (length(btrim("signals"."quote")) > 0)
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"job_id" bigint NOT NULL,
	"lang" text NOT NULL,
	"provider" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translations_job_id_lang_pk" PRIMARY KEY("job_id","lang")
);
--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_raw_posting_id_raw_postings_id_fk" FOREIGN KEY ("raw_posting_id") REFERENCES "public"."raw_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD CONSTRAINT "raw_postings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD CONSTRAINT "raw_postings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_profile_snapshot_id_profile_snapshots_id_fk" FOREIGN KEY ("profile_snapshot_id") REFERENCES "public"."profile_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_at_idx" ON "ai_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "application_events_application_at_idx" ON "application_events" USING btree ("application_id","at");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cycles_started_at_idx" ON "cycles" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "email_messages_parse_status_idx" ON "email_messages" USING btree ("parse_status");--> statement-breakpoint
CREATE INDEX "interest_suggestions_status_idx" ON "interest_suggestions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_sources_raw_posting_id_idx" ON "job_sources" USING btree ("raw_posting_id");--> statement-breakpoint
CREATE INDEX "jobs_company_id_idx" ON "jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "jobs_status_last_seen_idx" ON "jobs" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "jobs_title_norm_idx" ON "jobs" USING btree ("title_norm");--> statement-breakpoint
CREATE INDEX "jobs_simhash_idx" ON "jobs" USING btree ("simhash");--> statement-breakpoint
CREATE INDEX "jobs_search_tsv_idx" ON "jobs" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "notifications_cycle_id_idx" ON "notifications" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "raw_postings_parse_status_idx" ON "raw_postings" USING btree ("parse_status");--> statement-breakpoint
CREATE INDEX "raw_postings_run_id_idx" ON "raw_postings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runner_heartbeats_at_idx" ON "runner_heartbeats" USING btree ("at");--> statement-breakpoint
CREATE INDEX "runs_cycle_id_idx" ON "runs" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "runs_channel_started_idx" ON "runs" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE INDEX "scores_job_id_idx" ON "scores" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "scores_rank_value_idx" ON "scores" USING btree ("rank_value");--> statement-breakpoint
CREATE INDEX "signals_job_id_idx" ON "signals" USING btree ("job_id");