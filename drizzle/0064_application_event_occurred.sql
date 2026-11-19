ALTER TABLE "application_events" ADD COLUMN IF NOT EXISTS "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "application_events" ADD COLUMN IF NOT EXISTS "reference" text;
