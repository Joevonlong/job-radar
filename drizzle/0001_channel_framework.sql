ALTER TABLE "channels" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "circuit_open_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "error_code" text;