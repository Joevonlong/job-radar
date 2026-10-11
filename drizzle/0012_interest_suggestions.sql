ALTER TYPE "public"."control_request_kind" ADD VALUE 'run_suggest';--> statement-breakpoint
ALTER TABLE "interest_suggestions" ADD COLUMN "dedupe_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "interest_suggestions" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interest_suggestions" ADD CONSTRAINT "interest_suggestions_dedupe_key_uq" UNIQUE("dedupe_key");