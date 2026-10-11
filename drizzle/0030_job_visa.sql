CREATE TABLE "job_visa" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_visa_status_check" CHECK ("job_visa"."status" in ('offered', 'not_offered', 'unclear', 'not_mentioned')),
	CONSTRAINT "job_visa_evidence_check" CHECK ("job_visa"."status" = 'not_mentioned' or jsonb_array_length("job_visa"."evidence") > 0)
);
--> statement-breakpoint
ALTER TABLE "job_visa" ADD CONSTRAINT "job_visa_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;