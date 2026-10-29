CREATE TABLE "delivery_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"ordinal" integer NOT NULL,
	"batch" smallint NOT NULL,
	"channel_id" text NOT NULL,
	"external_id" text,
	"disposition" text NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_bytes" integer NOT NULL,
	"payload_json" jsonb,
	"payload_text" text,
	"raw_posting_id" bigint,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "delivery_items_run_ordinal_uq" UNIQUE("run_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "run_deliveries" (
	"run_id" bigint PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"ledger" text NOT NULL,
	"delivered" integer NOT NULL,
	"billed_units" integer NOT NULL,
	"distinct_ids" integer NOT NULL,
	"counts_json" jsonb NOT NULL,
	"window_cutoff_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_raw_posting_id_raw_postings_id_fk" FOREIGN KEY ("raw_posting_id") REFERENCES "public"."raw_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_deliveries" ADD CONSTRAINT "run_deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_items_received_id_idx" ON "delivery_items" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX "delivery_items_channel_external_idx" ON "delivery_items" USING btree ("channel_id","external_id") WHERE "delivery_items"."external_id" is not null;