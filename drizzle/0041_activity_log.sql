CREATE TABLE "activity_spans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"root_id" uuid NOT NULL,
	"parent_id" uuid,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"process" text NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone NOT NULL,
	"progress_done" integer,
	"progress_total" integer,
	"events_dropped" integer DEFAULT 0 NOT NULL,
	"cycle_id" bigint,
	"control_request_id" bigint,
	"run_id" bigint,
	"job_id" bigint,
	"channel_id" text,
	"query_id" text,
	CONSTRAINT "activity_spans_root_id_activity_spans_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."activity_spans"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"root_id" uuid NOT NULL,
	"span_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"code" text NOT NULL,
	"job_id" bigint,
	"raw_posting_id" bigint,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "activity_events_root_id_activity_spans_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."activity_spans"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "activity_events_root_at_idx" ON "activity_events" USING btree ("root_id","at","id");--> statement-breakpoint
CREATE INDEX "activity_events_span_at_idx" ON "activity_events" USING btree ("span_id","at","id");--> statement-breakpoint
CREATE INDEX "activity_spans_root_idx" ON "activity_spans" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "activity_spans_roots_started_idx" ON "activity_spans" USING btree ("started_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "activity_spans"."parent_id" is null;--> statement-breakpoint
CREATE INDEX "activity_spans_cycle_idx" ON "activity_spans" USING btree ("cycle_id") WHERE "activity_spans"."cycle_id" is not null;--> statement-breakpoint
CREATE INDEX "activity_spans_request_started_idx" ON "activity_spans" USING btree ("control_request_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "activity_spans"."control_request_id" is not null;--> statement-breakpoint
CREATE INDEX "activity_spans_run_idx" ON "activity_spans" USING btree ("run_id") WHERE "activity_spans"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "activity_spans_running_process_idx" ON "activity_spans" USING btree ("process") WHERE "activity_spans"."status" = 'running';
