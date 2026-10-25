ALTER TABLE "runs" ADD COLUMN "usage_units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "window_hours" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "window_extended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_channel_query_started_idx" ON "runs" USING btree ("channel_id","query_hash","started_at","status","fetched","usage_units","cost","interrupted");