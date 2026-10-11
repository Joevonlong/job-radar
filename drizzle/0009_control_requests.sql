CREATE TYPE "public"."control_request_kind" AS ENUM('run_cycle', 'rescore_stale');--> statement-breakpoint
CREATE TYPE "public"."control_request_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "control_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "control_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "control_request_kind" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "control_request_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runtime_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "control_requests_status_idx" ON "control_requests" USING btree ("status","id");