import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  createCycle,
  createRun,
  finishCycle,
  finishRun,
  getCycle,
  getLatestHeartbeat,
  getRun,
  listRunsForCycle,
  pruneHeartbeats,
  writeHeartbeat,
} from "@/lib/db";

const EXPECTED_TABLES = [
  "activity_events",
  "activity_spans",
  "ai_usage",
  "application_answer_versions",
  "application_events",
  "application_questions",
  "applications",
  "ats_board_candidates",
  "ats_boards",
  "channels",
  "companies",
  "control_requests",
  "cycles",
  "delivery_items",
  "email_messages",
  "interest_suggestions",
  "job_breakdowns",
  "job_closure_overrides",
  "job_current_scores",
  "job_favorites",
  "job_filter_overrides",
  "job_ghost",
  "job_seen",
  "job_sources",
  "job_traps",
  "job_visa",
  "jobs",
  "notifications",
  "profile_snapshots",
  "raw_postings",
  "run_deliveries",
  "runner_heartbeats",
  "runs",
  "runtime_state",
  "salary_benchmarks",
  "salary_lookups",
  "scores",
  "signal_scans",
  "signals",
  "source_registry",
  "translation_progress",
  "translations",
  "trap_scans",
];

const url = inject("testDatabaseUrl");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

afterAll(async () => {
  await closeDb();
});

/** Postgres error code of a failed query (drizzle wraps the driver error in `cause`). */
async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? (error as { code?: string }).code;
  }
  return undefined;
}

describe("migrations", () => {
  it("creates every table from plan §11 plus runner_heartbeats", async () => {
    const rows = await getDb().execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
  });

  it("is idempotent: running the migrator again changes nothing and does not fail", async () => {
    const before = await getDb().execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    await expect(runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } })).resolves.toBeUndefined();
    await expect(runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } })).resolves.toBeUndefined();
    const after = await getDb().execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("uses timestamptz for every timestamp column", async () => {
    const rows = await getDb().execute<{ table_name: string; column_name: string }>(
      sql`select table_name, column_name from information_schema.columns
          where table_schema = 'public' and data_type = 'timestamp without time zone'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("cycles, runs and heartbeats", () => {
  it("creates and finishes a cycle and a run, and reads them back", async () => {
    const db = getDb();
    await db.insert(schema.channels).values({ id: "linkedin", family: "linkedin", kind: "guest" }).onConflictDoNothing();

    const cycle = await createCycle(db, { kind: "manual" });
    expect(cycle.status).toBe("running");
    expect(cycle.finishedAt).toBeNull();

    const run = await createRun(db, { channelId: "linkedin", cycleId: cycle.id, queryHash: "abc123" });
    expect(run.status).toBe("running");

    const finishedRun = await finishRun(db, run.id, { status: "succeeded", fetched: 12, newCount: 3, cost: 0.25 });
    expect(finishedRun).toMatchObject({ status: "succeeded", fetched: 12, newCount: 3, cost: 0.25, error: null });
    expect(finishedRun?.finishedAt).toBeInstanceOf(Date);

    const failed = await createRun(db, { channelId: "linkedin", cycleId: cycle.id });
    await finishRun(db, failed.id, { status: "failed", error: "rate limited" });

    const finishedCycle = await finishCycle(db, cycle.id, { status: "partial", summary: { channels: 2 } });
    expect(finishedCycle?.status).toBe("partial");
    expect(finishedCycle?.summaryJson).toEqual({ channels: 2 });

    expect(await getCycle(db, cycle.id)).toMatchObject({ id: cycle.id, status: "partial" });
    expect(await getRun(db, run.id)).toMatchObject({ id: run.id, queryHash: "abc123" });
    const listed = await listRunsForCycle(db, cycle.id);
    expect(listed.map((r) => r.status)).toEqual(["succeeded", "failed"]);
  });

  it("returns null for unknown ids", async () => {
    const db = getDb();
    expect(await getCycle(db, 987654321)).toBeNull();
    expect(await finishCycle(db, 987654321, { status: "failed" })).toBeNull();
  });

  it("writes heartbeats, returns the latest and prunes old ones", async () => {
    const db = getDb();
    await db.insert(schema.runnerHeartbeats).values({ process: "runner", at: new Date(Date.now() - 3 * 24 * 3600 * 1000) });
    const first = await writeHeartbeat(db, "runner");
    const second = await writeHeartbeat(db, "runner");

    const latest = await getLatestHeartbeat(db);
    expect(latest?.id).toBe(second.id);
    expect(latest?.id).toBeGreaterThan(first.id);
    expect(Date.now() - (latest?.at.getTime() ?? 0)).toBeLessThan(10_000);

    const pruned = await pruneHeartbeats(db, new Date(Date.now() - 24 * 3600 * 1000));
    expect(pruned).toBe(1);
  });
});

describe("constraints", () => {
  it("rejects duplicate raw postings per (channel, external id) and keeps the original (C1)", async () => {
    const db = getDb();
    await db.insert(schema.channels).values({ id: "stepstone", family: "stepstone", kind: "scrape" }).onConflictDoNothing();
    await db.insert(schema.rawPostings).values({ channelId: "stepstone", externalId: "42", payloadJson: { a: 1 } });
    const code = await pgErrorCode(
      db.insert(schema.rawPostings).values({ channelId: "stepstone", externalId: "42", payloadJson: { a: 2 } }),
    );
    expect(code).toBe("23505");
    const rows = await db.select().from(schema.rawPostings).where(eq(schema.rawPostings.externalId, "42"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parseStatus).toBe("pending");
    expect(rows[0]?.payloadJson).toEqual({ a: 1 });
  });

  it("rejects values outside the status enums", async () => {
    const db = getDb();
    await db.insert(schema.channels).values({ id: "stepstone", family: "stepstone", kind: "scrape" }).onConflictDoNothing();
    const code = await pgErrorCode(db.execute(sql`insert into cycles (kind) values ('nightly')`));
    expect(code).toBe("22P02");
    const code2 = await pgErrorCode(
      db.execute(sql`insert into raw_postings (channel_id, external_id, payload_json, parse_status)
                     values ('stepstone', 'x', '{}', 'done')`),
    );
    expect(code2).toBe("22P02");
  });

  it("enforces one source row per (job, raw posting), one message per message id, quotes on signals", async () => {
    const db = getDb();
    await db.insert(schema.channels).values({ id: "stepstone", family: "stepstone", kind: "scrape" }).onConflictDoNothing();
    const [company] = await db.insert(schema.companies).values({ name: "Acme GmbH", nameNorm: "acme" }).returning();
    if (!company) throw new Error("company insert failed");
    const [job] = await db
      .insert(schema.jobs)
      .values({ companyId: company.id, title: "Senior Backend Engineer", titleNorm: "senior backend engineer", description: "Build Postgres-backed services in Berlin" })
      .returning();
    if (!job) throw new Error("job insert failed");
    expect(job).toMatchObject({ status: "active", workplace: "unknown", seniority: "unknown", language: "unknown" });

    const [raw] = await db
      .insert(schema.rawPostings)
      .values({ channelId: "stepstone", externalId: "src-1", payloadJson: {} })
      .returning();
    if (!raw) throw new Error("raw insert failed");
    const source = { jobId: job.id, rawPostingId: raw.id, channelId: "stepstone" };
    await db.insert(schema.jobSources).values(source);
    expect(await pgErrorCode(db.insert(schema.jobSources).values(source))).toBe("23505");

    const message = { messageId: "<abc@mail>", sender: "alerts@example.com", receivedAt: new Date() };
    await db.insert(schema.emailMessages).values(message);
    expect(await pgErrorCode(db.insert(schema.emailMessages).values(message))).toBe("23505");

    const code = await pgErrorCode(
      db.insert(schema.signals).values({ jobId: job.id, tier: "T1", kind: "salary", quote: "   ", extractor: "rule" }),
    );
    expect(code).toBe("23514");
  });

  it("maintains jobs.search_tsv over title and description for full-text search", async () => {
    const db = getDb();
    const [company] = await db.insert(schema.companies).values({ name: "Acme GmbH", nameNorm: "acme" }).returning();
    if (!company) throw new Error("company insert failed");
    await db.insert(schema.jobs).values({
      companyId: company.id,
      title: "Senior Backend Engineer",
      titleNorm: "senior backend engineer",
      description: "Build Postgres-backed services in Berlin",
    });
    const hits = await db.execute<{ title: string }>(
      sql`select title from jobs where search_tsv @@ plainto_tsquery('simple', 'postgres berlin')`,
    );
    expect(hits.map((r) => r.title)).toContain("Senior Backend Engineer");
    const misses = await db.execute(sql`select 1 from jobs where search_tsv @@ plainto_tsquery('simple', 'kubernetes')`);
    expect(misses).toHaveLength(0);
  });
});
