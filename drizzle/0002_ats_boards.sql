CREATE TABLE "ats_boards" (
	"ats" text NOT NULL,
	"token" text NOT NULL,
	"etag" text,
	"filter_fingerprint" text,
	"external_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_status" text NOT NULL,
	"last_error_code" text,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone,
	"last_total" integer DEFAULT 0 NOT NULL,
	"last_kept" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ats_boards_ats_token_pk" PRIMARY KEY("ats","token")
);
