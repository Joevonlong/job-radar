ALTER TABLE "jobs" ADD COLUMN "description_md5" text GENERATED ALWAYS AS (md5(coalesce(description, ''))) STORED;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "description_has_text" boolean GENERATED ALWAYS AS (description is not null and btrim(description) <> '') STORED;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_md5" text GENERATED ALWAYS AS (md5(coalesce(salary_json::text, ''))) STORED;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD COLUMN "payload_fingerprint" text GENERATED ALWAYS AS (coalesce(payload_hash, md5(payload_json::text))) STORED;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "filter_input_hash" text;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "filter_config_hash" text;--> statement-breakpoint
CREATE INDEX "control_requests_job_id_idx" ON "control_requests" USING btree ("kind",("payload" ->> 'jobId'),"id");--> statement-breakpoint
CREATE INDEX "notifications_job_id_idx" ON "notifications" USING btree (("payload_json" ->> 'jobId')) WHERE "notifications"."kind" in ('job', 'job_overflow');--> statement-breakpoint
CREATE INDEX "raw_postings_pending_id_idx" ON "raw_postings" USING btree ("id") WHERE "raw_postings"."parse_status" = 'pending';--> statement-breakpoint
CREATE INDEX "runs_channel_recent_idx" ON "runs" USING btree ("channel_id","started_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "runs_started_at_idx" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "runs_channel_status_started_idx" ON "runs" USING btree ("channel_id","status","started_at");