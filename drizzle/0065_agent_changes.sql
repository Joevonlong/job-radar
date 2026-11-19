CREATE TABLE IF NOT EXISTS "agent_change_log" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"log_id" uuid NOT NULL,
	"cursor_key" "bytea" NOT NULL,
	"key_id" uuid NOT NULL,
	"system_identifier" bigint NOT NULL,
	"database_oid" "oid" NOT NULL,
	"pruned_through_tx" "xid8",
	"pruned_through_seq" bigint,
	CONSTRAINT "agent_change_log_singleton_check" CHECK ("agent_change_log"."singleton"),
	CONSTRAINT "agent_change_log_cursor_key_length_check" CHECK (octet_length("agent_change_log"."cursor_key") = 32),
	CONSTRAINT "agent_change_log_pruned_through_check" CHECK (("agent_change_log"."pruned_through_tx" is null) = ("agent_change_log"."pruned_through_seq" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_changes" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_changes_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tx" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"key_kind" text NOT NULL,
	"key" text NOT NULL,
	"blocks" integer NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_changes_tx_seq_idx" ON "agent_changes" USING btree ("tx","seq");--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_reset() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.agent_change_log (singleton, log_id, cursor_key, key_id, system_identifier, database_oid)
  SELECT true, pg_catalog.gen_random_uuid(),
    pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid()),
    pg_catalog.gen_random_uuid(), control.system_identifier, db.oid
  FROM pg_catalog.pg_control_system() AS control, pg_catalog.pg_database AS db
  WHERE db.datname = pg_catalog.current_database()
  ON CONFLICT (singleton) DO UPDATE SET
    log_id = excluded.log_id,
    cursor_key = excluded.cursor_key,
    key_id = excluded.key_id,
    system_identifier = excluded.system_identifier,
    database_oid = excluded.database_oid,
    pruned_through_tx = NULL,
    pruned_through_seq = NULL;

  DELETE FROM public.agent_changes;
END;
$$;--> statement-breakpoint
SELECT public.agent_changes_reset() WHERE NOT EXISTS (SELECT FROM public.agent_change_log);--> statement-breakpoint

-- Block masks follow src/lib/db/sync-sources.ts. Job blocks in bit order are job, translation, breakdown,
-- salary, company, ghost, lifecycle, match, tracking and notes (1 through 512), followed by app (1024),
-- app.notes (2048), fav (4096), fav.notes (8192). The removal bits are job (1), application (2) and favorite (4).
CREATE OR REPLACE FUNCTION public.agent_changes_append(
  change_kind text, old_key text, new_key text, change_blocks integer, old_removed integer DEFAULT 0
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.agent_changes (key_kind, key, blocks, removed)
  SELECT change_kind, change.key, change_blocks, change.removed
  FROM (VALUES (CASE WHEN old_key IS DISTINCT FROM new_key THEN old_key END, old_removed), (new_key, 0)) AS change(key, removed)
  WHERE change_blocks <> 0 AND change.key IS NOT NULL;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_jobs_presence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.agent_changes (key_kind, key, blocks, removed) VALUES ('job', OLD.id::text, 1023, 1);
  ELSE
    INSERT INTO public.agent_changes (key_kind, key, blocks) VALUES ('job', NEW.id::text, 1023);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON jobs;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_jobs_presence();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_jobs_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_blocks integer;
BEGIN
  change_blocks :=
    CASE WHEN OLD.title IS DISTINCT FROM NEW.title THEN 1 | 8 | 128 | 1024 | 4096 ELSE 0 END |
    CASE WHEN OLD.company_id IS DISTINCT FROM NEW.company_id THEN 1 | 8 | 16 | 32 | 128 | 1024 | 4096 ELSE 0 END |
    CASE WHEN OLD.locations_json IS DISTINCT FROM NEW.locations_json THEN 1 | 8 | 4096 ELSE 0 END |
    CASE WHEN OLD.workplace IS DISTINCT FROM NEW.workplace OR OLD.contract IS DISTINCT FROM NEW.contract
      OR OLD.is_agency IS DISTINCT FROM NEW.is_agency OR OLD.language IS DISTINCT FROM NEW.language THEN 1 ELSE 0 END |
    CASE WHEN OLD.german_level_required IS DISTINCT FROM NEW.german_level_required OR OLD.skills IS DISTINCT FROM NEW.skills
      THEN 1 | 128 ELSE 0 END |
    CASE WHEN OLD.posted_at IS DISTINCT FROM NEW.posted_at OR OLD.first_seen_at IS DISTINCT FROM NEW.first_seen_at
      THEN 1 | 4096 ELSE 0 END |
    CASE WHEN OLD.salary_json IS DISTINCT FROM NEW.salary_json THEN 1 | 8 | 128 ELSE 0 END |
    CASE WHEN OLD.seniority IS DISTINCT FROM NEW.seniority THEN 1 | 8 ELSE 0 END |
    CASE WHEN OLD.title_norm IS DISTINCT FROM NEW.title_norm THEN 8 ELSE 0 END |
    CASE WHEN OLD.description IS DISTINCT FROM NEW.description THEN 1 | 2 | 4 | 32 | 128 ELSE 0 END |
    CASE WHEN (OLD.description IS DISTINCT FROM NEW.description OR OLD.description_md5 IS DISTINCT FROM NEW.description_md5)
      AND coalesce(OLD.description_md5, md5(coalesce(OLD.description, ''))) IS DISTINCT FROM
        coalesce(NEW.description_md5, md5(coalesce(NEW.description, ''))) THEN 191 ELSE 0 END |
    CASE WHEN OLD.status IS DISTINCT FROM NEW.status THEN 1 | 64 | 256 | 1024 | 4096 ELSE 0 END |
    CASE WHEN (OLD.status = 'possibly_closed' AND OLD.dormant_at IS NOT NULL AND OLD.dormant_at > OLD.last_seen_at)
      IS DISTINCT FROM
        (NEW.status = 'possibly_closed' AND NEW.dormant_at IS NOT NULL AND NEW.dormant_at > NEW.last_seen_at)
      THEN 64 | 256 | 1024 ELSE 0 END |
    CASE WHEN (OLD.link_check_json->>'outcome') IS DISTINCT FROM (NEW.link_check_json->>'outcome')
      THEN 256 | 1024 ELSE 0 END |
    CASE WHEN ((OLD.link_check_json->>'outcome') IS NOT DISTINCT FROM 'phrase') IS DISTINCT FROM
        ((NEW.link_check_json->>'outcome') IS NOT DISTINCT FROM 'phrase') THEN 64 ELSE 0 END |
    CASE WHEN OLD.relisted_at IS DISTINCT FROM NEW.relisted_at OR coalesce(OLD.relist_count, 0) IS DISTINCT FROM coalesce(NEW.relist_count, 0)
      THEN 64 ELSE 0 END;
  INSERT INTO public.agent_changes (key_kind, key, blocks) VALUES ('job', NEW.id::text, change_blocks);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON jobs;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON jobs FOR EACH ROW WHEN (
  OLD.title IS DISTINCT FROM NEW.title OR
  OLD.company_id IS DISTINCT FROM NEW.company_id OR
  OLD.locations_json IS DISTINCT FROM NEW.locations_json OR
  OLD.workplace IS DISTINCT FROM NEW.workplace OR
  OLD.contract IS DISTINCT FROM NEW.contract OR
  OLD.is_agency IS DISTINCT FROM NEW.is_agency OR
  OLD.language IS DISTINCT FROM NEW.language OR
  OLD.german_level_required IS DISTINCT FROM NEW.german_level_required OR
  OLD.skills IS DISTINCT FROM NEW.skills OR
  OLD.posted_at IS DISTINCT FROM NEW.posted_at OR
  OLD.first_seen_at IS DISTINCT FROM NEW.first_seen_at OR
  OLD.salary_json IS DISTINCT FROM NEW.salary_json OR
  OLD.seniority IS DISTINCT FROM NEW.seniority OR
  OLD.title_norm IS DISTINCT FROM NEW.title_norm OR
  OLD.description IS DISTINCT FROM NEW.description OR
  (OLD.description_md5 IS DISTINCT FROM NEW.description_md5
    AND coalesce(OLD.description_md5, md5(coalesce(OLD.description, ''))) IS DISTINCT FROM
      coalesce(NEW.description_md5, md5(coalesce(NEW.description, '')))) OR
  OLD.status IS DISTINCT FROM NEW.status OR
  (OLD.status = 'possibly_closed' AND OLD.dormant_at IS NOT NULL AND OLD.dormant_at > OLD.last_seen_at)
    IS DISTINCT FROM
      (NEW.status = 'possibly_closed' AND NEW.dormant_at IS NOT NULL AND NEW.dormant_at > NEW.last_seen_at) OR
  (OLD.link_check_json->>'outcome') IS DISTINCT FROM (NEW.link_check_json->>'outcome') OR
  OLD.relisted_at IS DISTINCT FROM NEW.relisted_at OR
  coalesce(OLD.relist_count, 0) IS DISTINCT FROM coalesce(NEW.relist_count, 0)
) EXECUTE FUNCTION public.agent_changes_jobs_update();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_job_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_blocks integer := TG_ARGV[0]::integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.agent_changes (key_kind, key, blocks)
      SELECT 'job', OLD.job_id::text, change_blocks FROM public.jobs WHERE id = OLD.job_id;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.job_id IS DISTINCT FROM NEW.job_id THEN
      INSERT INTO public.agent_changes (key_kind, key, blocks) VALUES ('job', OLD.job_id::text, change_blocks);
    END IF;
    INSERT INTO public.agent_changes (key_kind, key, blocks) VALUES ('job', NEW.job_id::text, change_blocks);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_job_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_blocks integer;
BEGIN
  change_blocks := CASE WHEN OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.raw_posting_id IS DISTINCT FROM NEW.raw_posting_id
    THEN 191 ELSE 0 END |
    CASE WHEN OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.id IS DISTINCT FROM NEW.id
      OR OLD.channel_id IS DISTINCT FROM NEW.channel_id OR OLD.url IS DISTINCT FROM NEW.url
      OR OLD.apply_url IS DISTINCT FROM NEW.apply_url OR OLD.priority IS DISTINCT FROM NEW.priority
      OR OLD.first_seen_at IS DISTINCT FROM NEW.first_seen_at THEN 1 | 4096 ELSE 0 END;
  PERFORM public.agent_changes_append('job', OLD.job_id::text, NEW.job_id::text, change_blocks);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON job_sources;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_sources
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('4287');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_sources;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_sources FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR
  OLD.id IS DISTINCT FROM NEW.id OR
  OLD.raw_posting_id IS DISTINCT FROM NEW.raw_posting_id OR
  OLD.channel_id IS DISTINCT FROM NEW.channel_id OR
  OLD.url IS DISTINCT FROM NEW.url OR
  OLD.apply_url IS DISTINCT FROM NEW.apply_url OR
  OLD.priority IS DISTINCT FROM NEW.priority OR
  OLD.first_seen_at IS DISTINCT FROM NEW.first_seen_at
) EXECUTE FUNCTION public.agent_changes_job_sources();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_raw_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.agent_changes (key_kind, key, blocks) VALUES ('raw_posting', NEW.id::text, 191);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON raw_postings;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE OF payload_fingerprint, payload_hash, payload_json ON raw_postings
  FOR EACH ROW WHEN (
    coalesce(OLD.payload_fingerprint, OLD.payload_hash, md5(OLD.payload_json::text)) IS DISTINCT FROM
      coalesce(NEW.payload_fingerprint, NEW.payload_hash, md5(NEW.payload_json::text))
  ) EXECUTE FUNCTION public.agent_changes_raw_posting();--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_change_presence ON signals;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON signals
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('1');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON signals;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON signals FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR
  OLD.id IS DISTINCT FROM NEW.id OR
  OLD.tier IS DISTINCT FROM NEW.tier OR
  OLD.kind IS DISTINCT FROM NEW.kind OR
  OLD.value_json IS DISTINCT FROM NEW.value_json OR
  OLD.quote IS DISTINCT FROM NEW.quote OR
  OLD.quote_offset IS DISTINCT FROM NEW.quote_offset OR
  OLD.quote_source IS DISTINCT FROM NEW.quote_source OR
  OLD.extractor IS DISTINCT FROM NEW.extractor
) EXECUTE FUNCTION public.agent_changes_job_child('1');--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_trap_scan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.agent_changes_append('job', OLD.job_id::text, NEW.job_id::text,
    CASE WHEN OLD.job_id IS DISTINCT FROM NEW.job_id
      OR OLD.description_hash IS DISTINCT FROM NEW.description_hash
      OR OLD.sources_hash IS DISTINCT FROM NEW.sources_hash
      OR OLD.rules_hash IS DISTINCT FROM NEW.rules_hash THEN 191 ELSE 1 END);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON trap_scans;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON trap_scans
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('191');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON trap_scans;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON trap_scans FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR
  OLD.description_hash IS DISTINCT FROM NEW.description_hash OR
  OLD.sources_hash IS DISTINCT FROM NEW.sources_hash OR
  OLD.rules_hash IS DISTINCT FROM NEW.rules_hash OR
  OLD.trap_count IS DISTINCT FROM NEW.trap_count OR
  OLD.suspicious_count IS DISTINCT FROM NEW.suspicious_count
) EXECUTE FUNCTION public.agent_changes_trap_scan();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_trap_span() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.agent_changes_append('job',
    CASE WHEN OLD.in_description AND (NEW.in_description IS FALSE OR OLD.job_id IS DISTINCT FROM NEW.job_id) THEN OLD.job_id::text END,
    CASE WHEN NEW.in_description THEN NEW.job_id::text END,
    1 | 4 | 32 | 128);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_insert ON job_traps;--> statement-breakpoint
CREATE TRIGGER agent_change_insert AFTER INSERT ON job_traps FOR EACH ROW WHEN (NEW.in_description)
  EXECUTE FUNCTION public.agent_changes_job_child('165');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_delete ON job_traps;--> statement-breakpoint
CREATE TRIGGER agent_change_delete AFTER DELETE ON job_traps FOR EACH ROW WHEN (OLD.in_description)
  EXECUTE FUNCTION public.agent_changes_job_child('165');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_traps;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_traps FOR EACH ROW WHEN (
  OLD.in_description IS DISTINCT FROM NEW.in_description OR
  (NEW.in_description AND (
    OLD.job_id IS DISTINCT FROM NEW.job_id OR
    OLD.id IS DISTINCT FROM NEW.id OR
    OLD.quote IS DISTINCT FROM NEW.quote OR
    OLD.quote_offset IS DISTINCT FROM NEW.quote_offset OR
    OLD.technique IS DISTINCT FROM NEW.technique OR
    OLD.method IS DISTINCT FROM NEW.method
  ))
) EXECUTE FUNCTION public.agent_changes_trap_span();--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_change_presence ON translations;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON translations
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('2');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON translations;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON translations FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR
  OLD.lang IS DISTINCT FROM NEW.lang OR
  OLD.content IS DISTINCT FROM NEW.content OR
  OLD.source_hash IS DISTINCT FROM NEW.source_hash OR
  OLD.created_at IS DISTINCT FROM NEW.created_at
) EXECUTE FUNCTION public.agent_changes_job_child('2');--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_change_presence ON job_breakdowns;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_breakdowns
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('4');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_breakdowns;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_breakdowns FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR
  OLD.content IS DISTINCT FROM NEW.content OR
  OLD.prompt_version IS DISTINCT FROM NEW.prompt_version OR
  OLD.analyzed_at IS DISTINCT FROM NEW.analyzed_at
) EXECUTE FUNCTION public.agent_changes_job_child('4');--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_change_presence ON job_ghost;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_ghost
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('32');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_ghost;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_ghost FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR
  OLD.level IS DISTINCT FROM NEW.level OR
  OLD.score IS DISTINCT FROM NEW.score OR
  OLD.evidence IS DISTINCT FROM NEW.evidence OR
  OLD.dismissed_at IS DISTINCT FROM NEW.dismissed_at OR
  OLD.dismissed_codes IS DISTINCT FROM NEW.dismissed_codes
) EXECUTE FUNCTION public.agent_changes_job_child('32');--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_scores_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_blocks integer;
BEGIN
  change_blocks := CASE WHEN OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.id IS DISTINCT FROM NEW.id OR
    OLD.score IS DISTINCT FROM NEW.score OR OLD.stale IS DISTINCT FROM NEW.stale OR
    OLD.german_level IS DISTINCT FROM NEW.german_level OR OLD.filter_result IS DISTINCT FROM NEW.filter_result OR
    OLD.created_at IS DISTINCT FROM NEW.created_at THEN 1 | 128 ELSE 0 END |
    CASE WHEN OLD.rank_value IS DISTINCT FROM NEW.rank_value THEN 1 ELSE 0 END |
    CASE WHEN OLD.ai_score IS DISTINCT FROM NEW.ai_score OR OLD.german_penalty IS DISTINCT FROM NEW.german_penalty OR
    OLD.filter_reasons IS DISTINCT FROM NEW.filter_reasons OR OLD.fit_reasons IS DISTINCT FROM NEW.fit_reasons OR
    OLD.gaps IS DISTINCT FROM NEW.gaps OR OLD.reason_evidence IS DISTINCT FROM NEW.reason_evidence OR
    OLD.summaries IS DISTINCT FROM NEW.summaries OR OLD.summary_zh IS DISTINCT FROM NEW.summary_zh OR
    OLD.summary_en IS DISTINCT FROM NEW.summary_en OR OLD.output_lang IS DISTINCT FROM NEW.output_lang OR
    OLD.scored_at IS DISTINCT FROM NEW.scored_at THEN 128 ELSE 0 END;
  PERFORM public.agent_changes_append('job', OLD.job_id::text, NEW.job_id::text, change_blocks);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON scores;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON scores
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('129');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON scores;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON scores FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR
  OLD.id IS DISTINCT FROM NEW.id OR
  OLD.score IS DISTINCT FROM NEW.score OR
  OLD.stale IS DISTINCT FROM NEW.stale OR
  OLD.german_level IS DISTINCT FROM NEW.german_level OR
  OLD.filter_result IS DISTINCT FROM NEW.filter_result OR
  OLD.created_at IS DISTINCT FROM NEW.created_at OR
  OLD.rank_value IS DISTINCT FROM NEW.rank_value OR
  OLD.ai_score IS DISTINCT FROM NEW.ai_score OR
  OLD.german_penalty IS DISTINCT FROM NEW.german_penalty OR
  OLD.filter_reasons IS DISTINCT FROM NEW.filter_reasons OR
  OLD.fit_reasons IS DISTINCT FROM NEW.fit_reasons OR
  OLD.gaps IS DISTINCT FROM NEW.gaps OR
  OLD.reason_evidence IS DISTINCT FROM NEW.reason_evidence OR
  OLD.summaries IS DISTINCT FROM NEW.summaries OR
  OLD.summary_zh IS DISTINCT FROM NEW.summary_zh OR
  OLD.summary_en IS DISTINCT FROM NEW.summary_en OR
  OLD.output_lang IS DISTINCT FROM NEW.output_lang OR
  OLD.scored_at IS DISTINCT FROM NEW.scored_at
) EXECUTE FUNCTION public.agent_changes_scores_update();--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_change_presence ON job_current_scores;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_current_scores
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('4096');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_current_scores;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_current_scores FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.rank_value IS DISTINCT FROM NEW.rank_value
) EXECUTE FUNCTION public.agent_changes_job_child('4096');--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_change_presence ON job_visa;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_visa
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('128');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_visa;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_visa FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.status IS DISTINCT FROM NEW.status OR OLD.evidence IS DISTINCT FROM NEW.evidence
) EXECUTE FUNCTION public.agent_changes_job_child('128');--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_blocks integer;
  had_note boolean;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.job_id IS DISTINCT FROM NEW.job_id) THEN
    had_note := OLD.notes_md IS NOT NULL OR EXISTS (
      SELECT FROM public.application_events WHERE application_id = OLD.id AND note IS NOT NULL
    );
    PERFORM public.agent_changes_append('job', OLD.job_id::text, NULL,
      256 | 1024 | 2048 | (CASE WHEN had_note THEN 512 ELSE 0 END), 2);
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR OLD.job_id IS DISTINCT FROM NEW.job_id THEN
    change_blocks := 256 | 1024 |
      CASE WHEN NEW.notes_md IS NOT NULL OR had_note THEN 512 | 2048 ELSE 0 END;
  ELSE
    change_blocks :=
      CASE WHEN OLD.status IS DISTINCT FROM NEW.status OR OLD.status_changed_at IS DISTINCT FROM NEW.status_changed_at
        OR OLD.next_action IS DISTINCT FROM NEW.next_action OR OLD.next_action_at IS DISTINCT FROM NEW.next_action_at
        OR OLD.interview_rounds IS DISTINCT FROM NEW.interview_rounds OR OLD.created_at IS DISTINCT FROM NEW.created_at
        THEN 256 | 1024 ELSE 0 END |
      CASE WHEN OLD.notes_md IS DISTINCT FROM NEW.notes_md THEN 512 | 2048 ELSE 0 END;
  END IF;

  PERFORM public.agent_changes_append('job', NULL, NEW.job_id::text, change_blocks);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_insert ON applications;--> statement-breakpoint
CREATE TRIGGER agent_change_insert AFTER INSERT ON applications
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_application();--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_delete ON applications;--> statement-breakpoint
CREATE TRIGGER agent_change_delete BEFORE DELETE ON applications
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_application();--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON applications;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON applications FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR
  OLD.status IS DISTINCT FROM NEW.status OR
  OLD.status_changed_at IS DISTINCT FROM NEW.status_changed_at OR
  OLD.next_action IS DISTINCT FROM NEW.next_action OR
  OLD.next_action_at IS DISTINCT FROM NEW.next_action_at OR
  OLD.interview_rounds IS DISTINCT FROM NEW.interview_rounds OR
  OLD.created_at IS DISTINCT FROM NEW.created_at OR
  OLD.notes_md IS DISTINCT FROM NEW.notes_md
) EXECUTE FUNCTION public.agent_changes_application();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_application_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_job bigint;
  new_job bigint;
  change_blocks integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT job_id INTO old_job FROM public.applications WHERE id = OLD.application_id;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.application_id = NEW.application_id THEN
    change_blocks :=
      CASE WHEN OLD.id IS DISTINCT FROM NEW.id OR OLD.from_status IS DISTINCT FROM NEW.from_status
        OR OLD.to_status IS DISTINCT FROM NEW.to_status OR OLD.at IS DISTINCT FROM NEW.at
        OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at OR OLD.reference IS DISTINCT FROM NEW.reference
        THEN 256 | 1024 ELSE 0 END |
      CASE WHEN OLD.note IS DISTINCT FROM NEW.note OR (NEW.note IS NOT NULL AND
        (OLD.id IS DISTINCT FROM NEW.id OR OLD.at IS DISTINCT FROM NEW.at))
        THEN 512 | 2048 ELSE 0 END |
      CASE WHEN NEW.note IS NOT NULL AND
        (OLD.from_status IS DISTINCT FROM NEW.from_status OR OLD.to_status IS DISTINCT FROM NEW.to_status)
        THEN 2048 ELSE 0 END;
    PERFORM public.agent_changes_append('job', NULL, old_job::text, change_blocks);
  ELSE
    IF old_job IS NOT NULL THEN
      PERFORM public.agent_changes_append('job', old_job::text, NULL,
        256 | 1024 | (CASE WHEN OLD.note IS NOT NULL THEN 512 | 2048 ELSE 0 END));
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT job_id INTO new_job FROM public.applications WHERE id = NEW.application_id;
      PERFORM public.agent_changes_append('job', NULL, new_job::text,
        256 | 1024 | (CASE WHEN NEW.note IS NOT NULL THEN 512 | 2048 ELSE 0 END));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON application_events;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON application_events
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_application_event();--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON application_events;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON application_events FOR EACH ROW WHEN (
  OLD.application_id IS DISTINCT FROM NEW.application_id OR
  OLD.id IS DISTINCT FROM NEW.id OR
  OLD.from_status IS DISTINCT FROM NEW.from_status OR
  OLD.to_status IS DISTINCT FROM NEW.to_status OR
  OLD.at IS DISTINCT FROM NEW.at OR
  OLD.occurred_at IS DISTINCT FROM NEW.occurred_at OR
  OLD.reference IS DISTINCT FROM NEW.reference OR
  OLD.note IS DISTINCT FROM NEW.note
) EXECUTE FUNCTION public.agent_changes_application_event();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_favorite() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_blocks integer;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.job_id IS DISTINCT FROM NEW.job_id) THEN
    change_blocks := 4096 | 8192;
    IF EXISTS (SELECT FROM public.jobs WHERE id = OLD.job_id) THEN
      change_blocks := change_blocks | 256 | 1024 | (CASE WHEN OLD.note IS NOT NULL THEN 512 ELSE 0 END);
    END IF;
    PERFORM public.agent_changes_append('job', OLD.job_id::text, NULL, change_blocks, 4);
    IF TG_OP = 'DELETE' THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR OLD.job_id IS DISTINCT FROM NEW.job_id THEN
    change_blocks := 256 | 1024 | 4096 | (CASE WHEN NEW.note IS NOT NULL THEN 512 | 8192 ELSE 0 END);
  ELSE
    change_blocks := CASE WHEN OLD.created_at IS DISTINCT FROM NEW.created_at THEN 256 | 1024 | 4096 ELSE 0 END |
      CASE WHEN OLD.note IS DISTINCT FROM NEW.note THEN 512 | 8192 ELSE 0 END;
  END IF;
  PERFORM public.agent_changes_append('job', NULL, NEW.job_id::text, change_blocks);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON job_favorites;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_favorites
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_favorite();--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_favorites;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_favorites FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.note IS DISTINCT FROM NEW.note
) EXECUTE FUNCTION public.agent_changes_favorite();--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_change_presence ON job_seen;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_seen
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('1280');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_seen;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_seen FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id
) EXECUTE FUNCTION public.agent_changes_job_child('1280');--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_change_presence ON job_filter_overrides;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_filter_overrides
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('1280');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_filter_overrides;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_filter_overrides FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.action IS DISTINCT FROM NEW.action
) EXECUTE FUNCTION public.agent_changes_job_child('1280');--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_closure_override() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.agent_changes_append('job', OLD.job_id::text, NEW.job_id::text,
    CASE WHEN OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.action IS DISTINCT FROM NEW.action
      THEN 1 | 64 | 256 | 1024 | 4096 ELSE 256 | 1024 END);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON job_closure_overrides;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON job_closure_overrides
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_job_child('5441');--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON job_closure_overrides;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON job_closure_overrides FOR EACH ROW WHEN (
  OLD.job_id IS DISTINCT FROM NEW.job_id OR OLD.action IS DISTINCT FROM NEW.action OR OLD.created_at IS DISTINCT FROM NEW.created_at
) EXECUTE FUNCTION public.agent_changes_closure_override();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_company_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.agent_changes (key_kind, key, blocks) VALUES ('company', NEW.id::text,
    CASE WHEN OLD.name IS DISTINCT FROM NEW.name THEN 1 | 1024 | 4096 ELSE 0 END |
    CASE WHEN OLD.name_norm IS DISTINCT FROM NEW.name_norm THEN 8 | 32 | 128 ELSE 0 END);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON companies;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON companies FOR EACH ROW WHEN (
  OLD.name IS DISTINCT FROM NEW.name OR OLD.name_norm IS DISTINCT FROM NEW.name_norm
) EXECUTE FUNCTION public.agent_changes_company_update();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_salary_lookup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.agent_changes_append('salary_key',
    CASE WHEN TG_OP <> 'INSERT' AND OLD.status = 'done' THEN OLD.lookup_key END,
    CASE WHEN TG_OP <> 'DELETE' AND NEW.status = 'done' THEN NEW.lookup_key END, 8);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON salary_lookups;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON salary_lookups
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_salary_lookup();--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON salary_lookups;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON salary_lookups FOR EACH ROW WHEN (
  (OLD.status = 'done' OR NEW.status = 'done') AND (
    OLD.lookup_key IS DISTINCT FROM NEW.lookup_key OR
    OLD.id IS DISTINCT FROM NEW.id OR
    OLD.status IS DISTINCT FROM NEW.status OR
    OLD.result_json IS DISTINCT FROM NEW.result_json OR
    OLD.fetched_at IS DISTINCT FROM NEW.fetched_at OR
    OLD.expires_at IS DISTINCT FROM NEW.expires_at OR
    OLD.prompt_version IS DISTINCT FROM NEW.prompt_version
  )
) EXECUTE FUNCTION public.agent_changes_salary_lookup();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_benchmark() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_group text;
  new_group text;
BEGIN
  IF TG_OP <> 'UPDATE' OR
    (OLD.role_family, OLD.seniority, OLD.geo_level, OLD.geo_key, OLD.currency, OLD.n, OLD.median, OLD.quantiles)
      IS DISTINCT FROM
    (NEW.role_family, NEW.seniority, NEW.geo_level, NEW.geo_key, NEW.currency, NEW.n, NEW.median, NEW.quantiles)
  THEN
    IF TG_OP <> 'INSERT' THEN
      old_group := jsonb_build_array(OLD.role_family, OLD.seniority, OLD.geo_level, OLD.geo_key, OLD.currency)::text;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_group := jsonb_build_array(NEW.role_family, NEW.seniority, NEW.geo_level, NEW.geo_key, NEW.currency)::text;
    END IF;
    PERFORM public.agent_changes_append('benchmark', old_group, new_group, 8);
  END IF;

  IF coalesce(OLD.n_ai > 0, false) IS DISTINCT FROM coalesce(NEW.n_ai > 0, false) THEN
    INSERT INTO public.agent_changes (key_kind, key, blocks)
      SELECT 'benchmark', '*', 8
      WHERE NOT EXISTS (
        SELECT FROM public.agent_changes WHERE tx = pg_current_xact_id() AND key_kind = 'benchmark' AND key = '*'
      );
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON salary_benchmarks;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON salary_benchmarks
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_benchmark();--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON salary_benchmarks;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON salary_benchmarks FOR EACH ROW WHEN (
  OLD.role_family IS DISTINCT FROM NEW.role_family OR
  OLD.seniority IS DISTINCT FROM NEW.seniority OR
  OLD.geo_level IS DISTINCT FROM NEW.geo_level OR
  OLD.geo_key IS DISTINCT FROM NEW.geo_key OR
  OLD.currency IS DISTINCT FROM NEW.currency OR
  OLD.n IS DISTINCT FROM NEW.n OR
  OLD.median IS DISTINCT FROM NEW.median OR
  OLD.quantiles IS DISTINCT FROM NEW.quantiles OR
  (OLD.n_ai > 0) IS DISTINCT FROM (NEW.n_ai > 0)
) EXECUTE FUNCTION public.agent_changes_benchmark();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.agent_changes_company_research() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.agent_changes_append('company',
    CASE WHEN TG_OP <> 'INSERT' AND OLD.status = 'ok' THEN OLD.company_id::text END,
    CASE WHEN TG_OP <> 'DELETE' AND NEW.status = 'ok' THEN NEW.company_id::text END, 16);
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_presence ON company_research;--> statement-breakpoint
CREATE TRIGGER agent_change_presence AFTER INSERT OR DELETE ON company_research
  FOR EACH ROW EXECUTE FUNCTION public.agent_changes_company_research();--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_change_update ON company_research;--> statement-breakpoint
CREATE TRIGGER agent_change_update AFTER UPDATE ON company_research FOR EACH ROW WHEN (
  (OLD.status = 'ok' OR NEW.status = 'ok') AND (
    OLD.company_id IS DISTINCT FROM NEW.company_id OR
    OLD.id IS DISTINCT FROM NEW.id OR
    OLD.status IS DISTINCT FROM NEW.status OR
    OLD.result_json IS DISTINCT FROM NEW.result_json OR
    OLD.fetched_at IS DISTINCT FROM NEW.fetched_at OR
    OLD.expires_at IS DISTINCT FROM NEW.expires_at
  )
) EXECUTE FUNCTION public.agent_changes_company_research();
