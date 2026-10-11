ALTER TABLE "ai_usage" ALTER COLUMN "tokens_in" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "tokens_in" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "tokens_out" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_usage" ALTER COLUMN "tokens_out" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "model_source" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "tokens_in_cached" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "tokens_in_cache_write" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "tokens_out_reasoning" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "equivalent_cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "job_id" bigint;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_job_id_idx" ON "ai_usage" USING btree ("job_id");
--> statement-breakpoint
-- F-085: an API call's equivalent cost is its actual cost; old rows get it at once (the backfill script does the same for later gaps)
UPDATE "ai_usage" SET "equivalent_cost_usd" = "cost_estimate" WHERE "provider" IN ('anthropic', 'deepseek', 'mimo') AND "equivalent_cost_usd" IS NULL;
