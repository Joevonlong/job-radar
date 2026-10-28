import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import {
  addFavorite,
  clearClosureOverride,
  closeDb,
  countJobList,
  getClosureOverride,
  getDb,
  getJobDetail,
  listFavoriteJobs,
  listJobs,
  listPushCandidates,
  listScoreQueue,
  listTodayJobs,
  reopenJob,
  restoreClosureOverride,
  setClosureOverride,
  type JobFilters,
} from "@/lib/db";
import { closedReasonSql, effectivelyNotClosedSql, effectiveStatusSql } from "@/lib/db/queries/job-status";
import { touchJobsSeen } from "@/lib/db/repos/jobs";
import { resetUxTablesCache } from "@/lib/db/repos/ux-tables";
import { runMigrations } from "@/lib/db/migrate";
import { closedReason, effectiveJobStatus, type AutoStatus, type ClosureAction, type ClosedReason, type LinkCheckOutcome } from "@/lib/jobs/closure";

/**
 * The user's closed / open judgement on top of the automatic status. Lists hide what shows as closed unless a status is
 * asked for, the status filter and the "Closed (N)" count match what shows, favorites list everything, and the score queue and the
 * Telegram candidates leave out jobs the user closed. The source returning a job never clears the user's close.
 */

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-10T10:00:00Z");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
  resetUxTablesCache();
});

afterAll(async () => {
  await closeDb();
});

let companyId = 0;
let snapshotId = 0;

beforeEach(async () => {
  const db = getDb();
  const [company] = await db.execute<{ id: number }>(sql`insert into companies (name, name_norm) values ('Acme', 'acme') returning id`);
  companyId = Number(company!.id);
  const [snapshot] = await db.execute<{ id: string }>(sql`insert into profile_snapshots (kind, content_yaml, hash) values ('me', 'x: 1', 'h1') returning id`);
  snapshotId = Number(snapshot!.id);
});

async function addJob(title: string, status: AutoStatus, over: { firstSeen?: string; linkCheck?: object } = {}): Promise<number> {
  const firstSeen = over.firstSeen ?? "2026-10-10T08:00:00Z";
  const [job] = await getDb().execute<{ id: string }>(sql`
    insert into jobs (company_id, title, title_norm, status, first_seen_at, last_seen_at, link_check_json)
    values (${companyId}, ${title}, ${title.toLowerCase()}, ${status}, ${firstSeen}::timestamptz, ${firstSeen}::timestamptz, ${over.linkCheck ? JSON.stringify(over.linkCheck) : null}::jsonb)
    returning id`);
  const id = Number(job!.id);
  await getDb().execute(sql`insert into scores (job_id, profile_snapshot_id, filter_result, score, rank_value, scored_at) values (${id}, ${snapshotId}, 'passed', null, null, now())`);
  return id;
}

const listIds = async (filters: JobFilters = {}) => (await listJobs(getDb(), { filters, sort: "first_seen", dir: "asc", page: 1, pageSize: 50, timezone: TZ })).jobs.map((j) => j.id);
const closedView: JobFilters = { statuses: ["closed", "possibly_closed"] };

describe("overrides and undo", () => {
  it("set returns the judgement before it; restore puts it back; reopen clears a close of an open job", async () => {
    const id = await addJob("A", "active");
    expect(await setClosureOverride(getDb(), id, "closed", "said so on the phone", NOW)).toBeNull();
    expect(await getClosureOverride(getDb(), id)).toMatchObject({ action: "closed", note: "said so on the phone" });
    const previous = await setClosureOverride(getDb(), id, "closed", null, NOW);
    expect(previous).toMatchObject({ action: "closed", note: "said so on the phone" });
    await restoreClosureOverride(getDb(), id, previous);
    expect((await getClosureOverride(getDb(), id))?.note).toBe("said so on the phone");
    // an automatically open job: reopening is clearing the close
    await reopenJob(getDb(), id, NOW);
    expect(await getClosureOverride(getDb(), id)).toBeNull();
    await restoreClosureOverride(getDb(), id, null);
    expect(await getClosureOverride(getDb(), id)).toBeNull();
  });

  it("reopening an automatically closed job writes `open`, and clearing it shows the automatic status again", async () => {
    const id = await addJob("Gone", "closed");
    await reopenJob(getDb(), id, NOW);
    expect((await getClosureOverride(getDb(), id))?.action).toBe("open");
    expect((await getJobDetail(getDb(), id))?.status).toBe("active");
    await clearClosureOverride(getDb(), id);
    expect((await getJobDetail(getDb(), id))?.status).toBe("closed");
  });
});

describe("lists", () => {
  it("/jobs hides what shows as closed by default, keeps possibly closed, and matches the status filter on what shows", async () => {
    const open = await addJob("Open", "active");
    const possibly = await addJob("Possibly", "possibly_closed");
    const dormant = await addJob("Dormant", "possibly_closed");
    await getDb().execute(sql`update jobs set dormant_at = '2026-10-11T08:00:00Z'::timestamptz where id = ${dormant}`);
    const gone = await addJob("Gone", "closed");
    const mine = await addJob("Mine", "active");
    const rescued = await addJob("Rescued", "closed");
    await setClosureOverride(getDb(), mine, "closed", null, NOW);
    await setClosureOverride(getDb(), rescued, "open", null, NOW);

    expect(await listIds()).toEqual([open, possibly, rescued]);
    expect(await listIds(closedView)).toEqual([possibly, dormant, gone, mine]);
    expect(await listIds({ statuses: ["active"] })).toEqual([open, rescued]);
    expect(await countJobList(getDb(), { filters: closedView, timezone: TZ })).toBe(4);
    const cards = (await listJobs(getDb(), { filters: closedView, sort: "first_seen", dir: "asc", page: 1, pageSize: 50, timezone: TZ })).jobs;
    expect(cards.map((c) => [c.status, c.closedReason])).toEqual([
      ["possibly_closed", "possibly"],
      ["possibly_closed", "dormant"],
      ["closed", "gone"],
      ["closed", "manual"],
    ]);
  });

  it("names a phrase hit, with its evidence on the card", async () => {
    const evidence = { outcome: "phrase", httpStatus: 200, phrase: "no longer accepting", quote: "We are no longer accepting applications", url: "https://jobs.example/1", at: "2026-10-09T08:00:00.000Z" };
    const id = await addJob("Phrase", "possibly_closed", { linkCheck: evidence });
    const [card] = (await listJobs(getDb(), { filters: closedView, sort: "first_seen", dir: "asc", page: 1, pageSize: 50, timezone: TZ })).jobs;
    expect(card).toMatchObject({ id, closedReason: "phrase", linkCheck: evidence });
  });

  it("Today hides closed jobs unless a status is asked for; favorites list them all", async () => {
    const open = await addJob("Open", "active");
    const mine = await addJob("Mine", "active");
    const gone = await addJob("Gone", "closed");
    await setClosureOverride(getDb(), mine, "closed", null, NOW);
    await addFavorite(getDb(), mine);
    await addFavorite(getDb(), gone);
    const today = { now: NOW, timezone: TZ };
    expect((await listTodayJobs(getDb(), today)).map((j) => j.id)).toEqual([open]);
    expect((await listTodayJobs(getDb(), { ...today, extra: { statuses: ["closed"] } })).map((j) => j.id).sort()).toEqual([mine, gone].sort());
    expect((await listFavoriteJobs(getDb(), { sort: "starred" })).map((j) => j.id).sort()).toEqual([mine, gone].sort());
  });

  it("the SQL closure reasons agree with the pure rule in every combination, including an aliased jobs table", async () => {
    const expected = new Map<number, ClosedReason | null>();
    for (const auto of ["active", "possibly_closed", "closed"] as const)
      for (const action of [null, "open", "closed"] as const)
        for (const check of [null, "alive", "gone", "phrase", "unknown", "robots"] as const satisfies readonly (LinkCheckOutcome | null)[])
          for (const dormant of [false, true]) {
            const id = await addJob("Combination", auto, check ? { linkCheck: { outcome: check } } : {});
            if (action) await setClosureOverride(getDb(), id, action, null, NOW);
            if (dormant) await getDb().execute(sql`update jobs set dormant_at = '2026-10-11T08:00:00Z'::timestamptz where id = ${id}`);
            expected.set(id, closedReason(auto, action, check, dormant));
          }
    const rows = await getDb().execute<{ id: string; reason: ClosedReason | null; listed: boolean; status: AutoStatus }>(sql`select j.id,
      ${closedReasonSql(true, true, "j")} as reason, ${effectivelyNotClosedSql(true, "j")} as listed, ${effectiveStatusSql(true, "j")} as status from jobs j`);
    for (const row of rows) {
      expect(row.reason).toBe(expected.get(Number(row.id)));
      expect(row.listed).toBe(row.status !== "closed");
    }
  });

  it("the SQL rule agrees with effectiveJobStatus for every combination", async () => {
    const autos: AutoStatus[] = ["active", "possibly_closed", "closed"];
    const actions: Array<ClosureAction | null> = [null, "closed", "open"];
    const expected = new Map<number, AutoStatus>();
    for (const auto of autos)
      for (const action of actions) {
        const id = await addJob(`${auto}-${action ?? "none"}`, auto);
        if (action) await setClosureOverride(getDb(), id, action, null, NOW);
        expected.set(id, effectiveJobStatus(auto, action));
      }
    const rows = await getDb().execute<{ id: string; status: string }>(sql`select "jobs"."id" as id, ${effectiveStatusSql(true)} as status from jobs`);
    for (const row of rows) expect(row.status).toBe(expected.get(Number(row.id)));
  });
});

describe("scoring and notifications", () => {
  it("leave out jobs the user closed", async () => {
    const open = await addJob("Open", "active");
    const mine = await addJob("Mine", "active");
    await setClosureOverride(getDb(), mine, "closed", null, NOW);
    expect((await listScoreQueue(getDb(), { snapshotId })).map((j) => j.jobId)).toEqual([open]);
    expect((await listPushCandidates(getDb(), { since: new Date("2026-10-01T00:00:00Z") })).map((c) => c.jobId)).toEqual([open]);
  });

  it("take jobs the user kept open, whatever the checks said; not ones only possibly closed", async () => {
    const open = await addJob("Open", "active");
    const kept = await addJob("Kept", "possibly_closed");
    const keptGone = await addJob("KeptGone", "closed");
    await addJob("Possibly", "possibly_closed");
    await setClosureOverride(getDb(), kept, "open", null, NOW);
    await setClosureOverride(getDb(), keptGone, "open", null, NOW);
    const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
    expect(sorted((await listScoreQueue(getDb(), { snapshotId })).map((j) => j.jobId))).toEqual(sorted([open, kept, keptGone]));
    expect(sorted((await listPushCandidates(getDb(), { since: new Date("2026-10-01T00:00:00Z") })).map((c) => c.jobId))).toEqual(sorted([open, kept, keptGone]));
  });
});

describe("the source returns the job again", () => {
  it("reopens the automatic status but keeps the user's close; a phrase hit stays possibly closed", async () => {
    const db = getDb();
    await db.execute(sql`insert into channels (id, family, kind) values ('fx-ats', 'ats', 'api') on conflict do nothing`);
    const mine = await addJob("Mine", "possibly_closed", { firstSeen: "2026-10-01T08:00:00Z" });
    const phrase = await addJob("Phrase", "possibly_closed", {
      firstSeen: "2026-10-01T08:00:00Z",
      linkCheck: { outcome: "phrase", httpStatus: 200, phrase: "x", quote: "x", url: "https://jobs.example/2", at: "2026-10-05T08:00:00.000Z" },
    });
    await setClosureOverride(db, mine, "closed", "gone on their site", NOW);
    for (const [i, id] of [mine, phrase].entries()) {
      const [raw] = await db.execute<{ id: string }>(sql`insert into raw_postings (channel_id, external_id, payload_json, fetched_at) values ('fx-ats', ${`r${i}`}, '{}'::jsonb, ${NOW.toISOString()}::timestamptz) returning id`);
      await db.execute(sql`insert into job_sources (job_id, raw_posting_id, channel_id, url) values (${id}, ${Number(raw!.id)}, 'fx-ats', ${`https://jobs.example/${i}`})`);
    }
    const touched = await touchJobsSeen(db);
    expect(touched).toEqual({ seen: 2, reopened: 1 });
    const detail = await getJobDetail(db, mine);
    expect(detail?.closure).toMatchObject({ autoStatus: "active", reason: "manual", override: { action: "closed", note: "gone on their site" } });
    expect(detail?.status).toBe("closed");
    expect(detail!.lastSeenAt.getTime()).toBeGreaterThan(detail!.closure.override!.createdAt.getTime() - 1);
    expect((await getJobDetail(db, phrase))?.status).toBe("possibly_closed");
  });
});
