ALTER TABLE "runs" ADD COLUMN "usage_units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "window_hours" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "window_extended" boolean DEFAULT false NOT NULL;