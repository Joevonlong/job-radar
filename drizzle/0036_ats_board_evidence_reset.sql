-- Board state written before the completeness rules no longer proves a complete read: the validator may come from a
-- list that was cut short, and last_ok_at may have moved on a read that was not complete. Clear both, so the first
-- read after the upgrade is unconditional and only a complete read under the new rules can lift the offline-evidence guard.
UPDATE "ats_boards" SET "last_ok_at" = NULL, "etag" = NULL;
