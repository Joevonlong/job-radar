CREATE TYPE "public"."closure_override" AS ENUM('closed', 'open');--> statement-breakpoint
CREATE TYPE "public"."job_seen_via" AS ENUM('detail', 'source', 'action', 'bulk', 'migration');--> statement-breakpoint
CREATE TABLE "job_closure_overrides" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"action" "closure_override" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_seen" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"via" "job_seen_via" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "link_check_json" jsonb;--> statement-breakpoint
ALTER TABLE "job_closure_overrides" ADD CONSTRAINT "job_closure_overrides_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_seen" ADD CONSTRAINT "job_seen_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_seen_via_seen_at_idx" ON "job_seen" USING btree ("via","seen_at");
--> statement-breakpoint
-- F-116 backfill: jobs from before the upgrade are seen up to the B-011 "last visit" marker (all of them when there is none);
-- a job with an application or a star was looked at in any case. Written once, `via = 'migration'`.
INSERT INTO "job_seen" ("job_id", "seen_at", "via")
SELECT j."id", now(), 'migration' FROM "jobs" j
WHERE (SELECT "value"->>'seenUpTo' FROM "runtime_state" WHERE "key" = 'ui:visit') IS NULL
   OR j."first_seen_at" <= ((SELECT "value"->>'seenUpTo' FROM "runtime_state" WHERE "key" = 'ui:visit')::timestamptz)
   OR EXISTS (SELECT 1 FROM "applications" a WHERE a."job_id" = j."id")
   OR EXISTS (SELECT 1 FROM "job_favorites" f WHERE f."job_id" = j."id")
ON CONFLICT DO NOTHING;
