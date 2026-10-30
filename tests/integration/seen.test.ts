import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { addFavorite, closeDb, countJobListSeen, getDb, isSeen, listJobs, listUnseenJobIds, markSeen, markSeenIds, markUnseen, setApplicationStatus, undoBulkSeen, type JobFilters } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

/**
 * The seen state of single jobs. The upgrade's backfill (run here from the migration file itself), first sighting kept,
 * "mark all seen" over every page of a filtered list with an undo that takes back only its batch, and the unseen filter.
 */

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

afterAll(async () => {
  await closeDb();
});

let companyId = 0;

beforeEach(async () => {
  const [company] = await getDb().execute<{ id: number }>(sql`insert into companies (name, name_norm) values ('Acme', 'acme') returning id`);
  companyId = Number(company!.id);
});

async function addJob(title: string, firstSeen: string, over: { rank?: number; workplace?: string } = {}): Promise<number> {
  const [job] = await getDb().execute<{ id: string }>(sql`
    insert into jobs (company_id, title, title_norm, workplace, first_seen_at, last_seen_at)
    values (${companyId}, ${title}, ${title.toLowerCase()}, ${over.workplace ?? "unknown"}, ${firstSeen}::timestamptz, ${firstSeen}::timestamptz)
    returning id`);
  const id = Number(job!.id);
  if (over.rank !== undefined) await getDb().execute(sql`insert into scores (job_id, filter_result, score, rank_value) values (${id}, 'passed', ${over.rank}, ${over.rank})`);
  return id;
}

/** The backfill statement of the upgrade, read from the migration that ships it (the orchestrator may renumber the file, not rename it). */
function backfillStatement(): string {
  const dir = path.join(process.cwd(), "drizzle");
  const file = readdirSync(dir).find((name) => name.endsWith("_ux_seen_closed.sql"));
  if (!file) throw new Error("no ux_seen_closed migration");
  const statement = readFileSync(path.join(dir, file), "utf8")
    .split("--> statement-breakpoint")
    .find((part) => part.includes('INSERT INTO "job_seen"'));
  if (!statement) throw new Error("no backfill statement in the migration");
  return statement;
}

async function runBackfill(): Promise<void> {
  await getDb().execute(sql.raw(backfillStatement()));
}

async function seenRows(): Promise<{ jobId: number; via: string }[]> {
  const rows = await getDb().execute<{ job_id: string; via: string }>(sql`select job_id, via from job_seen order by job_id`);
  return rows.map((row) => ({ jobId: Number(row.job_id), via: row.via }));
}

async function setVisit(seenUpTo: string | null): Promise<void> {
  await getDb().execute(sql`insert into runtime_state (key, value) values ('ui:visit', ${JSON.stringify({ seenUpTo, lastActiveAt: "2026-10-09T08:00:00Z" })}::jsonb)`);
}

describe("upgrade backfill (D2)", () => {
  it("without a visit marker every job is seen", async () => {
    const a = await addJob("A", "2026-10-01T10:00:00Z");
    const b = await addJob("B", "2026-10-09T10:00:00Z");
    await runBackfill();
    expect(await seenRows()).toEqual([
      { jobId: a, via: "migration" },
      { jobId: b, via: "migration" },
    ]);
  });

  it("with a marker, jobs up to it are seen and later ones stay unseen", async () => {
    await setVisit("2026-10-05T00:00:00Z");
    const before = await addJob("Before", "2026-10-04T10:00:00Z");
    const at = await addJob("At", "2026-10-05T00:00:00Z");
    const after = await addJob("After", "2026-10-06T10:00:00Z");
    await runBackfill();
    expect((await seenRows()).map((row) => row.jobId)).toEqual([before, at]);
    expect(await isSeen(getDb(), after)).toBe(false);
  });

  it("a job with an application or a star is seen whatever the marker, and running it twice changes nothing", async () => {
    await setVisit("2026-10-05T00:00:00Z");
    const applied = await addJob("Applied", "2026-10-08T10:00:00Z");
    const starred = await addJob("Starred", "2026-10-08T11:00:00Z");
    const fresh = await addJob("Fresh", "2026-10-08T12:00:00Z");
    await setApplicationStatus(getDb(), applied, "applied");
    await addFavorite(getDb(), starred);
    await runBackfill();
    await runBackfill();
    expect((await seenRows()).map((row) => row.jobId)).toEqual([applied, starred]);
    expect(await isSeen(getDb(), fresh)).toBe(false);
  });
});

describe("seen state of single jobs", () => {
  it("keeps the first sighting: a later look changes neither the time nor the way", async () => {
    const id = await addJob("A", "2026-10-01T10:00:00Z");
    expect(await markSeen(getDb(), id, "detail", new Date("2026-10-09T10:00:00Z"))).toBe(true);
    expect(await markSeen(getDb(), id, "source", new Date("2026-10-09T11:00:00Z"))).toBe(false);
    const [row] = await getDb().execute<{ via: string; seen_at: Date | string }>(sql`select via, seen_at from job_seen where job_id = ${id}`);
    expect(row!.via).toBe("detail");
    expect(new Date(row!.seen_at).toISOString()).toBe("2026-10-09T10:00:00.000Z");
    // unseen again, then seen again
    expect(await markUnseen(getDb(), id)).toBe(true);
    expect(await isSeen(getDb(), id)).toBe(false);
    expect(await markSeen(getDb(), id, "action")).toBe(true);
  });

  it("the list rows carry it, and a deleted job takes its row along", async () => {
    const a = await addJob("A", "2026-10-01T10:00:00Z", { rank: 80 });
    const b = await addJob("B", "2026-10-02T10:00:00Z", { rank: 70 });
    await markSeen(getDb(), a, "detail");
    const result = await listJobs(getDb(), { filters: {}, sort: "rank", page: 1, pageSize: 10, timezone: TZ });
    expect(result.jobs.map((job) => [job.id, job.seen])).toEqual([
      [a, true],
      [b, false],
    ]);
    await getDb().execute(sql`delete from jobs where id = ${a}`);
    expect(await seenRows()).toEqual([]);
  });
});

describe("mark all seen and the unseen filter", () => {
  async function arrange(): Promise<{ remote: number[]; onsite: number[] }> {
    const remote: number[] = [];
    const onsite: number[] = [];
    for (let i = 0; i < 7; i++) remote.push(await addJob(`Remote ${i}`, `2026-10-0${i + 1}T10:00:00Z`, { rank: 50 + i, workplace: "remote" }));
    for (let i = 0; i < 3; i++) onsite.push(await addJob(`Onsite ${i}`, `2026-10-0${i + 1}T11:00:00Z`, { rank: 60 + i, workplace: "onsite" }));
    return { remote, onsite };
  }
  const remoteOnly: JobFilters = { workplaces: ["remote"] };

  it("covers every page of the filtered list, the same jobs listJobs counts", async () => {
    const { remote, onsite } = await arrange();
    await markSeen(getDb(), remote[0]!, "detail");
    const list = await listJobs(getDb(), { filters: { ...remoteOnly, unseenOnly: true }, sort: "rank", page: 1, pageSize: 2, timezone: TZ });
    expect(list.total).toBe(6);
    expect(list.pageCount).toBe(3);
    const counts = await countJobListSeen(getDb(), { filters: remoteOnly, timezone: TZ, since: null });
    expect(counts.unseen).toBe(6);

    const ids = await listUnseenJobIds(getDb(), { filters: remoteOnly, timezone: TZ });
    expect(ids.sort((x, y) => x - y)).toEqual(remote.slice(1).sort((x, y) => x - y));
    expect(await markSeenIds(getDb(), ids, new Date("2026-10-09T12:00:00Z"))).toBe(6);
    expect((await listJobs(getDb(), { filters: { ...remoteOnly, unseenOnly: true }, sort: "rank", page: 1, pageSize: 2, timezone: TZ })).total).toBe(0);
    // the other jobs are untouched
    for (const id of onsite) expect(await isSeen(getDb(), id)).toBe(false);
  });

  it("leaves out jobs first seen after the page was drawn (they were never on screen)", async () => {
    const { remote } = await arrange();
    await markSeen(getDb(), remote[0]!, "detail");
    const ids = await listUnseenJobIds(getDb(), { filters: remoteOnly, timezone: TZ, firstSeenUpTo: new Date("2026-10-05T10:00:00Z") });
    expect(ids.sort((x, y) => x - y)).toEqual(remote.slice(1, 5).sort((x, y) => x - y));
  });

  it("the undo removes only that batch: jobs seen before it, or by another batch, stay seen", async () => {
    const { remote, onsite } = await arrange();
    await markSeen(getDb(), remote[0]!, "detail");
    const first = new Date("2026-10-09T12:00:00Z");
    const second = new Date("2026-10-09T12:05:00Z");
    await markSeenIds(getDb(), onsite, first);
    await markSeenIds(getDb(), remote, second);
    expect(await undoBulkSeen(getDb(), second)).toBe(6);
    expect(await isSeen(getDb(), remote[0]!)).toBe(true);
    for (const id of remote.slice(1)) expect(await isSeen(getDb(), id)).toBe(false);
    for (const id of onsite) expect(await isSeen(getDb(), id)).toBe(true);
  });

  it("unseen combines with the other filters; counts and list agree; 'new since' counts after the marker", async () => {
    const { remote, onsite } = await arrange();
    await markSeen(getDb(), onsite[0]!, "detail");
    await markSeen(getDb(), remote[6]!, "action");
    const onsiteUnseen = await listJobs(getDb(), { filters: { workplaces: ["onsite"], unseenOnly: true }, sort: "first_seen", page: 1, pageSize: 10, timezone: TZ });
    expect(onsiteUnseen.jobs.map((job) => job.id)).toEqual([onsite[2], onsite[1]]);
    const counts = await countJobListSeen(getDb(), { filters: { workplaces: ["onsite"] }, timezone: TZ, since: new Date("2026-10-02T00:00:00Z") });
    expect(counts).toEqual({ unseen: 2, newSince: 2 });
    const all = await countJobListSeen(getDb(), { filters: {}, timezone: TZ, since: null });
    expect(all).toEqual({ unseen: 8, newSince: 0 });
  });
});
