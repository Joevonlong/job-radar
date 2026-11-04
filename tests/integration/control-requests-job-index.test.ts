import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createConnection, type Db } from "@/lib/db/client";
import { findLatestStoryExtractRequest, findOpenFitRequest, findOpenWriterRequest, insertControlRequest } from "@/lib/db/repos/control-requests";
import * as schema from "@/lib/db/schema";

import { createIsolatedDb, type IsolatedDb } from "../helpers/isolated-db";

/**
 * The plans of the real queries on a table with history and a queue backlog. The lookups by job compare `kind::text`, because
 * they also run before the web has migrated, and no index can hold that expression (enum output is not immutable).
 */
let iso: IsolatedDb;
let conn: ReturnType<typeof createConnection>;
let db: Db;
let lastQuery: { query: string; params: unknown[] } | null = null;

beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "controljobindex");
  conn = createConnection(iso.url, { max: 2 });
  db = drizzle(conn.sql, { schema, logger: { logQuery: (query, params) => { lastQuery = { query, params }; } } });
  await conn.sql.unsafe(`
    insert into control_requests (kind, payload, status)
    select (array['translate_job', 'breakdown_job', 'run_ai', 'writer_job', 'writer_fit'])[1 + n % 5]::control_request_kind,
           jsonb_build_object('jobId', n % 1000, 'questionId', n % 7),
           (case when n % 8 = 0 then 'pending' else 'done' end)::control_request_status
    from generate_series(1, 30000) as n
  `);
  await conn.sql.unsafe("analyze control_requests");
}, 60_000);

afterAll(async () => {
  await conn?.sql.end({ timeout: 2 });
  await iso?.drop();
});

/** The plan of the statement `run` sends, with its parameters. */
async function planOf(run: () => Promise<unknown>): Promise<string> {
  await run();
  const { query, params } = lastQuery ?? { query: "", params: [] };
  const rows = await conn.sql.unsafe<{ "QUERY PLAN": string }[]>(`explain (costs off) ${query}`, params as never[]);
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

describe("control_requests lookups", () => {
  it("the kind as text cannot be indexed, so the index leaves it out", async () => {
    await expect(conn.sql.unsafe("create index control_requests_kind_text_probe on control_requests ((kind::text), id)")).rejects.toThrow(/IMMUTABLE/);
  });

  it("the open fit note request of a job uses the index by job during a backlog", async () => {
    expect(await planOf(() => findOpenFitRequest(db, 123))).toContain("control_requests_payload_job_id_idx");
  });

  it("the open writer request of a question uses the index by job during a backlog", async () => {
    expect(await planOf(() => findOpenWriterRequest(db, { jobId: 123, questionId: 4 }))).toContain("control_requests_payload_job_id_idx");
  });

  it("the latest story extraction reaches its kind by index and does not read the table newest first", async () => {
    const plan = await planOf(() => findLatestStoryExtractRequest(db));
    expect(plan).toContain("control_requests_job_id_idx");
    expect(plan).toContain("kind = 'story_extract'");
    expect(plan).not.toContain("control_requests_pkey");
  });

  it("the latest story extraction is the newest of its kind, behind newer requests of other kinds", async () => {
    expect(await findLatestStoryExtractRequest(db)).toBeNull();
    await insertControlRequest(db, { kind: "story_extract", payload: { n: 1 } });
    const newest = await insertControlRequest(db, { kind: "story_extract", payload: { n: 2 } });
    await insertControlRequest(db, { kind: "translate_job", payload: { jobId: 1 } });
    expect((await findLatestStoryExtractRequest(db))?.id).toBe(newest.id);
    await db.execute(sql`delete from control_requests where kind = 'story_extract'`);
  });
});
