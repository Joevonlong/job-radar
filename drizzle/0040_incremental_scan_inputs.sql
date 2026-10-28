ALTER TABLE "jobs" ADD COLUMN "description_md5" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "description_has_text" boolean;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_md5" text;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD COLUMN "payload_fingerprint" text;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "filter_input_hash" text;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "filter_config_hash" text;--> statement-breakpoint
CREATE INDEX "control_requests_job_id_idx" ON "control_requests" USING btree ("kind",("payload" ->> 'jobId'),"id");--> statement-breakpoint
CREATE INDEX "notifications_job_id_idx" ON "notifications" USING btree (("payload_json" ->> 'jobId')) WHERE "notifications"."kind" in ('job', 'job_overflow');--> statement-breakpoint
CREATE INDEX "raw_postings_pending_id_idx" ON "raw_postings" USING btree ("id") WHERE "raw_postings"."parse_status" = 'pending';--> statement-breakpoint
CREATE INDEX "runs_channel_recent_idx" ON "runs" USING btree ("channel_id","started_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "runs_started_at_idx" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "runs_channel_status_started_idx" ON "runs" USING btree ("channel_id","status","started_at");--> statement-breakpoint
-- Source triggers also protect writes from older binaries during a rollback.
CREATE FUNCTION jobs_refresh_change_fingerprints() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.description_md5 := md5(coalesce(NEW.description, ''));
  NEW.description_has_text := NEW.description IS NOT NULL AND btrim(NEW.description) <> '';
  NEW.salary_md5 := md5(coalesce(NEW.salary_json::text, ''));
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER jobs_refresh_change_fingerprints
  BEFORE INSERT OR UPDATE OF description, salary_json ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_refresh_change_fingerprints();--> statement-breakpoint
CREATE FUNCTION raw_postings_refresh_change_fingerprint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.payload_fingerprint := coalesce(NEW.payload_hash, md5(NEW.payload_json::text));
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER raw_postings_refresh_change_fingerprint
  BEFORE INSERT OR UPDATE OF payload_json, payload_hash ON raw_postings
  FOR EACH ROW EXECUTE FUNCTION raw_postings_refresh_change_fingerprint();--> statement-breakpoint
CREATE FUNCTION scores_invalidate_filter_fingerprints() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An old writer cannot name the hashes. Clearing unchanged hashes is conservative even when a
  -- new writer explicitly supplies the same pair: it only causes another evaluation, never a stale hit.
  IF (NEW.filter_result IS DISTINCT FROM OLD.filter_result OR NEW.filter_reasons IS DISTINCT FROM OLD.filter_reasons)
    AND NEW.filter_input_hash IS NOT DISTINCT FROM OLD.filter_input_hash
    AND NEW.filter_config_hash IS NOT DISTINCT FROM OLD.filter_config_hash THEN
    NEW.filter_input_hash := NULL;
    NEW.filter_config_hash := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER scores_invalidate_filter_fingerprints
  BEFORE UPDATE OF filter_result, filter_reasons ON scores
  FOR EACH ROW EXECUTE FUNCTION scores_invalidate_filter_fingerprints();
