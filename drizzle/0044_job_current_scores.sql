CREATE TABLE "job_current_scores" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"newest_score_id" bigint NOT NULL,
	"scored_score_id" bigint,
	"filter_result" "filter_result" NOT NULL,
	"filter_reasons" text[] NOT NULL,
	"score" smallint,
	"rank_value" numeric(6, 2),
	"signal_bonus" numeric(6, 2) NOT NULL,
	"stale" boolean NOT NULL,
	"german_level" text,
	"summaries" jsonb,
	"summary_zh" text,
	"summary_en" text,
	"output_lang" text,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
COMMENT ON TABLE job_current_scores IS 'Derived only from scores; application writes use scoreTransaction; maintenance repairs out-of-band writes. No foreign keys.';
--> statement-breakpoint
-- Protocol constants: namespace 19136, 256 buckets. Changes require a new migration.
-- The double-int key space is separate from bigint 118001 and namespace (19026, ...).
CREATE FUNCTION job_current_scores_lock(job_ids bigint[]) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE b integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Current score refresh requires READ COMMITTED: a new snapshot is needed after waiting for locks';
  END IF;
  FOR b IN SELECT DISTINCT (id % 256)::int FROM unnest(job_ids) id ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(19136, b);
  END LOOP;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF nullif(current_setting('job_radar.current_scores_backfill_lock_timeout_ms', true), '') IS NULL
    OR nullif(current_setting('job_radar.current_scores_backfill_statement_timeout_ms', true), '') IS NULL THEN
    RAISE EXCEPTION 'Current score backfill requires runMigrations with configured timeouts';
  END IF;
END $$;
--> statement-breakpoint
SELECT set_config('job_radar.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('job_radar.prev_statement_timeout', current_setting('statement_timeout'), true);
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('job_radar.current_scores_backfill_lock_timeout_ms') || 'ms', true),
       set_config('statement_timeout', current_setting('job_radar.current_scores_backfill_statement_timeout_ms') || 'ms', true);
--> statement-breakpoint
LOCK TABLE scores IN SHARE MODE;
--> statement-breakpoint
-- One-time frozen display rule; the maintained rule is in src/lib/db/queries/job-cards.ts.
WITH newest AS (SELECT DISTINCT ON (job_id) * FROM scores ORDER BY job_id, created_at DESC, id DESC),
scored AS (SELECT DISTINCT ON (job_id) * FROM scores WHERE score IS NOT NULL ORDER BY job_id, created_at DESC, id DESC)
INSERT INTO job_current_scores (job_id, newest_score_id, scored_score_id, filter_result, filter_reasons, score, rank_value, signal_bonus, stale, german_level, summaries, summary_zh, summary_en, output_lang)
SELECT n.job_id, n.id, s.id, n.filter_result, n.filter_reasons,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN s.score ELSE n.score END,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN s.rank_value ELSE n.rank_value END,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN s.signal_bonus ELSE n.signal_bonus END,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN true ELSE (n.score IS NOT NULL AND n.stale) END,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN s.german_level ELSE n.german_level END,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN s.summaries ELSE n.summaries END,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN s.summary_zh ELSE n.summary_zh END,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN s.summary_en ELSE n.summary_en END,
  CASE WHEN (n.score IS NULL AND n.filter_result = 'passed' AND s.job_id IS NOT NULL) THEN s.output_lang ELSE n.output_lang END
FROM newest n LEFT JOIN scored s ON s.job_id = n.job_id;
--> statement-breakpoint
SELECT set_config('lock_timeout', current_setting('job_radar.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('job_radar.prev_statement_timeout'), true);
