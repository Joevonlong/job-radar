ALTER TABLE "translations" ADD COLUMN "source_hash" text;--> statement-breakpoint
-- Translations that exist before this column were made from the job's current description.
UPDATE "translations" SET "source_hash" = encode(sha256(convert_to(coalesce((SELECT "description" FROM "jobs" WHERE "jobs"."id" = "translations"."job_id"), ''), 'UTF8')), 'hex');--> statement-breakpoint
ALTER TABLE "translations" ALTER COLUMN "source_hash" SET NOT NULL;
