-- F-082 / B-047: 0022 added ats_boards.last_ok_at / consecutive_failures but did not backfill them,
-- so healthy boards had no "last success" and boards that always failed looked merely "unstable".
-- Only the last result per board is stored, so the backfill uses what the existing rows can prove.
UPDATE "ats_boards" SET "last_ok_at" = "last_checked_at" WHERE "last_status" IN ('ok', 'not_modified') AND "last_ok_at" IS NULL;--> statement-breakpoint
-- A failing board has failed at least once. One that never produced a posting and never changed
-- has failed in every check we ran: its ATS channel's finished runs up to its last check.
UPDATE "ats_boards" AS b SET "consecutive_failures" = GREATEST(1, CASE
  WHEN b."last_changed_at" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "raw_postings" r
    WHERE r."channel_id" = b."ats" AND r."payload_json" #>> '{source,token}' = b."token"
  ) THEN (
    SELECT count(*)::int FROM "runs" u
    WHERE u."channel_id" = b."ats" AND u."status" IN ('succeeded', 'partial', 'failed') AND u."started_at" <= b."last_checked_at"
  )
  ELSE 1 END)
WHERE b."last_status" = 'error' AND b."consecutive_failures" = 0;
