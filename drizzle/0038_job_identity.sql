-- Match LinkedIn's numeric identity across guest, session and paid channels. Keep payloads and source references intact.
-- A canonical row from a partial upgrade is kept alongside its legacy row; the repository matches both spellings.
UPDATE raw_postings AS legacy
SET external_id = substr(legacy.external_id, 4)
WHERE legacy.channel_id = 'linkedin-guest' AND legacy.external_id LIKE 'li-%'
  AND NOT EXISTS (
    SELECT 1 FROM raw_postings AS canonical
    WHERE canonical.channel_id = legacy.channel_id AND canonical.external_id = substr(legacy.external_id, 4)
  );
--> statement-breakpoint
-- Key repair creates reciprocal aliases for two spellings of the same marked company. Clearing a mark applies to both,
-- including direct database edits; a one-way/shared alias never propagates a change to an unrelated company.
CREATE OR REPLACE FUNCTION clear_company_alias_marks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE companies AS sibling
  SET watched = CASE WHEN OLD.watched AND NOT NEW.watched THEN false ELSE sibling.watched END,
      blacklisted = CASE WHEN OLD.blacklisted AND NOT NEW.blacklisted THEN false ELSE sibling.blacklisted END
  WHERE sibling.id <> NEW.id
    AND NEW.name = ANY(sibling.aliases) AND sibling.name = ANY(NEW.aliases)
    AND ((OLD.watched AND NOT NEW.watched AND sibling.watched)
      OR (OLD.blacklisted AND NOT NEW.blacklisted AND sibling.blacklisted));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS clear_company_alias_marks ON companies;
--> statement-breakpoint
CREATE TRIGGER clear_company_alias_marks AFTER UPDATE OF watched, blacklisted ON companies
FOR EACH ROW WHEN ((OLD.watched AND NOT NEW.watched) OR (OLD.blacklisted AND NOT NEW.blacklisted))
EXECUTE FUNCTION clear_company_alias_marks();
