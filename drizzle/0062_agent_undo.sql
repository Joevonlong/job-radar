CREATE TABLE IF NOT EXISTS "agent_undo" (
	"audit_id" bigint PRIMARY KEY NOT NULL,
	"data_area" text NOT NULL,
	"kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" bigint NOT NULL,
	"before_value" jsonb NOT NULL,
	"after_fingerprint" text NOT NULL,
	"undone_at" timestamp with time zone,
	"caller" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_undo_audit_id_agent_calls_id_fk' AND conrelid = 'agent_undo'::regclass) THEN
    ALTER TABLE "agent_undo" ADD CONSTRAINT "agent_undo_audit_id_agent_calls_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."agent_calls"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_undo_target_idx" ON "agent_undo" USING btree ("target_type","target_id");