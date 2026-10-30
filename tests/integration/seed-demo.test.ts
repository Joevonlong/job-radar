import { expectNoDrift } from "./current-scores-support";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { isFictionalDomain, realEmails } from "../../e2e-demo/guard";

import { closeDb, getDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { DEMO_APPLICATIONS, seedDemoDatabase } from "@/lib/db/seed-demo";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-07T08:00:00Z");
const TABLES = ["jobs", "companies", "raw_postings", "job_sources", "applications", "application_events", "job_traps", "runs", "cycles"];

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) out[table] = Number((await getDb().execute<{ n: string }>(sql.raw(`select count(*)::text as n from ${table}`)))[0]?.n);
  return out;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);
  await closeDb();
});

describe("seedDemoDatabase", () => {
  it("adds the statuses the seed has no card for, a trap on a scored job, and gives the same rows when run again", async () => {
    const first = await seedDemoDatabase(getDb(), { now: NOW, timezone: TZ });
    expect(first.demoApplications).toBe(DEMO_APPLICATIONS.length);
    await expectNoDrift(getDb());
    const before = await counts();

    const statuses = await getDb().execute<{ status: string }>(sql`select distinct status::text as status from applications`);
    const seen = new Set(statuses.map((r) => r.status));
    for (const status of ["new", "interviewing", "offer"]) expect(seen.has(status)).toBe(true);

    const traps = await getDb().execute<{ title: string; score: string | null; salary: string | null }>(
      sql`select j.title, s.rank_value::text as score, j.salary_json::text as salary from job_traps t join jobs j on j.id = t.job_id left join scores s on s.job_id = j.id where t.quote_source = 'raw'`,
    );
    expect(traps.some((t) => t.score !== null && t.salary !== null)).toBe(true);

    await seedDemoDatabase(getDb(), { now: NOW, timezone: TZ });
    expect(await counts()).toEqual(before);
    await expectNoDrift(getDb());
  });

  it("uses only fictional links and e-mail addresses", async () => {
    await seedDemoDatabase(getDb(), { now: NOW, timezone: TZ });
    const links = await getDb().execute<{ url: string }>(sql`select url from raw_postings where url is not null union select url from job_sources where url is not null union select apply_url from job_sources where apply_url is not null`);
    expect(links.length).toBeGreaterThan(0);
    for (const { url: link } of links) expect(isFictionalDomain(new URL(link).hostname), link).toBe(true);

    const text = await getDb().execute<{ body: string }>(
      sql`select coalesce(description, '') || ' ' || coalesce(title, '') as body from jobs union all select payload_json::text from raw_postings union all select coalesce(notes_md, '') from applications`,
    );
    for (const { body } of text) expect(realEmails(body)).toEqual([]);
  });
});
