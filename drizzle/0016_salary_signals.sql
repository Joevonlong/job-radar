CREATE TYPE "public"."signal_quote_source" AS ENUM('description', 'structured');--> statement-breakpoint
ALTER TABLE "signal_scans" ADD COLUMN "salary_hash" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "quote_source" "signal_quote_source" DEFAULT 'description' NOT NULL;