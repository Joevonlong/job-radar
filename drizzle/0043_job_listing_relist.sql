ALTER TABLE "jobs" ADD COLUMN "last_listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "relisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "relist_count" integer;--> statement-breakpoint
CREATE INDEX "jobs_relisted_at_idx" ON "jobs" USING btree ("relisted_at") WHERE "jobs"."relisted_at" is not null;