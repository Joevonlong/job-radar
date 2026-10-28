ALTER TABLE "jobs" ADD COLUMN "dormant_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "possibly_closed_at" timestamp with time zone;