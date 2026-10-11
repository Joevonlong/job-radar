ALTER TABLE "scores" ADD COLUMN "ai_score" smallint;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "german_penalty" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "german_level" text;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "german_level_ai" text;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "german_level_source" text;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "scored_at" timestamp with time zone;