-- One row per automatic research run of a job: what limits those runs per 24 hours, and what each part did. Every statement can run
-- again (a migration test replays everything after an earlier migration).
CREATE TABLE IF NOT EXISTS "research_auto_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "research_auto_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" bigint NOT NULL,
	"trigger" text NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_auto_runs" ADD CONSTRAINT "research_auto_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_auto_runs_created_idx" ON "research_auto_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_auto_runs_job_created_idx" ON "research_auto_runs" USING btree ("job_id","created_at");
