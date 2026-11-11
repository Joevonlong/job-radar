-- Metadata of each MCP tool call, never its arguments or results. Safe to run twice, like the migrations before it.
CREATE TABLE IF NOT EXISTS "agent_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"caller" text DEFAULT 'stdio' NOT NULL,
	"token_id" integer,
	"transport" text DEFAULT 'stdio' NOT NULL,
	"capability" text NOT NULL,
	"target_type" text,
	"target_id" bigint,
	"outcome" text NOT NULL,
	"error_category" text,
	"returned_count" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	CONSTRAINT "agent_calls_outcome_check" CHECK ("agent_calls"."outcome" in ('ok', 'not_permitted', 'invalid_input', 'error')),
	CONSTRAINT "agent_calls_error_category_check" CHECK (("agent_calls"."outcome" = 'error' and "agent_calls"."error_category" is not null) or ("agent_calls"."outcome" <> 'error' and "agent_calls"."error_category" is null))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_calls_called_at_idx" ON "agent_calls" USING btree ("called_at");