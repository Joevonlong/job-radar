ALTER TYPE "public"."control_request_kind" ADD VALUE 'run_ai';--> statement-breakpoint
ALTER TYPE "public"."control_request_kind" ADD VALUE 'translate_job';--> statement-breakpoint
CREATE TABLE "translation_progress" (
	"job_id" bigint NOT NULL,
	"lang" text NOT NULL,
	"source_hash" text NOT NULL,
	"total_chunks" integer NOT NULL,
	"chunks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_progress_job_id_lang_pk" PRIMARY KEY("job_id","lang")
);
--> statement-breakpoint
ALTER TABLE "translation_progress" ADD CONSTRAINT "translation_progress_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;