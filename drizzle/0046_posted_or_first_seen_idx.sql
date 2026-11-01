-- The /jobs date filter compares coalesce(posted_at, first_seen_at); the index serves that expression.
CREATE INDEX IF NOT EXISTS "jobs_posted_or_first_seen_idx" ON "jobs" USING btree (coalesce("posted_at", "first_seen_at"));
