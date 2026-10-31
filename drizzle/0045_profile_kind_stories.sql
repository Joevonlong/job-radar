-- The experience library (stories.yaml) keeps profile snapshots of its own: history and rollback on /me. Scoring never
-- reads them, so they never make a score stale.
ALTER TYPE "public"."profile_kind" ADD VALUE IF NOT EXISTS 'stories';