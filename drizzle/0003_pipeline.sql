ALTER TABLE "job_sources" ADD COLUMN "apply_url" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "is_agency" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "skills" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "link_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD COLUMN "parse_error" text;