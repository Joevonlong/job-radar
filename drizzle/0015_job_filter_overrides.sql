CREATE TYPE "public"."filter_override" AS ENUM('keep', 'exclude');--> statement-breakpoint
CREATE TABLE "job_filter_overrides" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"action" "filter_override" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_filter_overrides" ADD CONSTRAINT "job_filter_overrides_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;