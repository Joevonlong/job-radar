CREATE TABLE "job_ghost" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recheck_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_codes" text[],
	CONSTRAINT "job_ghost_level_check" CHECK ("job_ghost"."level" in ('none', 'watch', 'likely'))
);
--> statement-breakpoint
ALTER TABLE "job_ghost" ADD CONSTRAINT "job_ghost_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_ghost_level_idx" ON "job_ghost" USING btree ("level") WHERE "job_ghost"."level" <> 'none';