-- F-095: AI texts carry their language. scores.summaries holds the one-line summary per language (the old summary_zh /
-- summary_en columns stay and are still written, for a rollback); scores.output_lang and job_breakdowns.output_lang say which
-- language the reasons / gaps / breakdown items are in. Everything written before F-095 is Chinese (the prompts asked for it).
ALTER TABLE "scores" ADD COLUMN "summaries" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "output_lang" text;--> statement-breakpoint
UPDATE "scores" SET
  "summaries" = jsonb_strip_nulls(jsonb_build_object('zh', nullif(btrim("summary_zh"), ''), 'en', nullif(btrim("summary_en"), ''))),
  "output_lang" = CASE WHEN "ai_score" IS NOT NULL OR "summary_zh" IS NOT NULL OR cardinality("fit_reasons") > 0 THEN 'zh' END;--> statement-breakpoint
ALTER TABLE "job_breakdowns" ADD COLUMN "output_lang" text;--> statement-breakpoint
UPDATE "job_breakdowns" SET "output_lang" = 'zh';--> statement-breakpoint
ALTER TABLE "job_breakdowns" ALTER COLUMN "output_lang" SET NOT NULL;
