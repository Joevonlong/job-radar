import { z } from "zod";

/**
 * The read-only snapshot behind `pnpm simhash:analyze`: every raw posting, the links to jobs and the stored jobs, as NDJSON.
 * Holds the SQL (database access stays under `src/lib/db/`); a caller passes the function that runs a query.
 */

export type RunQuery = (query: string) => string;

/** Rows per page of raw postings: the payloads are large, and one psql call must fit in memory. */
const RAW_PAGE_SIZE = 1000;

export const snapshotRawSchema = z.object({
  kind: z.literal("raw"),
  id: z.number().int(),
  channel_id: z.string(),
  family: z.string(),
  external_id: z.string(),
  fetched_at: z.string(),
  parse_status: z.string(),
  payload: z.unknown(),
});

export const snapshotSourceSchema = z.object({
  kind: z.literal("source"),
  job_id: z.number().int(),
  raw_posting_id: z.number().int(),
  priority: z.number().int(),
  first_seen_at: z.string(),
});

export const snapshotJobSchema = z.object({
  kind: z.literal("job"),
  id: z.number().int(),
  company_key: z.string(),
  company: z.string(),
  title: z.string(),
  title_norm: z.string(),
  locations_json: z.unknown(),
  simhash: z.string().nullable(),
});

export const snapshotMetaSchema = z.object({
  kind: z.literal("meta"),
  exported_at: z.string(),
  product_sha: z.string(),
  counts: z.object({ raw: z.number().int(), source: z.number().int(), job: z.number().int() }),
});

export type SnapshotRaw = z.infer<typeof snapshotRawSchema>;
export type SnapshotSource = z.infer<typeof snapshotSourceSchema>;
export type SnapshotJob = z.infer<typeof snapshotJobSchema>;
export type SnapshotMeta = z.infer<typeof snapshotMetaSchema>;

export interface DedupeSnapshot {
  meta: SnapshotMeta;
  raws: SnapshotRaw[];
  sources: SnapshotSource[];
  jobs: SnapshotJob[];
}

const rawPageQuery = (afterId: number): string => `select row_to_json(t) from (
  select 'raw' as kind, r.id, r.channel_id, c.family, r.external_id, r.fetched_at, r.parse_status, r.payload_json as payload
  from raw_postings r join channels c on c.id = r.channel_id
  where r.id > ${Math.trunc(afterId)} order by r.id limit ${RAW_PAGE_SIZE}) t`;

const SOURCES_QUERY = `select row_to_json(t) from (
  select 'source' as kind, s.job_id, s.raw_posting_id, s.priority, s.first_seen_at from job_sources s order by s.id) t`;

const JOBS_QUERY = `select row_to_json(t) from (
  select 'job' as kind, j.id, c.name_norm as company_key, c.name as company, j.title, j.title_norm, j.locations_json, j.simhash
  from jobs j join companies c on c.id = j.company_id order by j.id) t`;

/** The queries of the older pair listing (no `--guard`): parsed postings with their job, and stored jobs with a SimHash. */
export const PARSED_POSTINGS_QUERY = `select row_to_json(t) from (
  select r.id, r.channel_id, (select min(s.job_id) from job_sources s where s.raw_posting_id = r.id) as job_id, r.payload_json
  from raw_postings r where r.parse_status = 'parsed' order by r.id) t`;

export const STORED_JOBS_QUERY = `select row_to_json(t) from (
  select j.id, c.name_norm as company_key, c.name as company, j.title, j.title_norm, j.simhash,
    j.locations_json->0->>'city' as city, (select count(*) from job_sources s where s.job_id = j.id) as sources
  from jobs j join companies c on c.id = j.company_id where j.simhash is not null order by j.id) t`;

const rows = (text: string): string[] => text.split("\n").filter((line) => line.trim() !== "");

/** Every query the export sends, in order, up to the first page of raw postings (for checking they only read). */
export const exportQueriesForTest = (): string[] => [rawPageQuery(0), SOURCES_QUERY, JOBS_QUERY];

/** The snapshot as lines: the meta line first, then one line per row, each checked against its schema. */
export function exportSnapshotLines(run: RunQuery, stamp: { exportedAt: string; productSha: string }): string[] {
  const raws: string[] = [];
  for (let afterId = 0; ; ) {
    const page = rows(run(rawPageQuery(afterId)));
    if (page.length === 0) break;
    for (const line of page) {
      afterId = snapshotRawSchema.parse(JSON.parse(line)).id;
      raws.push(line);
    }
    if (page.length < RAW_PAGE_SIZE) break;
  }
  const sources = rows(run(SOURCES_QUERY));
  for (const line of sources) snapshotSourceSchema.parse(JSON.parse(line));
  const jobs = rows(run(JOBS_QUERY));
  for (const line of jobs) snapshotJobSchema.parse(JSON.parse(line));
  const meta: SnapshotMeta = { kind: "meta", exported_at: stamp.exportedAt, product_sha: stamp.productSha, counts: { raw: raws.length, source: sources.length, job: jobs.length } };
  return [JSON.stringify(meta), ...raws, ...sources, ...jobs];
}

const lineSchema = z.discriminatedUnion("kind", [snapshotMetaSchema, snapshotRawSchema, snapshotSourceSchema, snapshotJobSchema]);

/** Read a snapshot file's text (it is checked like any other input). */
export function parseSnapshot(text: string): DedupeSnapshot {
  const snapshot: Omit<DedupeSnapshot, "meta"> & { meta: SnapshotMeta | null } = { meta: null, raws: [], sources: [], jobs: [] };
  for (const line of rows(text)) {
    const row = lineSchema.parse(JSON.parse(line));
    if (row.kind === "meta") snapshot.meta = row;
    else if (row.kind === "raw") snapshot.raws.push(row);
    else if (row.kind === "source") snapshot.sources.push(row);
    else snapshot.jobs.push(row);
  }
  if (snapshot.meta === null) throw new Error("the snapshot has no meta line");
  return { ...snapshot, meta: snapshot.meta };
}
