CREATE TABLE IF NOT EXISTS "agent_budget_usage" (
	"caller" text NOT NULL,
	"action" text NOT NULL,
	"day" date NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_budget_usage_caller_action_day_pk" PRIMARY KEY("caller","action","day"),
	CONSTRAINT "agent_budget_usage_used_nonnegative" CHECK ("agent_budget_usage"."used" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_budget_usage_day_idx" ON "agent_budget_usage" USING btree ("day");