-- The company background: one row per AI web search of a company (the stored fields, what was searched, when it expires),
-- and the company's website domain with where it came from. The company_research control request kind queues a lookup for
-- the ai-worker. Every statement can run again (a migration test replays everything after an earlier migration).
ALTER TYPE "public"."control_request_kind" ADD VALUE IF NOT EXISTS 'company_research';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_research" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "company_research_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"job_id" bigint,
	"status" text NOT NULL,
	"result_json" jsonb,
	"domain_used" text,
	"provider" text,
	"model" text,
	"prompt_version" integer NOT NULL,
	"error_code" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "company_research_status_check" CHECK ("company_research"."status" in ('ok', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "website_domain" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "website_domain_source" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "website_domain_confirmed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_research" ADD CONSTRAINT "company_research_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_research" ADD CONSTRAINT "company_research_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_research_company_idx" ON "company_research" USING btree ("company_id","prompt_version","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_research_job_idx" ON "company_research" USING btree ("job_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "companies" ADD CONSTRAINT "companies_website_domain_source_check" CHECK ("companies"."website_domain_source" in ('user', 'inferred'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
