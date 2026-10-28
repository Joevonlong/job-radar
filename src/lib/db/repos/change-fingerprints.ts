import { sql } from "drizzle-orm";

import type { Db } from "../client";
import type { Executor } from "../executor";

const ready = new WeakSet<Executor>();

/** Web requests can arrive before the runner migrates; cache only a complete schema for this connection handle. */
export async function changeFingerprintsReady(db: Executor): Promise<boolean> {
  if (ready.has(db)) return true;
  const [row] = await db.execute<{ ok: boolean }>(sql`select count(*) = 6 as ok from information_schema.columns
    where table_schema = current_schema() and (
      (table_name = 'jobs' and column_name in ('description_md5', 'description_has_text', 'salary_md5'))
      or (table_name = 'raw_postings' and column_name = 'payload_fingerprint')
      or (table_name = 'scores' and column_name in ('filter_input_hash', 'filter_config_hash')))`);
  if (row?.ok) ready.add(db);
  return row?.ok === true;
}

/**
 * Fill at most one configured batch per table, outside the migration transaction. Each UPDATE commits
 * on its own; locked rows wait for a later cycle. Readers compute missing values until maintenance reaches them.
 */
export async function backfillChangeFingerprints(db: Db, limit: number): Promise<{ jobs: number; rawPostings: number }> {
  const jobs = await db.execute(sql`
    with batch as (
      select id from jobs where description_md5 is null or description_has_text is null or salary_md5 is null
      order by id limit ${limit} for update skip locked
    )
    update jobs j set description_md5 = md5(coalesce(j.description, '')),
      description_has_text = j.description is not null and btrim(j.description) <> '',
      salary_md5 = md5(coalesce(j.salary_json::text, ''))
    from batch where j.id = batch.id`);
  const raw = await db.execute(sql`
    with batch as (
      select id from raw_postings where payload_fingerprint is null
      order by id limit ${limit} for update skip locked
    )
    update raw_postings r set payload_fingerprint = coalesce(r.payload_hash, md5(r.payload_json::text))
    from batch where r.id = batch.id`);
  return { jobs: jobs.count, rawPostings: raw.count };
}
