import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createGreenhouseChannel, createDbAtsBoardStore, createSmartrecruitersChannel } from "@/lib/channels/ats";
import type { FetchLike } from "@/lib/channels/http";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { CompanyEntry } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, createConnection, getAtsBoard, getChannelRows, getDb, listRawPostingsForChannel, listRunsForCycle, schema, touchRawPostings, upsertRawPostings } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { recordAtsBoardCheck } from "@/lib/db/repos/ats-boards";
import { markJobsPossiblyClosed, touchJobsSeen } from "@/lib/db/repos/jobs";

import { atsChannelsWith, company, depsWith, fixtureJson, inputs, neutralChannels, response, routedFetch } from "../channels/ats/helpers";
import { config, quietLogger } from "../cycle/helpers";
import { checkedName } from "../helpers/isolated-db";

const url = inject("testDatabaseUrl");

const GH_URL = "/v1/boards/examplelabs/jobs";
const GH_KEPT = ["6186419001", "6186419002", "6186419003", "6186419006"];
const board = company({ name: "Example Labs", ats: "greenhouse", token: "examplelabs" });

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

/** Greenhouse that honours If-None-Match like the real one. */
function conditionalBoard(etag: string, body: unknown = fixtureJson("greenhouse-board.json")): { fetch: FetchLike; sent: Array<string | undefined> } {
  const sent: Array<string | undefined> = [];
  return {
    sent,
    fetch: async (requestUrl, init) => {
      expect(requestUrl).toContain(GH_URL);
      const header = init.headers?.["If-None-Match"];
      sent.push(header);
      return header === etag ? response(304, null, { ETag: etag }) : response(200, body, { ETag: etag });
    },
  };
}

function cycle(fetch: FetchLike, options: { maxResults?: number; at?: Date; smartrecruitersBoards?: CompanyEntry[] } = {}) {
  const db = getDb();
  const store = createDbAtsBoardStore(db);
  const at = options.at;
  // Pin the raw-posting refresh clock while exercising the real database update.
  if (at) store.touch = (channelId, externalIds) => touchRawPostings(db, { channelId, externalIds, at });
  const channelId = options.smartrecruitersBoards ? "smartrecruiters" : "greenhouse";
  const channels = options.smartrecruitersBoards
    ? atsChannelsWith("smartrecruiters", (b) => {
      b.enabled = true;
      b.api_base_url = "https://api.smartrecruiters.com";
      b.country = "de";
      b.page_size = 100;
      b.fetch_details = true;
      b.max_consecutive_detail_failures = 3;
      b.max_results = options.maxResults ?? 10;
      b.title_prefilter = { enabled: false, include_terms: [], exclude_terms: [] };
    })
    : options.maxResults === undefined
    ? neutralChannels()
    : atsChannelsWith("greenhouse", (b) => { b.max_results = options.maxResults; });
  if (options.smartrecruitersBoards) {
    channels.http.max_retries = 0;
    channels.circuit_breaker = { failures: 2, cooldown_hours: 1 };
  }
  const registry = new ChannelRegistry();
  const createChannel = options.smartrecruitersBoards ? createSmartrecruitersChannel : createGreenhouseChannel;
  registry.register(createChannel(depsWith(inputs(options.smartrecruitersBoards ?? [board]), store)));
  return runCycle("manual", {
    registry, config: { ...config(), channels }, logger: quietLogger, sleep: async () => {}, channelIds: [channelId], fetch,
    ...(at ? { now: () => at } : {}),
  });
}

describe("ats board migrations", () => {
  it("creates ats_boards with the detail retry column", async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ats_boards' order by column_name`);
    expect(rows.map((r) => r.column_name)).toEqual([
      "ats", "consecutive_failures", "detail_retry_ids", "etag", "external_ids", "filter_fingerprint", "last_changed_at", "last_checked_at", "last_error_code", "last_kept", "last_ok_at", "last_status", "last_total", "token",
    ]);
  });

  it("preserves existing board validators and sightings when adding detail retries", async () => {
    const admin = new URL(url);
    const name = checkedName(`${admin.pathname.slice(1)}_m35`);
    const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-ats-mig-"));
    try {
      await adminSql.unsafe(`create database "${name}"`);
      const target = new URL(url);
      target.pathname = `/${name}`;
      // Migrate only as far as the schema before detail retries, following the interrupted-run upgrade test.
      fs.cpSync(path.resolve("drizzle"), folder, { recursive: true });
      const journalFile = path.join(folder, "meta", "_journal.json");
      const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      const added = journal.entries.find((entry) => entry.tag === "0035_ats_detail_retry");
      if (!added) throw new Error("detail retry migration not found");
      fs.writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < added.idx) }));
      await runMigrations({ url: target.toString(), migrationsFolder: folder });

      const connection = createConnection(target.toString(), { max: 1 });
      try {
        const db = connection.sql;
        expect(await db`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'ats_boards' and column_name = 'detail_retry_ids'`).toHaveLength(0);
        const lastOk = new Date("2026-10-01T12:00:00Z");
        await db`insert into ats_boards
          (ats, token, etag, last_ok_at, filter_fingerprint, external_ids, last_status, last_checked_at, last_changed_at,
           last_total, last_kept, last_error_code, consecutive_failures)
          values ('smartrecruiters', 'ExampleLabs', 'W/"existing"', ${lastOk.toISOString()}, '2:existing:10',
            array['stored-1', 'stored-2'], 'ok', ${lastOk.toISOString()}, ${lastOk.toISOString()}, 4, 2, null, 0)`;
        const before = await db`select ats, token, etag, last_ok_at, filter_fingerprint, external_ids, last_status,
          last_checked_at, last_changed_at, last_total, last_kept, last_error_code, consecutive_failures from ats_boards`;
        expect(before).toHaveLength(1);

        fs.writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= added.idx) }));
        await runMigrations({ url: target.toString(), migrationsFolder: folder });

        const after = await db`select ats, token, etag, last_ok_at, filter_fingerprint, external_ids, last_status,
          last_checked_at, last_changed_at, last_total, last_kept, last_error_code, consecutive_failures, detail_retry_ids from ats_boards`;
        expect(after).toEqual(before.map((row) => ({ ...row, detail_retry_ids: [] })));
        expect(await getAtsBoard(connection.db, { ats: "smartrecruiters", token: "ExampleLabs" })).toMatchObject({
          etag: 'W/"existing"', lastOkAt: lastOk, filterFingerprint: "2:existing:10", externalIds: ["stored-1", "stored-2"],
          detailRetryIds: [], lastStatus: "ok", lastCheckedAt: lastOk, lastChangedAt: lastOk,
          lastTotal: 4, lastKept: 2, lastErrorCode: null, consecutiveFailures: 0,
        });
      } finally {
        await connection.sql.end({ timeout: 2 });
      }
    } finally {
      await adminSql.unsafe(`drop database if exists "${name}" with (force)`);
      await adminSql.end({ timeout: 2 });
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("ats_boards and raw posting touch", () => {
  it("persists retry ids on ok, preserves them on unchanged or failed checks, and clears them on an ok without retry ids", async () => {
    const db = getDb();
    const key = { ats: "smartrecruiters", token: "ExampleLabs" };
    const store = createDbAtsBoardStore(db);
    const retryIds = ["bad1", "bad2"];
    await recordAtsBoardCheck(db, key, {
      status: "ok", etag: 'W/"details"', externalIds: ["stored"], detailRetryIds: retryIds,
      checkedAt: new Date("2026-10-07T12:00:00Z"),
    });
    expect(await getAtsBoard(db, key)).toMatchObject({ lastStatus: "ok", detailRetryIds: retryIds });
    expect(await store.load(key)).toMatchObject({ detailRetryIds: retryIds });

    await recordAtsBoardCheck(db, key, { status: "not_modified", checkedAt: new Date("2026-10-08T12:00:00Z") });
    expect(await getAtsBoard(db, key)).toMatchObject({ lastStatus: "not_modified", detailRetryIds: retryIds });
    await recordAtsBoardCheck(db, key, { status: "error", errorCode: "network", checkedAt: new Date("2026-10-09T12:00:00Z") });
    expect(await getAtsBoard(db, key)).toMatchObject({ lastStatus: "error", detailRetryIds: retryIds });

    await recordAtsBoardCheck(db, key, { status: "ok", checkedAt: new Date("2026-10-10T12:00:00Z") });
    expect(await getAtsBoard(db, key)).toMatchObject({ lastStatus: "ok", detailRetryIds: [] });
    expect(await store.load(key)).toMatchObject({ detailRetryIds: [] });
  });

  it("records ok / not_modified / error checks without losing the last validator", async () => {
    const db = getDb();
    const key = { ats: "greenhouse", token: "t" };
    expect(await getAtsBoard(db, key)).toBeNull();
    await db.insert(schema.channels).values({ id: "greenhouse", family: "ats", kind: "ats" });
    const store = createDbAtsBoardStore(db);
    await store.record(key, { status: "ok", etag: 'W/"1"', filterFingerprint: "f", externalIds: ["1", "2"], total: 5, kept: 2 });
    await store.record(key, { status: "not_modified" });
    expect(await getAtsBoard(db, key)).toMatchObject({ etag: 'W/"1"', externalIds: ["1", "2"], lastStatus: "not_modified", lastErrorCode: null, lastTotal: 5, lastKept: 2 });
    await store.record(key, { status: "error", errorCode: "network" });
    expect(await getAtsBoard(db, key)).toMatchObject({ etag: 'W/"1"', lastStatus: "error", lastErrorCode: "network" });
    await store.record(key, { status: "ok", etag: null, filterFingerprint: "g", externalIds: [], total: 0, kept: 0 });
    expect(await getAtsBoard(db, key)).toMatchObject({ etag: null, filterFingerprint: "g", externalIds: [], lastStatus: "ok", lastErrorCode: null });
  });

  it("touchRawPostings refreshes fetched_at of existing ids only and returns them", async () => {
    const db = getDb();
    await db.insert(schema.channels).values({ id: "greenhouse", family: "ats", kind: "ats" });
    const old = new Date("2026-01-01T00:00:00Z");
    await upsertRawPostings(db, { channelId: "greenhouse", runId: null, fetchedAt: old, items: [1, 2, 3].map((n) => ({ externalId: String(n), url: null, payload: { n } })) });
    const at = new Date("2026-10-07T00:00:00Z");
    const touched = await touchRawPostings(db, { channelId: "greenhouse", externalIds: ["1", "3", "missing"], at });
    expect(touched).toHaveLength(2);
    expect(touched).toEqual(expect.arrayContaining(["1", "3"]));
    const rows = await listRawPostingsForChannel(db, "greenhouse");
    expect(rows.map((r) => [r.externalId, r.fetchedAt.toISOString()])).toEqual([
      ["1", at.toISOString()],
      ["2", old.toISOString()],
      ["3", at.toISOString()],
    ]);
    expect(await touchRawPostings(db, { channelId: "greenhouse", externalIds: [] })).toEqual([]);
  });
});

describe("runCycle with the greenhouse channel", () => {
  it("stores kept postings verbatim; a second cycle gets a 304 that succeeds with fetched=0 and keeps the postings seen", async () => {
    const board1 = conditionalBoard('W/"v1"');
    const first = await cycle(board1.fetch);
    expect(first.status).toBe("succeeded");
    const [run1] = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(run1).toMatchObject({ channelId: "greenhouse", status: "succeeded", fetched: 4, newCount: 4 });
    const raw1 = await listRawPostingsForChannel(getDb(), "greenhouse");
    expect(raw1.map((r) => r.externalId)).toEqual(["6186419001", "6186419002", "6186419003", "6186419006"]);
    expect(raw1[0]?.payloadJson).toMatchObject({ source: { ats: "greenhouse", token: "examplelabs" }, posting: { title: "Senior AI Engineer (m/f/d)" } });
    expect(await getAtsBoard(getDb(), { ats: "greenhouse", token: "examplelabs" })).toMatchObject({
      etag: 'W/"v1"', lastStatus: "ok", lastTotal: 6, lastKept: 4,
    });
    // pretend the postings were last seen long ago
    const long = new Date("2026-09-01T00:00:00Z");
    await getDb().update(schema.rawPostings).set({ fetchedAt: long }).where(eq(schema.rawPostings.channelId, "greenhouse"));

    const second = await cycle(board1.fetch);
    expect(board1.sent).toEqual([undefined, 'W/"v1"']);
    expect(second.status).toBe("succeeded");
    const [run2] = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(run2).toMatchObject({ status: "succeeded", fetched: 0, newCount: 0, error: null });
    expect(await getAtsBoard(getDb(), { ats: "greenhouse", token: "examplelabs" })).toMatchObject({ etag: 'W/"v1"', lastStatus: "not_modified", lastKept: 4 });
    const raw2 = await listRawPostingsForChannel(getDb(), "greenhouse");
    expect(raw2).toHaveLength(4); // nothing disappeared
    expect(raw2.every((r) => r.fetchedAt.getTime() > long.getTime())).toBe(true); // still "seen"
  });

  it("refetches when the raw postings behind a stored ETag are gone", async () => {
    const board1 = conditionalBoard('W/"v1"');
    await cycle(board1.fetch);
    await getDb().delete(schema.rawPostings).where(eq(schema.rawPostings.externalId, "6186419002"));
    await cycle(board1.fetch);
    expect(board1.sent).toEqual([undefined, 'W/"v1"', undefined]);
    expect(await listRawPostingsForChannel(getDb(), "greenhouse")).toHaveLength(4);
  });

  it.each([
    { name: "the per-board cap does not make stored postings look closed", listed: true },
    { name: "[regression guard] a stored posting no longer listed by the board is marked possibly closed", listed: false },
  ])("$name", async ({ listed }) => {
    const db = getDb();
    const now = new Date("2026-10-07T12:00:00Z");
    const old = new Date("2026-09-07T12:00:00Z");
    const body = fixtureJson("greenhouse-board.json") as { jobs: Array<{ id: number }> };
    const board1 = conditionalBoard('W/"v1"', body);
    const first = await cycle(board1.fetch, { at: old });
    expect(first.status).toBe("succeeded");
    if (first.cycleId === null) throw new Error("missing first cycle");
    const raw = await listRawPostingsForChannel(db, "greenhouse");
    expect(raw.map((r) => r.externalId)).toEqual(GH_KEPT);
    const overCap = raw.find((r) => r.externalId === GH_KEPT[2]);
    if (!overCap) throw new Error("missing over-cap posting");

    const [employer] = await db.insert(schema.companies).values({ name: board.name, nameNorm: "example labs" }).returning({ id: schema.companies.id });
    if (!employer) throw new Error("missing company");
    const [job] = await db.insert(schema.jobs).values({
      companyId: employer.id, title: "KI-Entwickler", titleNorm: "ki entwickler", status: "active", firstSeenAt: old, lastSeenAt: old,
    }).returning({ id: schema.jobs.id });
    if (!job) throw new Error("missing job");
    await db.insert(schema.jobSources).values({ jobId: job.id, rawPostingId: overCap.id, channelId: "greenhouse" });
    await db.update(schema.rawPostings).set({ fetchedAt: old }).where(eq(schema.rawPostings.channelId, "greenhouse"));
    await db.update(schema.runs).set({ startedAt: old, finishedAt: old }).where(eq(schema.runs.cycleId, first.cycleId));
    if (!listed) body.jobs = body.jobs.filter((p) => String(p.id) !== overCap.externalId);

    const second = await cycle(board1.fetch, { maxResults: 2, at: now });
    expect(second.status).toBe("succeeded");
    if (second.cycleId === null) throw new Error("missing second cycle");
    expect(board1.sent).toEqual([undefined, undefined]); // the changed cap invalidates the validator
    // Run timestamps use database defaults; pin the successful run after the expiry point.
    await db.update(schema.runs).set({ startedAt: now, finishedAt: now }).where(eq(schema.runs.cycleId, second.cycleId));
    expect(await listRunsForCycle(db, second.cycleId)).toMatchObject([{ channelId: "greenhouse", status: "succeeded", fetched: 2, startedAt: now }]);

    const refreshed = await listRawPostingsForChannel(db, "greenhouse");
    expect(refreshed).toHaveLength(4);
    expect(refreshed.filter((r) => GH_KEPT.slice(2).includes(r.externalId)).map((r) => [r.externalId, r.fetchedAt])).toEqual([
      [GH_KEPT[2], listed ? now : old],
      [GH_KEPT[3], now],
    ]);
    expect(refreshed.find((r) => r.id === overCap.id)?.payloadJson).toEqual(overCap.payloadJson);
    const remembered = await getAtsBoard(db, { ats: "greenhouse", token: board.token });
    expect(remembered).toMatchObject({ lastStatus: "ok", lastKept: 2 });
    expect(remembered?.externalIds.slice(0, 2)).toEqual(GH_KEPT.slice(0, 2));
    const rememberedOverCap = remembered?.externalIds.slice(2);
    const expectedOverCap = GH_KEPT.slice(2).filter((id) => listed || id !== overCap.externalId);
    expect(rememberedOverCap).toHaveLength(expectedOverCap.length);
    expect(rememberedOverCap).toEqual(expect.arrayContaining(expectedOverCap));

    expect(await touchJobsSeen(db)).toEqual({ seen: listed ? 1 : 0, reopened: 0 });
    const closed = await markJobsPossiblyClosed(db, { now, days: 7 });
    expect(closed).toEqual(listed ? [] : [job.id]);
    const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(after).toMatchObject({ status: listed ? "active" : "possibly_closed", lastSeenAt: listed ? now : old });
  });

  it("a failing board fails the run and the circuit is told, without touching stored state", async () => {
    await cycle(conditionalBoard('W/"v1"').fetch);
    const failing: FetchLike = async () => response(404, { error: "gone" });
    const result = await cycle(failing);
    expect(result.status).toBe("failed");
    const [run] = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(run).toMatchObject({ status: "failed" });
    expect(await getAtsBoard(getDb(), { ats: "greenhouse", token: "examplelabs" })).toMatchObject({ etag: 'W/"v1"', lastStatus: "error", lastErrorCode: "not_found" });
    expect(await listRawPostingsForChannel(getDb(), "greenhouse")).toHaveLength(4);
  });
});

describe("runCycle with the smartrecruiters channel", () => {
  it.each([
    { name: "[regression guard] persists retry ids when the only board loses every detail and the run fails", mixed: false },
    { name: "[regression guard] persists retry ids and healthy postings when a mixed round succeeds", mixed: true },
  ])("$name", async ({ mixed }) => {
    const db = getDb();
    const boardA = company({ name: "First Labs", ats: "smartrecruiters", token: "FirstLabs" });
    const boardB = company({ name: "Second Labs", ats: "smartrecruiters", token: "SecondLabs" });
    const baseA = "https://api.smartrecruiters.com/v1/companies/FirstLabs/postings";
    const baseB = "https://api.smartrecruiters.com/v1/companies/SecondLabs/postings";
    const postingsA = ["a1", "a2"].map((id) => ({ id, name: "AI Engineer", company: { identifier: boardA.token } }));
    const postingB = { id: "b-present", name: "AI Engineer", company: { identifier: boardB.token } };
    const { fetch, requests } = routedFetch([
      [`${baseA}?`, response(200, { totalFound: 2, content: postingsA }, { ETag: 'W/"a"' })],
      [`${baseA}/`, response(500, "detail unavailable")],
      [`${baseB}?`, response(200, { totalFound: 1, content: [postingB] })],
      [`${baseB}/b-present`, response(200, postingB)],
    ]);

    const result = await cycle(fetch, {
      smartrecruitersBoards: mixed ? [boardA, boardB] : [boardA], at: new Date("2026-10-07T12:00:00Z"),
    });
    if (result.cycleId === null) throw new Error("missing cycle");
    const runs = await listRunsForCycle(db, result.cycleId);
    expect(result.status).toBe(mixed ? "succeeded" : "failed");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      channelId: "smartrecruiters", status: mixed ? "succeeded" : "failed", interrupted: false,
      errorCode: mixed ? null : "network", fetched: mixed ? 1 : 0, newCount: mixed ? 1 : 0,
    });
    if (!mixed) expect(runs[0]?.error).toContain("HTTP 500");
    const rememberedA = await getAtsBoard(db, { ats: "smartrecruiters", token: boardA.token });
    expect(rememberedA).toMatchObject({
      lastStatus: "ok", lastErrorCode: null, consecutiveFailures: 0,
      etag: null, externalIds: [], detailRetryIds: ["a1", "a2"], lastTotal: 2, lastKept: 2,
    });
    expect(rememberedA?.lastOkAt).toBeInstanceOf(Date);
    const stored = await listRawPostingsForChannel(db, "smartrecruiters");
    if (mixed) {
      expect(stored).toMatchObject([{
        externalId: "b-present", runId: runs[0]?.id,
        payloadJson: { source: { ats: "smartrecruiters", token: boardB.token, companyName: boardB.name }, posting: postingB },
      }]);
      expect(await getAtsBoard(db, { ats: "smartrecruiters", token: boardB.token })).toMatchObject({
        lastStatus: "ok", externalIds: ["b-present"], detailRetryIds: [],
      });
    } else {
      expect(stored).toEqual([]);
      expect(await getAtsBoard(db, { ats: "smartrecruiters", token: boardB.token })).toBeNull();
    }
    expect(requests.map((r) => r.url)).toEqual([
      `${baseA}?limit=100&offset=0&country=de`, `${baseA}/a1`, `${baseA}/a2`,
      ...(mixed ? [`${baseB}?limit=100&offset=0&country=de`, `${baseB}/b-present`] : []),
    ]);
  });

  it.each([
    { name: "keeps a stale job live through two 304 rounds with unresolved stored details on another board", stored: true },
    { name: "keeps a stale job live after two failed 200 reads and a 304 for never-stored details on another board", stored: false },
  ])("$name", async ({ stored }) => {
    const db = getDb();
    const old = new Date("2026-09-07T12:00:00Z");
    const boardA = company({ name: "First Labs", ats: "smartrecruiters", token: "FirstLabs" });
    const boardB = company({ name: "Second Labs", ats: "smartrecruiters", token: "SecondLabs" });
    const postingA = { id: "a1", name: "AI Engineer", company: { identifier: boardA.token } };
    const payloadA = { source: { ats: "smartrecruiters", token: boardA.token, companyName: boardA.name }, posting: postingA };
    const stalePayload = {
      source: { ats: "smartrecruiters", token: boardB.token, companyName: boardB.name },
      posting: { id: "b-stale", name: "AI Engineer", company: { identifier: boardB.token } },
    };
    await db.insert(schema.channels).values({ id: "smartrecruiters", family: "ats", kind: "ats" });
    await upsertRawPostings(db, {
      channelId: "smartrecruiters", runId: null, fetchedAt: old,
      items: [
        { externalId: "b-stale", url: null, payload: stalePayload },
        ...(stored ? [{ externalId: "a1", url: null, payload: payloadA }] : []),
      ],
    });
    const raw = (await listRawPostingsForChannel(db, "smartrecruiters")).find((p) => p.externalId === "b-stale");
    if (!raw) throw new Error("missing stale posting");
    const [employer] = await db.insert(schema.companies).values({ name: boardB.name, nameNorm: "second labs" }).returning({ id: schema.companies.id });
    if (!employer) throw new Error("missing company");
    const [job] = await db.insert(schema.jobs).values({
      companyId: employer.id, title: "AI Engineer", titleNorm: "ai engineer", status: "active", firstSeenAt: old, lastSeenAt: old,
    }).returning({ id: schema.jobs.id });
    if (!job) throw new Error("missing job");
    await db.insert(schema.jobSources).values({ jobId: job.id, rawPostingId: raw.id, channelId: "smartrecruiters" });
    await recordAtsBoardCheck(db, { ats: "smartrecruiters", token: boardB.token }, {
      status: "ok", etag: 'W/"old-b"', externalIds: ["b-stale"], total: 1, kept: 1, checkedAt: old,
    });
    if (stored) {
      await recordAtsBoardCheck(db, { ats: "smartrecruiters", token: boardA.token }, {
        status: "ok", etag: null, externalIds: ["a1"], total: 1, kept: 1, checkedAt: old,
      });
    }

    const baseA = "https://api.smartrecruiters.com/v1/companies/FirstLabs/postings";
    const baseB = "https://api.smartrecruiters.com/v1/companies/SecondLabs/postings";
    const etag = 'W/"a"';
    const { fetch, requests } = routedFetch([
      [`${baseA}?`, ({ headers }) => headers["If-None-Match"] === etag
        ? response(304)
        : response(200, { totalFound: 1, content: [postingA] }, { ETag: etag })],
      [`${baseA}/a1`, response(500, "detail unavailable")],
      [`${baseB}?`, response(503, "list unavailable")],
    ]);
    const rounds = [
      { at: new Date("2026-10-07T12:00:00Z"), unchanged: false, validator: undefined, savedEtag: stored ? etag : null },
      { at: new Date("2026-10-08T12:00:00Z"), unchanged: stored, validator: stored ? etag : undefined, savedEtag: etag },
      { at: new Date("2026-10-09T12:00:00Z"), unchanged: true, validator: etag, savedEtag: etag },
    ];
    for (const { at, unchanged, validator, savedEtag } of rounds) {
      const before = requests.length;
      // Each clock is after expiry and beyond the breaker's cooldown, so all three sweeps reach both boards.
      const result = await cycle(fetch, { smartrecruitersBoards: [boardA, boardB], at });
      if (result.cycleId === null) throw new Error("missing cycle");
      // Run timestamps have database defaults; pin each one so a false success would count as closure evidence.
      await db.update(schema.runs).set({ startedAt: at, finishedAt: at }).where(eq(schema.runs.cycleId, result.cycleId));
      const runs = await listRunsForCycle(db, result.cycleId);
      expect(result.status).toBe("failed");
      // a non-retryable failure (the 304 round) is followed by a skipped row: no channel is left for the query this cycle
      expect(runs.map((run) => run.status)).toEqual(unchanged ? ["failed", "skipped"] : ["failed"]);
      expect(runs[0]).toMatchObject({
        channelId: "smartrecruiters", status: "failed", interrupted: false, fetched: 0, newCount: 0,
        errorCode: unchanged ? "unknown" : "network", startedAt: at, finishedAt: at,
      });
      expect(runs[0]?.error).toContain(unchanged ? "1 posting details are still missing from an earlier sweep" : "HTTP 500");
      expect(requests.slice(before).map((r) => r.url)).toEqual([
        `${baseA}?limit=100&offset=0&country=de`, ...(!unchanged ? [`${baseA}/a1`] : []), `${baseB}?limit=100&offset=0&country=de`,
      ]);
      expect(requests[before]?.headers["If-None-Match"]).toBe(validator);
      expect(await getAtsBoard(db, { ats: "smartrecruiters", token: boardA.token })).toMatchObject({
        lastStatus: unchanged ? "not_modified" : "ok", lastErrorCode: null, consecutiveFailures: 0,
        etag: savedEtag, externalIds: stored ? ["a1"] : [], detailRetryIds: ["a1"], lastTotal: 1, lastKept: 1,
      });
      expect(await getAtsBoard(db, { ats: "smartrecruiters", token: boardB.token })).toMatchObject({
        lastStatus: "error", lastErrorCode: "network", externalIds: ["b-stale"], lastOkAt: old,
      });
      const rawPostings = await listRawPostingsForChannel(db, "smartrecruiters");
      expect(rawPostings).toHaveLength(stored ? 2 : 1);
      expect(rawPostings.find((p) => p.id === raw.id)).toMatchObject({ payloadJson: stalePayload, fetchedAt: old });
      if (stored) expect(rawPostings.find((p) => p.externalId === "a1")).toMatchObject({ payloadJson: payloadA, fetchedAt: at });
      else expect(rawPostings.find((p) => p.externalId === "a1")).toBeUndefined();
      expect(await touchJobsSeen(db)).toEqual({ seen: 0, reopened: 0 });
      const closed = await markJobsPossiblyClosed(db, { now: at, days: 7 });
      expect(closed).not.toContain(job.id);
      expect(closed).toEqual([]);
      const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
      expect(after).toMatchObject({ status: "active", lastSeenAt: old });
    }
  });

  it.each([
    { name: "does not close a stale job when one board loses every detail and the other list fails", healthy: false, goodDetail: false },
    { name: "stores an interrupted sweep's postings without closing a stale job on the other failing board", healthy: false, goodDetail: true },
    { name: "[regression guard] marks a stale job absent from its board when both boards are healthy", healthy: true, goodDetail: true },
  ])("$name", async ({ healthy, goodDetail }) => {
    const db = getDb();
    const now = new Date("2026-10-07T12:00:00Z");
    const old = new Date("2026-09-07T12:00:00Z");
    const boardA = company({ name: "First Labs", ats: "smartrecruiters", token: "FirstLabs" });
    const boardB = company({ name: "Second Labs", ats: "smartrecruiters", token: "SecondLabs" });
    const stalePayload = {
      source: { ats: "smartrecruiters", token: boardB.token, companyName: boardB.name },
      posting: { id: "b-stale", name: "AI Engineer", company: { identifier: boardB.token } },
    };
    await db.insert(schema.channels).values({ id: "smartrecruiters", family: "ats", kind: "ats" });
    await upsertRawPostings(db, {
      channelId: "smartrecruiters", runId: null, fetchedAt: old,
      items: [{ externalId: "b-stale", url: null, payload: stalePayload }],
    });
    const [raw] = await listRawPostingsForChannel(db, "smartrecruiters");
    if (!raw) throw new Error("missing stale posting");
    const [employer] = await db.insert(schema.companies).values({ name: boardB.name, nameNorm: "second labs" }).returning({ id: schema.companies.id });
    if (!employer) throw new Error("missing company");
    const [job] = await db.insert(schema.jobs).values({
      companyId: employer.id, title: "AI Engineer", titleNorm: "ai engineer", status: "active", firstSeenAt: old, lastSeenAt: old,
    }).returning({ id: schema.jobs.id });
    if (!job) throw new Error("missing job");
    await db.insert(schema.jobSources).values({ jobId: job.id, rawPostingId: raw.id, channelId: "smartrecruiters" });
    await recordAtsBoardCheck(db, { ats: "smartrecruiters", token: boardB.token }, {
      status: "ok", etag: 'W/"old-b"', externalIds: ["b-stale"], total: 1, kept: 1, checkedAt: old,
    });

    const baseA = "https://api.smartrecruiters.com/v1/companies/FirstLabs/postings";
    const baseB = "https://api.smartrecruiters.com/v1/companies/SecondLabs/postings";
    const postingsA = ["a1", "a2"].map((id) => ({ id, name: "AI Engineer", company: { identifier: boardA.token } }));
    const postingB = { id: "b-present", name: "AI Engineer", company: { identifier: boardB.token } };
    const { fetch, requests } = routedFetch([
      [`${baseA}?`, response(200, { totalFound: 2, content: postingsA }, { ETag: 'W/"a"' })],
      [`${baseA}/a1`, healthy ? response(200, postingsA[0]) : response(500, "detail unavailable")],
      [`${baseA}/a2`, goodDetail ? response(200, postingsA[1]) : response(500, "detail unavailable")],
      [`${baseB}?`, healthy ? response(200, { totalFound: 1, content: [postingB] }) : response(503, "list unavailable")],
      [`${baseB}/b-present`, response(200, postingB)],
    ]);

    const result = await cycle(fetch, { smartrecruitersBoards: [boardA, boardB], at: now });
    if (result.cycleId === null) throw new Error("missing cycle");
    // The database supplies run timestamps; pin them after expiry so a spurious success would close the job.
    await db.update(schema.runs).set({ startedAt: now, finishedAt: now }).where(eq(schema.runs.cycleId, result.cycleId));
    const runs = await listRunsForCycle(db, result.cycleId);
    expect(runs).toHaveLength(1);
    if (healthy) {
      expect(result.status).toBe("succeeded");
      expect(runs[0]).toMatchObject({ channelId: "smartrecruiters", status: "succeeded", interrupted: false, errorCode: null, fetched: 3 });
    } else {
      expect(result.status).toBe("failed");
      expect(runs[0]?.status).not.toBe("succeeded");
      expect(runs[0]).toMatchObject({
        channelId: "smartrecruiters", status: goodDetail ? "partial" : "failed", interrupted: goodDetail,
        errorCode: "network", fetched: goodDetail ? 1 : 0,
      });
      expect(runs[0]?.error).toContain("HTTP 500");
    }
    expect((await getChannelRows(db, ["smartrecruiters"]))[0]).toMatchObject({
      consecutiveFailures: healthy ? 0 : 1, lastErrorCode: healthy ? null : "network", health: healthy ? "healthy" : "degraded",
    });
    const rememberedA = await getAtsBoard(db, { ats: "smartrecruiters", token: boardA.token });
    expect(rememberedA).toMatchObject({
      lastStatus: "ok", lastErrorCode: null, consecutiveFailures: 0, detailRetryIds: healthy ? [] : goodDetail ? ["a1"] : ["a1", "a2"],
    });
    expect(rememberedA?.lastOkAt).toBeInstanceOf(Date);
    expect(await getAtsBoard(db, { ats: "smartrecruiters", token: boardB.token })).toMatchObject(
      healthy ? { lastStatus: "ok", externalIds: ["b-present"] } : { lastStatus: "error", lastErrorCode: "network", externalIds: ["b-stale"], lastOkAt: old },
    );
    expect(requests.map((r) => r.url)).toEqual([
      `${baseA}?limit=100&offset=0&country=de`, `${baseA}/a1`, `${baseA}/a2`, `${baseB}?limit=100&offset=0&country=de`,
      ...(healthy ? [`${baseB}/b-present`] : []),
    ]);
    const stored = await listRawPostingsForChannel(db, "smartrecruiters");
    expect(stored).toHaveLength(healthy ? 4 : goodDetail ? 2 : 1);
    expect(stored.find((p) => p.id === raw.id)).toMatchObject({ payloadJson: stalePayload, fetchedAt: old });
    if (goodDetail) expect(stored.find((p) => p.externalId === "a2")).toMatchObject({ runId: runs[0]?.id, payloadJson: { source: { token: boardA.token }, posting: postingsA[1] } });
    expect(await touchJobsSeen(db)).toEqual({ seen: 0, reopened: 0 });

    const closed = await markJobsPossiblyClosed(db, { now, days: 7 });
    expect(closed).toEqual(healthy ? [job.id] : []);
    const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(after).toMatchObject({ status: healthy ? "possibly_closed" : "active", lastSeenAt: old });
  });
});
