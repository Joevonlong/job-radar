-- B-002: `stale` only means "this row has AI output made under an outdated profile or prompt".
-- Rows without a score (hard-filter rows waiting for the AI, filtered-out jobs) were wrongly marked stale.
UPDATE "scores" SET "stale" = false WHERE "score" IS NULL AND "stale" = true;
