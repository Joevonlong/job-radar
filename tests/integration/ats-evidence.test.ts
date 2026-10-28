import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createDbAtsBoardStore, createSmartrecruitersChannel, type AtsBoardStore } from "@/lib/channels/ats";
import type { FetchLike } from "@/lib/channels/http";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { CompanyEntry } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, createConnection, getAtsBoard, getDb, listRunsForCycle, schema, touchRawPostings, type Db } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { recordAtsBoardCheck } from "@/lib/db/repos/ats-boards";
import { resetDormancyCache } from "@/lib/db/repos/dormancy";
import { markJobsPossiblyClosed } from "@/lib/db/repos/jobs";

import { atsChannelsWith, company, depsWith, fixtureJson, inputs, response, routedFetch } from "../channels/ats/helpers";
import { config, quietLogger } from "../cycle/helpers";
import { checkedName } from "../helpers/isolated-db";

const url = inject("testDatabaseUrl");
const now = new Date("2026-10-07T12:00:00Z");
const lastSeen = new Date("2026-09-07T12:00:00Z"); // 30 days before now; overdue on September 14.
const oldOk = new Date("2026-09-10T12:00:00Z");
const normalRun = new Date("2026-10-06T11:00:00Z");
const checked = new Date("2026-10-06T12:00:00Z");
const earlyRun = new Date("2026-09-20T11:00:00Z");
const middleOk = new Date("2026-09-20T12:00:00Z");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table ats_boards, raw_postings, runs, cycles, channels, jobs, companies restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

async function channel(db: Db, id: string) {
  await db.insert(schema.channels).values({ id, family: "ats", kind: "api" }).onConflictDoNothing();
}

async function successfulRun(db: Db, channelId: string, startedAt = normalRun, windowExtended = false) {
  await channel(db, channelId);
  const finishedAt = new Date(startedAt.getTime() + 60_000);
  const [cycle] = await db.insert(schema.cycles).values({ kind: "manual", status: "succeeded", startedAt, finishedAt }).returning();
  const [run] = await db.insert(schema.runs).values({
    cycleId: cycle!.id, channelId, status: "succeeded", startedAt, finishedAt, windowExtended,
  }).returning();
  return run!;
}

async function source(db: Db, jobId: number, externalId: string, channelId: string, token?: string) {
  await channel(db, channelId);
  const payload = { source: { ats: channelId, ...(token === undefined ? {} : { token }) }, posting: { id: externalId } };
  // This fixture also runs before fingerprint columns exist; even omitted Drizzle fields enter an INSERT as DEFAULT.
  const [raw] = await db.execute<{ id: string }>(sql`
    insert into raw_postings (channel_id, external_id, fetched_at, payload_json)
    values (${channelId}, ${externalId}, ${lastSeen.toISOString()}::timestamptz, ${JSON.stringify(payload)}::jsonb)
    returning id`);
  await db.insert(schema.jobSources).values({ jobId, rawPostingId: Number(raw!.id), channelId, firstSeenAt: lastSeen });
  return raw!;
}

async function overdueJob(db: Db, name: string, token: string | undefined, channelId = "greenhouse") {
  const [employer] = await db.insert(schema.companies).values({ name, nameNorm: name.toLowerCase() }).returning();
  // This fixture also runs before the dormancy migration: name only columns present in that schema.
  const [job] = await db.execute<{ id: string }>(sql`
    insert into jobs (company_id, title, title_norm, status, first_seen_at, last_seen_at)
    values (${employer!.id}, 'Overdue role', 'overdue role', 'active', ${lastSeen.toISOString()}::timestamptz, ${lastSeen.toISOString()}::timestamptz)
    returning id`);
  const id = Number(job!.id);
  await source(db, id, name, channelId, token);
  return id;
}

async function boardState(db: Db, token: string, values: Partial<typeof schema.atsBoards.$inferInsert> = {}) {
  const [row] = await db.insert(schema.atsBoards).values({
    ats: "greenhouse", token, lastStatus: "error", lastErrorCode: "network", consecutiveFailures: 1,
    lastCheckedAt: checked, lastChangedAt: oldOk, lastOkAt: oldOk, etag: 'W/"old"',
    filterFingerprint: "3:previous-filter:10", externalIds: ["still-listed"], detailRetryIds: [], lastTotal: 1, lastKept: 1,
    ...values,
  }).returning();
  return row!;
}

async function activeAgain(db: Db, jobId: number) {
  // Let a positive control run independently even if the negative assertion already exposed a premature closure.
  await db.update(schema.jobs).set({ status: "active" }).where(eq(schema.jobs.id, jobId));
}

describe("per-board evidence for possibly closed ATS jobs", () => {
  it("a successful Greenhouse round closes only the job whose own board was read completely", async () => {
    const db = getDb();
    const x = await overdueJob(db, "absent-x", "X");
    const y = await overdueJob(db, "absent-y", "Y");
    await successfulRun(db, "greenhouse");
    await boardState(db, "X");
    await boardState(db, "Y", { lastStatus: "ok", lastErrorCode: null, consecutiveFailures: 0, lastOkAt: checked });

    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([y]);
    expect.soft((await db.select().from(schema.jobs).where(eq(schema.jobs.id, x)))[0]).toMatchObject({ status: "active", lastSeenAt: lastSeen });

    await activeAgain(db, x);
    await db.update(schema.atsBoards).set({ lastStatus: "ok", lastErrorCode: null, consecutiveFailures: 0, lastOkAt: checked })
      .where(and(eq(schema.atsBoards.ats, "greenhouse"), eq(schema.atsBoards.token, "X")));
    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([x]);
  });

  it.each([
    { name: "a short board read", lastStatus: "short", lastOkAt: oldOk },
    { name: "a checked board with no complete read", lastStatus: "error", lastOkAt: null },
  ])("$name cannot close its overdue job", async ({ lastStatus, lastOkAt }) => {
    const db = getDb();
    const jobId = await overdueJob(db, "absent-x", "X");
    await successfulRun(db, "greenhouse");
    await boardState(db, "X", { lastStatus, lastOkAt });

    expect(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);
    expect((await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)))[0]?.status).toBe("active");
  });

  it("a removed board ages out as before while a board still being checked blocks closure", async () => {
    const db = getDb();
    const removed = await overdueJob(db, "removed-x", "X");
    await overdueJob(db, "checked-y", "Y");
    await successfulRun(db, "greenhouse");
    await boardState(db, "X", { lastCheckedAt: oldOk });
    await boardState(db, "Y");

    expect(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([removed]);
  });

  it("a non-ATS source still needs its own successful run and cannot overrule a failing ATS board", async () => {
    const db = getDb();
    const blocked = await overdueJob(db, "failed-x", "X");
    const complete = await overdueJob(db, "complete-y", "Y");
    await source(db, blocked, "external-x", "external-board", "X");
    await source(db, complete, "external-y", "external-board", "X");
    await boardState(db, "X");
    await boardState(db, "Y", { lastStatus: "ok", lastOkAt: checked });
    await successfulRun(db, "greenhouse");

    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);
    await successfulRun(db, "external-board");
    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([complete]);
  });

  it("an ATS payload without source.token keeps the channel rule while a matching token uses board evidence", async () => {
    const db = getDb();
    await overdueJob(db, "known-board", "X");
    const tokenless = await overdueJob(db, "unknown-board", undefined);
    await boardState(db, "X");
    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);

    await successfulRun(db, "greenhouse");
    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([tokenless]);
  });

  it("associates the complete read with its extended run rather than a later normal run where the board failed", async () => {
    const db = getDb();
    const jobId = await overdueJob(db, "absent-x", "X");
    const extended = await successfulRun(db, "greenhouse", earlyRun, true);
    await successfulRun(db, "greenhouse", normalRun, false);
    await boardState(db, "X", { lastCheckedAt: checked, lastOkAt: middleOk });

    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);

    await activeAgain(db, jobId);
    await db.update(schema.runs).set({ windowExtended: false }).where(eq(schema.runs.id, extended.id));
    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([jobId]);
  });

  it("a last complete read with no channel run at or before it is not closure evidence", async () => {
    const db = getDb();
    await overdueJob(db, "absent-x", "X");
    await successfulRun(db, "greenhouse", normalRun);
    await boardState(db, "X", { lastOkAt: middleOk });

    expect(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);
  });

  it.each(["failed", "partial", "running"] as const)("a %s reading run cannot supply evidence through a later successful mixed round", async (status) => {
    const db = getDb();
    const jobId = await overdueJob(db, "absent-x", "X");
    const reading = await successfulRun(db, "greenhouse", earlyRun);
    await db.update(schema.runs).set({ status, ...(status === "running" ? { finishedAt: null } : {}) })
      .where(eq(schema.runs.id, reading.id));
    // The later run succeeds because Y completed; X failed and retains the earlier read's timestamp.
    await successfulRun(db, "greenhouse", normalRun);
    await boardState(db, "X", { lastOkAt: middleOk });
    await boardState(db, "Y", { lastStatus: "ok", lastErrorCode: null, consecutiveFailures: 0, lastOkAt: checked });

    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);
    expect.soft((await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)))[0]).toMatchObject({
      status: "active", lastSeenAt: lastSeen,
    });

    await activeAgain(db, jobId);
    await db.update(schema.runs).set({ status: "succeeded", finishedAt: middleOk }).where(eq(schema.runs.id, reading.id));
    expect(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([jobId]);
  });
});

const srBoard = company({ name: "Example Labs", ats: "smartrecruiters", token: "ExampleLabs" });
const srBase = "https://api.smartrecruiters.com/v1/companies/ExampleLabs/postings";
const srList = fixtureJson("smartrecruiters-list.json") as { totalFound: number; content: Array<{ id: string }> };
const details = [1, 2, 3].map((number) => fixtureJson(`smartrecruiters-detail-${number}.json`) as { id: string });

/** The SR runCycle harness from ats.test.ts, with an explicit database for the upgrade scenario. */
async function cycle(fetch: FetchLike, options: { db?: Db; at?: Date; boards?: CompanyEntry[]; maxResults?: number; store?: AtsBoardStore } = {}) {
  const db = options.db ?? getDb();
  const at = options.at ?? now;
  const store = options.store ?? createDbAtsBoardStore(db);
  store.touch = (channelId, externalIds) => touchRawPostings(db, { channelId, externalIds, at });
  store.record = (key, update) => recordAtsBoardCheck(db, key, { ...update, checkedAt: at });
  const channels = atsChannelsWith("smartrecruiters", (settings) => {
    settings.enabled = true;
    settings.api_base_url = "https://api.smartrecruiters.com";
    settings.country = "de";
    settings.page_size = 100;
    settings.fetch_details = true;
    settings.max_consecutive_detail_failures = 3;
    settings.max_results = options.maxResults ?? 10;
    settings.title_prefilter = { enabled: false, include_terms: [], exclude_terms: [] };
  });
  channels.http.max_retries = 0;
  channels.circuit_breaker = { failures: 2, cooldown_hours: 1 };
  const registry = new ChannelRegistry();
  registry.register(createSmartrecruitersChannel(depsWith(inputs(options.boards ?? [srBoard]), store)));
  const result = await runCycle("manual", {
    db, registry, config: { ...config(), channels }, logger: quietLogger, sleep: async () => {},
    channelIds: ["smartrecruiters"], fetch, now: () => at,
  });
  expect(result.cycleId).not.toBeNull();
  // The production repositories intentionally use the database clock; arrange the run/evidence ordering explicitly.
  await db.update(schema.runs).set({ startedAt: at, finishedAt: at }).where(eq(schema.runs.cycleId, result.cycleId!));
  return result;
}

describe("SmartRecruiters detail evidence through the real channel", () => {
  it("preserves an absent detail retry through a failed page and the next conditional cycle", async () => {
    const db = getDb();
    const absent = await overdueJob(db, "absent-sr", srBoard.token, "smartrecruiters");
    await successfulRun(db, "smartrecruiters");
    await boardState(db, srBoard.token, { ats: "smartrecruiters" });
    const a = details[0]!;
    const b = details[2]!;
    await db.insert(schema.rawPostings).values({
      channelId: "smartrecruiters", externalId: b.id, fetchedAt: lastSeen,
      payloadJson: { source: { ats: "smartrecruiters", token: srBoard.token }, posting: b },
    });
    const etag = 'W/"unresolved-list"';
    const first = await cycle(routedFetch([
      [`${srBase}?`, response(200, { totalFound: 2, content: [srList.content[0], srList.content[2]] }, { ETag: etag })],
      [`${srBase}/${a.id}`, response(200, a)],
      [`${srBase}/${b.id}`, response(500, "detail unavailable")],
    ]).fetch);
    expect(await listRunsForCycle(db, first.cycleId!)).toMatchObject([{ status: "partial", interrupted: true, fetched: 1 }]);
    const remembered = await getAtsBoard(db, { ats: "smartrecruiters", token: srBoard.token });
    expect(remembered).toMatchObject({ etag, detailRetryIds: [b.id], lastOkAt: oldOk });

    const secondAt = new Date("2026-10-08T12:00:00Z");
    const partial = routedFetch([
      [`${srBase}?limit=100&offset=0`, response(200, { totalFound: 2, content: srList.content.slice(0, 1) })],
      [`${srBase}?limit=100&offset=1`, response(503, "list unavailable")],
      [`${srBase}/${a.id}`, response(200, a)],
    ]);
    const second = await cycle(partial.fetch, { at: secondAt, maxResults: 11 });
    expect(await listRunsForCycle(db, second.cycleId!)).toMatchObject([{ status: "partial", interrupted: true, fetched: 1 }]);
    expect(partial.requests[0]?.headers).not.toHaveProperty("If-None-Match");
    expect.soft(await getAtsBoard(db, { ats: "smartrecruiters", token: srBoard.token })).toEqual({
      ...remembered, lastStatus: "error", lastErrorCode: "network", consecutiveFailures: 1, lastCheckedAt: secondAt,
    });

    const thirdAt = new Date("2026-10-09T12:00:00Z");
    const unchanged = routedFetch([[`${srBase}?`, response(304)]]);
    const third = await cycle(unchanged.fetch, { at: thirdAt });
    expect(unchanged.requests).toHaveLength(1);
    expect(unchanged.requests[0]?.headers["If-None-Match"]).toBe(etag);
    expect.soft((await listRunsForCycle(db, third.cycleId!))[0]).toMatchObject({ status: "failed", fetched: 0, errorCode: "unknown" });
    expect.soft(await getAtsBoard(db, { ats: "smartrecruiters", token: srBoard.token })).toMatchObject({
      lastStatus: "not_modified", lastCheckedAt: thirdAt, lastOkAt: oldOk, detailRetryIds: [b.id], etag,
    });
    expect.soft(await markJobsPossiblyClosed(db, { now: thirdAt, days: 7 })).toEqual([]);
    expect.soft((await db.select().from(schema.jobs).where(eq(schema.jobs.id, absent)))[0]?.status).toBe("active");
  });

  it.each([false, true])("unresolved details and the following 304 preserve evidence (previous complete read: %s)", async (existing) => {
    const db = getDb();
    const absent = await overdueJob(db, "absent-sr", srBoard.token, "smartrecruiters");
    await successfulRun(db, "smartrecruiters");
    // A previously stored detail permits the list ETag to survive the failed detail, so the next sweep really uses 304.
    await db.insert(schema.rawPostings).values({
      channelId: "smartrecruiters", externalId: details[0]!.id, fetchedAt: lastSeen,
      payloadJson: { source: { ats: "smartrecruiters", token: srBoard.token }, posting: details[0] },
    });
    if (existing) await boardState(db, srBoard.token, { ats: "smartrecruiters", lastOkAt: oldOk });
    const etag = 'W/"unresolved"';
    const { fetch, requests } = routedFetch([
      [`${srBase}?`, ({ headers }) => headers["If-None-Match"] === etag ? response(304) : response(200, srList, { ETag: etag })],
      [`${srBase}/${details[0]!.id}`, response(500, "detail unavailable")],
      [`${srBase}/${details[1]!.id}`, response(200, details[1])],
      [`${srBase}/${details[2]!.id}`, response(200, details[2])],
    ]);
    const first = await cycle(fetch);
    expect(await listRunsForCycle(db, first.cycleId!)).toMatchObject([{ status: "partial", interrupted: true, fetched: 2 }]);
    expect.soft(await getAtsBoard(db, { ats: "smartrecruiters", token: srBoard.token })).toMatchObject({
      lastStatus: "ok", lastOkAt: existing ? oldOk : null, lastCheckedAt: now, etag, detailRetryIds: [details[0]!.id],
    });
    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);

    await activeAgain(db, absent);
    const next = new Date("2026-10-08T12:00:00Z");
    const before304 = requests.length;
    const second = await cycle(fetch, { at: next });
    expect.soft((await listRunsForCycle(db, second.cycleId!))[0]).toMatchObject({ status: "failed", fetched: 0 });
    expect.soft(requests.slice(before304)).toMatchObject([{ url: `${srBase}?limit=100&offset=0&country=de`, headers: { "If-None-Match": etag } }]);
    expect.soft(requests.slice(before304)).toHaveLength(1);
    expect.soft(await getAtsBoard(db, { ats: "smartrecruiters", token: srBoard.token })).toMatchObject({
      lastStatus: "not_modified", lastOkAt: existing ? oldOk : null, lastCheckedAt: next, detailRetryIds: [details[0]!.id],
    });
    expect.soft(await markJobsPossiblyClosed(db, { now: next, days: 7 })).toEqual([]);
  });
});

describe("upgrading legacy ATS board evidence", () => {
  it.each([
    { name: "list failure with failed invalidation", listFails: true, rounds: [now] },
    { name: "detail retries with failed invalidation", listFails: false, rounds: [now, new Date("2026-10-08T12:00:00Z")] },
  ])("$name", async ({ listFails, rounds }) => {
    const db = getDb();
    const absent = await overdueJob(db, "D", srBoard.token, "smartrecruiters");
    await successfulRun(db, "smartrecruiters");
    const key = { ats: "smartrecruiters", token: srBoard.token };
    const legacy = await boardState(db, srBoard.token, {
      ats: "smartrecruiters", filterFingerprint: "2:x:10", lastOkAt: checked,
      lastStatus: "ok", lastErrorCode: null, consecutiveFailures: 0, externalIds: ["D"],
    });
    const other = company({ name: "Other Labs", ats: "smartrecruiters", token: "OtherLabs" });
    const invalidations: string[] = [];
    const store: AtsBoardStore = {
      ...createDbAtsBoardStore(db),
      async invalidateEvidence(boardKey) {
        invalidations.push(boardKey.token);
        throw new Error("injected evidence invalidation failure");
      },
    };
    const { fetch, requests } = routedFetch([
      [`${srBase}?`, listFails ? response(500, "list unavailable") : response(200, {
        totalFound: 1, content: srList.content.slice(0, 1),
      }, { ETag: 'W/"unresolved-list"' })],
      [`${srBase}/${details[0]!.id}`, response(500, "detail unavailable")],
      ["/companies/OtherLabs/postings?", response(200, { totalFound: 0, content: [] })],
    ]);

    for (const [round, at] of rounds.entries()) {
      // Re-arm the second closure check even if the first round already exposed premature closure.
      if (round > 0) await activeAgain(db, absent);
      const requestStart = requests.length;
      const result = await cycle(fetch, { boards: [srBoard, other], store, at });
      expect(result.status).toBe("succeeded");
      expect(await listRunsForCycle(db, result.cycleId!)).toMatchObject([
        { channelId: "smartrecruiters", status: "succeeded", interrupted: false, windowExtended: false, fetched: 0 },
      ]);
      expect(invalidations).toEqual([srBoard.token]);
      expect(requests.slice(requestStart).map((request) => request.url)).toEqual([
        `${srBase}?limit=100&offset=0&country=de`,
        ...(listFails ? [] : [`${srBase}/${details[0]!.id}`]),
        "https://api.smartrecruiters.com/v1/companies/OtherLabs/postings?limit=100&offset=0&country=de",
      ]);
      const remembered = await getAtsBoard(db, key);
      expect(remembered).toMatchObject({
        lastStatus: listFails ? "error" : "ok", lastCheckedAt: at,
        filterFingerprint: listFails ? legacy.filterFingerprint : expect.stringMatching(/^3:/),
        detailRetryIds: listFails ? [] : [details[0]!.id],
      });
      expect(await getAtsBoard(db, { ats: "smartrecruiters", token: other.token })).toMatchObject({
        lastStatus: "ok", lastOkAt: at,
      });
      expect.soft(remembered?.lastOkAt, `round ${round + 1}: legacy evidence is discarded`).toBeNull();
      expect.soft(await markJobsPossiblyClosed(db, { now: at, days: 7 }), `round ${round + 1}: no premature closure`).toEqual([]);
      expect.soft((await db.select().from(schema.jobs).where(eq(schema.jobs.id, absent)))[0], `round ${round + 1}: D stays active`).toMatchObject({
        status: "active", lastSeenAt: lastSeen,
      });
    }
  });

  it("invalidates evidence written by a rolled-back build after the reset migration has already run", async () => {
    const db = getDb();
    // The test database has already applied the evidence reset; an older build can write legacy state afterwards.
    const absent = await overdueJob(db, "D", srBoard.token, "smartrecruiters");
    await successfulRun(db, "smartrecruiters");
    const key = { ats: "smartrecruiters", token: srBoard.token };
    const legacy = await boardState(db, srBoard.token, {
      ats: "smartrecruiters", filterFingerprint: "2:x:10", etag: 'W/"p1"', lastOkAt: checked,
      lastChangedAt: checked, externalIds: ["D"], detailRetryIds: ["unresolved"], lastTotal: 2, lastKept: 1,
    });
    // Re-upgrading does not rerun a migration recorded in the journal.
    await runMigrations();
    expect(await getAtsBoard(db, key)).toEqual(legacy);

    const other = company({ name: "Other Labs", ats: "smartrecruiters", token: "OtherLabs" });
    const boards = [srBoard, other];
    let complete = false;
    const routes = routedFetch([
      [`${srBase}?`, () => complete ? response(200, { totalFound: 0, content: [] }) : response(500, "list unavailable")],
      ["/companies/OtherLabs/postings?", response(200, { totalFound: 0, content: [] })],
    ]);
    const beforeRequests: Array<Awaited<ReturnType<typeof getAtsBoard>>> = [];
    const fetch: FetchLike = async (requestUrl, init) => {
      if (requestUrl.startsWith(`${srBase}?`)) beforeRequests.push(await getAtsBoard(db, key));
      return routes.fetch(requestUrl, init);
    };
    const failed = await cycle(fetch, { boards });
    expect(await listRunsForCycle(db, failed.cycleId!)).toMatchObject([{ status: "succeeded", windowExtended: false }]);
    expect(routes.requests[0]?.headers).not.toHaveProperty("If-None-Match");
    // Invalidation must precede HTTP and change only the evidence timestamp and validator, including on a failed read.
    expect.soft(beforeRequests[0]).toEqual({ ...legacy, lastOkAt: null, etag: null });
    const afterFailure = {
      ...legacy, lastOkAt: null, etag: null, lastStatus: "error", lastErrorCode: "network",
      lastCheckedAt: now, consecutiveFailures: legacy.consecutiveFailures + 1,
    };
    expect.soft(await getAtsBoard(db, key)).toEqual(afterFailure);
    expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);

    await activeAgain(db, absent);
    complete = true;
    const next = new Date("2026-10-08T12:00:00Z");
    const finished = await cycle(fetch, { boards, at: next });
    // The still-legacy fingerprint triggers invalidation again; the rest of the failed check must survive it.
    expect.soft(beforeRequests[1]).toEqual(afterFailure);
    expect(await listRunsForCycle(db, finished.cycleId!)).toMatchObject([{ status: "succeeded", windowExtended: false }]);
    expect(await getAtsBoard(db, key)).toMatchObject({ lastStatus: "ok", lastOkAt: next, externalIds: [], detailRetryIds: [] });
    expect(await markJobsPossiblyClosed(db, { now: next, days: 7 })).toEqual([absent]);
  });

  it("clears legacy evidence and the validator until a complete post-upgrade sweep can close an absent job", async () => {
    const admin = new URL(url);
    const name = checkedName(`${admin.pathname.slice(1)}_m36`);
    const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-ats-evidence-mig-"));
    try {
      await adminSql.unsafe(`create database "${name}"`);
      const target = new URL(url);
      target.pathname = `/${name}`;
      fs.cpSync(path.resolve("drizzle"), folder, { recursive: true });
      const journalFile = path.join(folder, "meta", "_journal.json");
      const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      const added = journal.entries.find((entry) => entry.tag === "0036_ats_board_evidence_reset");
      expect(added).toBeDefined();
      if (!added) return; // The assertion is the red result when the migration has not been authored yet.
      fs.writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < added.idx) }));
      await runMigrations({ url: target.toString(), migrationsFolder: folder });

      // runCycle holds one connection for its advisory lock while the collector uses the pool.
      const connection = createConnection(target.toString(), { max: 3 });
      try {
        // The other tests use the current schema; this database must probe its own capabilities.
        resetDormancyCache();
        const db = connection.db;
        const absent = await overdueJob(db, "D", srBoard.token, "smartrecruiters");
        await successfulRun(db, "smartrecruiters");
        const payload = { source: { ats: "smartrecruiters", token: srBoard.token }, posting: details[0] };
        await db.execute(sql`insert into raw_postings (channel_id, external_id, fetched_at, payload_json)
          values ('smartrecruiters', ${details[0]!.id}, ${checked.toISOString()}::timestamptz, ${JSON.stringify(payload)}::jsonb)`);
        const before = await boardState(db, srBoard.token, {
          ats: "smartrecruiters", filterFingerprint: "2:x:10", etag: 'W/"p1"', lastOkAt: checked,
          lastChangedAt: checked, externalIds: [details[0]!.id], lastTotal: 2, lastKept: 1,
        });
        fs.writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= added.idx) }));
        await runMigrations({ url: target.toString(), migrationsFolder: folder });
        expect.soft(await getAtsBoard(db, { ats: "smartrecruiters", token: srBoard.token })).toEqual({ ...before, lastOkAt: null, etag: null });

        // A current runner applies all pending migrations before collecting; keep the reset assertion above isolated.
        await runMigrations({ url: target.toString() });

        let complete = false;
        const { fetch, requests } = routedFetch([
          [`${srBase}?limit=100&offset=0`, ({ headers }) => headers["If-None-Match"] === 'W/"p1"'
            ? response(304)
            : response(200, { totalFound: 2, content: srList.content.slice(0, 1) }, { ETag: 'W/"p1"' })],
          [`${srBase}?limit=100&offset=1`, () => complete
            ? response(200, { content: srList.content.slice(2) })
            : response(429, "page unavailable")],
          [`${srBase}/${details[0]!.id}`, response(200, details[0])],
          [`${srBase}/${details[2]!.id}`, response(200, details[2])],
        ]);
        const interrupted = await cycle(fetch, { db });
        expect.soft((await listRunsForCycle(db, interrupted.cycleId!))[0]).toMatchObject({ status: "partial", interrupted: true });
        expect.soft(requests[0]?.headers["If-None-Match"]).toBeUndefined();
        expect.soft(requests.some((request) => request.url.includes("offset=1"))).toBe(true);
        expect.soft(await getAtsBoard(db, { ats: "smartrecruiters", token: srBoard.token })).toMatchObject({ lastStatus: "error", lastOkAt: null, etag: null });
        expect.soft(await markJobsPossiblyClosed(db, { now, days: 7 })).toEqual([]);

        await activeAgain(db, absent);
        complete = true;
        const next = new Date("2026-10-08T12:00:00Z");
        const start = requests.length;
        const finished = await cycle(fetch, { db, at: next });
        expect.soft(await listRunsForCycle(db, finished.cycleId!)).toMatchObject([{ status: "succeeded", interrupted: false }]);
        expect.soft(requests[start]?.headers["If-None-Match"]).toBeUndefined();
        const remembered = await getAtsBoard(db, { ats: "smartrecruiters", token: srBoard.token });
        expect.soft(remembered).toMatchObject({ lastStatus: "ok", lastOkAt: next, etag: 'W/"p1"', detailRetryIds: [] });
        expect.soft(remembered?.externalIds).not.toContain("D");
        expect.soft(await markJobsPossiblyClosed(db, { now: next, days: 7 })).toEqual([absent]);
      } finally {
        resetDormancyCache();
        await connection.sql.end({ timeout: 2 });
      }
    } finally {
      await adminSql.unsafe(`drop database if exists "${name}" with (force)`);
      await adminSql.end({ timeout: 2 });
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }, 180_000);
});
