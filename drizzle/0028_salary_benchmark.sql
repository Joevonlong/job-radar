-- F-118: the salary benchmark (rebuilt after every pipeline step from postings with a comparable annual figure) and the
-- on-demand salary lookups (AI web search, checked in code; an estimate with sources, never a fact of the job). The
-- salary_lookup control request kind queues a lookup for the ai-worker.
ALTER TYPE "public"."control_request_kind" ADD VALUE 'salary_lookup';--> statement-breakpoint
CREATE TABLE "salary_benchmarks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "salary_benchmarks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"role_family" text NOT NULL,
	"seniority" text NOT NULL,
	"geo_level" text NOT NULL,
	"geo_key" text NOT NULL,
	"currency" text NOT NULL,
	"n" integer NOT NULL,
	"n_ai" integer DEFAULT 0 NOT NULL,
	"median" numeric(14, 2) NOT NULL,
	"quantiles" jsonb NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_lookups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "salary_lookups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" bigint NOT NULL,
	"job_id" bigint,
	"lookup_key" text NOT NULL,
	"status" text NOT NULL,
	"result_json" jsonb,
	"confidence" text,
	"provider" text,
	"model" text,
	"prompt_version" text NOT NULL,
	"error_code" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "salary_lookups" ADD CONSTRAINT "salary_lookups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_lookups" ADD CONSTRAINT "salary_lookups_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "salary_benchmarks_group_uq" ON "salary_benchmarks" USING btree ("role_family","seniority","geo_level","geo_key","currency");--> statement-breakpoint
CREATE INDEX "salary_lookups_key_idx" ON "salary_lookups" USING btree ("lookup_key","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "salary_lookups_fetched_idx" ON "salary_lookups" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "salary_lookups_job_idx" ON "salary_lookups" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "salary_lookups_company_idx" ON "salary_lookups" USING btree ("company_id");