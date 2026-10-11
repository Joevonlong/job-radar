CREATE TABLE "job_favorites" (
	"job_id" bigint PRIMARY KEY NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_favorites" ADD CONSTRAINT "job_favorites_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_favorites_created_at_idx" ON "job_favorites" USING btree ("created_at");