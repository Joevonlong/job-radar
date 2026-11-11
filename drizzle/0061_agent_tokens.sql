-- Agent tokens: a name, the SHA-256 hash and display prefix of the token, its permissions, an optional expiry, last use and revocation. Never the token itself. Safe to run twice, like the migrations before it.
CREATE TABLE IF NOT EXISTS "agent_tokens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_tokens_token_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tokens_token_prefix_idx" ON "agent_tokens" USING btree ("token_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tokens_active_name_uq" ON "agent_tokens" USING btree ("name") WHERE "agent_tokens"."revoked_at" is null;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_calls" ADD CONSTRAINT "agent_calls_token_id_agent_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."agent_tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
