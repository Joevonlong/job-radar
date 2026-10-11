ALTER TABLE "signals" ALTER COLUMN "tier" SET DATA TYPE text USING "tier"::text;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_tier_format" CHECK ("signals"."tier" ~ '^[A-Za-z][A-Za-z0-9_-]{0,23}$');--> statement-breakpoint
DROP TYPE "public"."signal_tier";