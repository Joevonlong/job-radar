-- Which discovery sources found each board candidate. Every statement can run again (a migration test replays everything after an earlier migration).
ALTER TABLE "ats_board_candidates" ADD COLUMN IF NOT EXISTS "found_by" text[] DEFAULT '{}'::text[] NOT NULL;
