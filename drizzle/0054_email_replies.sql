-- Replies from Gmail: what the rules made of a mail, and what the user decided. Only the sender domain, a short quote and the subject are kept.
DO $$ BEGIN
  CREATE TYPE "public"."reply_category" AS ENUM('interview_invite', 'rejection', 'offer', 'info_request', 'acknowledgement', 'other', 'unclassified');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."reply_match" AS ENUM('matched', 'ambiguous', 'unmatched');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."reply_state" AS ENUM('pending', 'applied', 'dismissed', 'reverted', 'superseded', 'info');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_replies" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_replies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dedupe_key" text NOT NULL,
	"message_id" text,
	"thread_id" text,
	"sender_domain" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"raw_ref" text NOT NULL,
	"subject" text,
	"quote" text,
	"suspicious_instruction" boolean DEFAULT false NOT NULL,
	"category" "reply_category" NOT NULL,
	"user_category" "reply_category",
	"match" "reply_match" NOT NULL,
	"application_id" bigint,
	"job_id" bigint,
	"match_score" numeric(6, 2),
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestion" jsonb DEFAULT '{"kind":"none"}'::jsonb NOT NULL,
	"state" "reply_state" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"event_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_replies_dedupe_key_uq" UNIQUE("dedupe_key")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_replies" ADD CONSTRAINT "email_replies_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_replies" ADD CONSTRAINT "email_replies_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_replies" ADD CONSTRAINT "email_replies_event_id_application_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."application_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_replies_pending_idx" ON "email_replies" USING btree ("state") WHERE "email_replies"."state" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_replies_application_idx" ON "email_replies" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_replies_thread_idx" ON "email_replies" USING btree ("thread_id");