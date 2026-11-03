-- What each company merge changed, so that it can be undone. Safe to run twice, like the migrations before it.
CREATE TABLE IF NOT EXISTS "company_merges" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "company_merges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"from_company_id" bigint NOT NULL,
	"into_company_id" bigint NOT NULL,
	"from_row" jsonb NOT NULL,
	"into_before" jsonb NOT NULL,
	"into_after" jsonb NOT NULL,
	"moved" jsonb NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_merges_from_idx" ON "company_merges" USING btree ("from_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_merges_into_idx" ON "company_merges" USING btree ("into_company_id");