CREATE INDEX "jobs_first_seen_at_idx" ON "jobs" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "scores_scored_at_idx" ON "scores" USING btree ("scored_at");--> statement-breakpoint
CREATE INDEX "scores_job_latest_idx" ON "scores" USING btree ("job_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "scores_job_latest_scored_idx" ON "scores" USING btree ("job_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "scores"."score" is not null;