CREATE TABLE "ats_board_candidates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ats_board_candidates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ats" text NOT NULL,
	"token" text NOT NULL,
	"region" text,
	"board_url" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'new' NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ats_board_candidates_ats_token_key" UNIQUE("ats","token"),
	CONSTRAINT "ats_board_candidates_status_check" CHECK ("ats_board_candidates"."status" in ('new', 'added', 'dismissed'))
);
