import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createGreenhouseChannel, createDbAtsBoardStore } from "@/lib/channels/ats";
import type { FetchLike } from "@/lib/channels/http";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getAtsBoard, getDb, listRawPostingsForChannel, listRunsForCycle, schema, touchRawPostings, upsertRawPostings } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { company, depsWith, fixtureJson, inputs, neutralChannels, response } from "../channels/ats/helpers";
import { config, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");

const GH_URL = "/v1/boards/examplelabs/jobs";
const board = company({ name: "Example Labs", ats: "greenhouse", token: "examplelabs" });

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table ats_boards, raw_postings, runs, cycles, channels restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

/** Greenhouse that honours If-None-Match like the real one. */
function conditionalBoard(etag: string): { fetch: FetchLike; sent: Array<string | undefined> } {
  const sent: Array<string | undefined> = [];
  return {
    sent,
    fetch: async (requestUrl, init) => {
      expect(requestUrl).toContain(GH_URL);
      const header = init.headers?.["If-None-Match"];
      sent.push(header);
      return header === etag ? response(304, null, { ETag: etag }) : response(200, fixtureJson("greenhouse-board.json"), { ETag: etag });
    },
  };
}

function cycle(fetch: FetchLike) {
  const registry = new ChannelRegistry();
  registry.register(createGreenhouseChannel(depsWith(inputs([board]), createDbAtsBoardStore(getDb()))));
  return runCycle("manual", { registry, config: { ...config(), channels: neutralChannels() }, logger: quietLogger, sleep: async () => {}, channelIds: ["greenhouse"], fetch });
}

describe("migration 0002", () => {
  it("creates ats_boards keyed by (ats, token)", async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ats_boards' order by column_name`);
    expect(rows.map((r) => r.column_name)).toEqual([
      "ats", "consecutive_failures", "etag", "external_ids", "filter_fingerprint", "last_changed_at", "last_checked_at", "last_error_code", "last_kept", "last_ok_at", "last_status", "last_total", "token",
    ]);
  });
});

describe("ats_boards and raw posting touch", () => {
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

  it("touchRawPostings refreshes fetched_at of existing ids only and counts them", async () => {
    const db = getDb();
    await db.insert(schema.channels).values({ id: "greenhouse", family: "ats", kind: "ats" });
    const old = new Date("2026-01-01T00:00:00Z");
    await upsertRawPostings(db, { channelId: "greenhouse", runId: null, fetchedAt: old, items: [1, 2, 3].map((n) => ({ externalId: String(n), url: null, payload: { n } })) });
    const at = new Date("2026-10-07T00:00:00Z");
    expect(await touchRawPostings(db, { channelId: "greenhouse", externalIds: ["1", "3", "missing"], at })).toBe(2);
    const rows = await listRawPostingsForChannel(db, "greenhouse");
    expect(rows.map((r) => [r.externalId, r.fetchedAt.toISOString()])).toEqual([
      ["1", at.toISOString()],
      ["2", old.toISOString()],
      ["3", at.toISOString()],
    ]);
    expect(await touchRawPostings(db, { channelId: "greenhouse", externalIds: [] })).toBe(0);
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
