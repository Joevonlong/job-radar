import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { closeDb, getAtsBoard, getBoardSeenCounts, getChannelWindowStats, getDb, getRuntimeState, listBoardHealth, listSourceRegistryRows, recordAtsBoardCheck, schema, syncSourceRegistryRows, upsertRawPostings } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { BOARD_STATE_VERSION } from "@/lib/db/repos/ats-boards";
import { readRegistrySyncState, syncSourceRegistry } from "@/lib/sources/registry/sync";
import { hashConfigText } from "@/lib/config";

import { shippedChannels } from "../channels/helpers";

const url = inject("testDatabaseUrl");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

afterAll(async () => {
  await closeDb();
});

const row = (id: string, extra: Partial<Parameters<typeof syncSourceRegistryRows>[1][number]> = {}) => ({ id, type: "channel" as const, group: "ats", name: id, parentId: null, enabled: true, params: { a: 1 }, ...extra });

describe("migration 0019", () => {
  it("creates source_registry and the two ats_boards columns", async () => {
    const db = getDb();
    const cols = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ats_boards'`);
    expect(cols.map((c) => c.column_name)).toEqual(expect.arrayContaining(["consecutive_failures", "last_ok_at"]));
    expect((await db.execute(sql`select count(*)::int as n from source_registry`))[0]).toMatchObject({ n: 0 });
  });

  it("rejects a type outside channel / ats_board", async () => {
    await expect(getDb().execute(sql`insert into source_registry (id, type, source_group, name, enabled, config_hash) values ('x', 'bogus', 'g', 'x', true, 'h')`)).rejects.toThrow();
  });
});

describe("recordAtsBoardCheck keeps the failure streak and last_ok_at", () => {
  it("counts failures, resets on 200 and on 304, and remembers the last good time", async () => {
    const db = getDb();
    const key = { ats: "greenhouse", token: "streak" };
    const t = (n: number) => new Date(`2026-10-0${n}T00:00:00Z`);
    await recordAtsBoardCheck(db, key, { status: "error", errorCode: "network", checkedAt: t(1) });
    expect(await getAtsBoard(db, key)).toMatchObject({ consecutiveFailures: 1, lastOkAt: null });
    await recordAtsBoardCheck(db, key, { status: "ok", etag: null, filterFingerprint: `${BOARD_STATE_VERSION}:streak`, total: 3, kept: 1, checkedAt: t(2) });
    expect(await getAtsBoard(db, key)).toMatchObject({ consecutiveFailures: 0, lastOkAt: t(2) });
    await recordAtsBoardCheck(db, key, { status: "error", errorCode: "not_found", checkedAt: t(3) });
    await recordAtsBoardCheck(db, key, { status: "error", errorCode: "not_found", checkedAt: t(4) });
    await recordAtsBoardCheck(db, key, { status: "error", errorCode: "not_found", checkedAt: t(5) });
    expect(await getAtsBoard(db, key)).toMatchObject({ consecutiveFailures: 3, lastOkAt: t(2), lastErrorCode: "not_found" });
    await recordAtsBoardCheck(db, key, { status: "not_modified", checkedAt: t(6) });
    expect(await getAtsBoard(db, key)).toMatchObject({ consecutiveFailures: 0, lastOkAt: t(6), lastErrorCode: null });
    expect((await listBoardHealth(db)).find((b) => b.token === "streak")).toMatchObject({ lastStatus: "not_modified", consecutiveFailures: 0 });
  });
});

describe("migration 0023 backfills board health", () => {
  it("fills last_ok_at for healthy boards and the failure streak for failing ones", async () => {
    const db = getDb();
    const iso = (n: number) => `2026-10-0${n}T00:00:00Z`;
    const t = (n: number) => new Date(iso(n));
    await db.execute(sql`insert into channels (id, family, kind) values ('backfillats', 'ats', 'api') on conflict do nothing`);
    for (const n of [1, 2, 3]) await db.execute(sql`insert into runs (channel_id, started_at, finished_at, status) values ('backfillats', ${iso(n)}::timestamptz, ${iso(n)}::timestamptz, 'succeeded')`);
    const seed = (token: string, status: string, extra: { changed?: Date | null } = {}) =>
      db.execute(sql`insert into ats_boards (ats, token, last_status, last_checked_at, last_changed_at) values ('backfillats', ${token}, ${status}, ${iso(5)}::timestamptz, ${extra.changed ? extra.changed.toISOString() : null}::timestamptz)`);
    await seed("fine", "ok");
    await seed("same", "not_modified");
    await seed("always404", "error");
    await seed("wasfine", "error", { changed: t(2) });
    await db.execute(sql`insert into raw_postings (channel_id, external_id, payload_json) values ('backfillats', 'x1', ${JSON.stringify({ source: { ats: "backfillats", token: "wasfine" } })}::jsonb)`);
    const file = readFileSync(join(process.cwd(), "drizzle", "0023_backfill_board_health.sql"), "utf8");
    for (const statement of file.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    const rows = await db.execute<{ token: string; consecutive_failures: number; ok_at_check: boolean | null; no_ok: boolean }>(sql`select token, consecutive_failures, (last_ok_at = last_checked_at) as ok_at_check, last_ok_at is null as no_ok from ats_boards where ats = 'backfillats'`);
    const by = new Map(rows.map((r) => [r.token, r]));
    expect(by.get("fine")).toMatchObject({ consecutive_failures: 0, ok_at_check: true });
    expect(by.get("same")).toMatchObject({ consecutive_failures: 0, ok_at_check: true });
    expect(by.get("always404")).toMatchObject({ consecutive_failures: 3, no_ok: true });
    expect(by.get("wasfine")).toMatchObject({ consecutive_failures: 1, no_ok: true });
  });
});

describe("syncSourceRegistryRows", () => {
  it("inserts, marks removed entries, restores them when they come back, and is idempotent", async () => {
    const db = getDb();
    await db.execute(sql`truncate table source_registry`);
    await syncSourceRegistryRows(db, [row("a"), row("b"), row("c", { enabled: false })], { configHash: "h1" });
    expect((await listSourceRegistryRows(db)).map((r) => [r.id, r.enabled, r.inConfig])).toEqual([["a", true, true], ["b", true, true], ["c", false, true]]);

    const second = await syncSourceRegistryRows(db, [row("a"), row("c")], { configHash: "h2" });
    expect(second).toEqual({ upserted: 2, removed: 1 });
    const afterRemoval = await listSourceRegistryRows(db, { includeRemoved: true });
    const b = afterRemoval.find((r) => r.id === "b");
    expect(b).toMatchObject({ inConfig: false, configHash: "h2" });
    expect(b?.removedAt).toBeInstanceOf(Date);
    expect((await listSourceRegistryRows(db)).map((r) => r.id)).toEqual(["a", "c"]);
    const removedAt = b?.removedAt;
    // a second sync without b does not move removed_at
    await syncSourceRegistryRows(db, [row("a"), row("c")], { configHash: "h2" });
    expect((await listSourceRegistryRows(db, { includeRemoved: true })).find((r) => r.id === "b")?.removedAt).toEqual(removedAt);

    await syncSourceRegistryRows(db, [row("a"), row("b", { name: "B2" }), row("c")], { configHash: "h3" });
    const back = (await listSourceRegistryRows(db)).find((r) => r.id === "b");
    expect(back).toMatchObject({ inConfig: true, removedAt: null, name: "B2" });

    const before = await listSourceRegistryRows(db, { includeRemoved: true });
    await syncSourceRegistryRows(db, [row("a"), row("b", { name: "B2" }), row("c")], { configHash: "h3" });
    const again = await listSourceRegistryRows(db, { includeRemoved: true });
    const stable = (rows: typeof before) => rows.map((r) => ({ ...r, syncedAt: null }));
    expect(stable(again)).toEqual(stable(before));
  });

  it("syncSourceRegistry mirrors the shipped sources.yaml and records hash, time and count", async () => {
    const db = getDb();
    await db.execute(sql`truncate table source_registry, runtime_state`);
    const config = shippedChannels();
    const text = "# the file text";
    const result = await syncSourceRegistry(db, { config, text, at: new Date("2026-10-08T12:00:00Z") });
    expect(result).toEqual({ upserted: 21 + config.ats_boards.length, removed: 0 });
    const rows = await listSourceRegistryRows(db);
    expect(rows.filter((r) => r.type === "channel")).toHaveLength(21);
    expect(rows.find((r) => r.id === "board:greenhouse:zellwerk")).toMatchObject({ type: "ats_board", parentId: "greenhouse", enabled: true, params: { ats: "greenhouse", token: "zellwerk" } });
    expect(await readRegistrySyncState(db)).toEqual({ hash: hashConfigText(text), at: "2026-10-08T12:00:00.000Z", count: result.upserted });
    expect((await getRuntimeState(db, "sources.registry_synced"))?.key).toBe("sources.registry_synced");

    // a board leaves the file
    const smaller = { ...config, ats_boards: config.ats_boards.slice(1) };
    expect(await syncSourceRegistry(db, { config: smaller, text: "# smaller" })).toMatchObject({ removed: 1 });
  });
});

describe("health queries", () => {
  it("getChannelWindowStats counts the window and takes the latest run from any time", async () => {
    const db = getDb();
    await db.execute(sql`truncate table runs, raw_postings, channels restart identity cascade`);
    await db.insert(schema.channels).values([{ id: "xing", family: "xing", kind: "browser" }, { id: "indeed", family: "indeed", kind: "guest" }, { id: "lever", family: "ats", kind: "ats" }]);
    const at = (iso: string) => new Date(iso);
    await db.insert(schema.runs).values([
      { channelId: "xing", status: "failed", startedAt: at("2026-10-01T07:00:00Z"), fetched: 0, newCount: 0, errorCode: "blocked" },
      { channelId: "xing", status: "failed", startedAt: at("2026-10-08T07:00:00Z"), fetched: 0, newCount: 0, errorCode: "blocked" },
      { channelId: "indeed", status: "succeeded", startedAt: at("2026-10-07T07:00:00Z"), fetched: 20, newCount: 5 },
      { channelId: "indeed", status: "succeeded", startedAt: at("2026-10-08T07:00:00Z"), fetched: 22, newCount: 3 },
      { channelId: "indeed", status: "succeeded", startedAt: at("2026-09-01T07:00:00Z"), fetched: 99, newCount: 99 },
      { channelId: "lever", status: "succeeded", startedAt: at("2026-09-02T07:00:00Z"), fetched: 5, newCount: 1 },
    ]);
    const stats = await getChannelWindowStats(db, { since: at("2026-10-02T00:00:00Z") });
    expect(stats.get("indeed")).toMatchObject({ runs: 2, failed: 0, fetched: 42, newCount: 8, lastRun: { status: "succeeded", startedAt: at("2026-10-08T07:00:00Z") } });
    expect(stats.get("xing")).toMatchObject({ runs: 1, failed: 1, lastRun: { errorCode: "blocked", startedAt: at("2026-10-08T07:00:00Z") } });
    expect(stats.get("lever")).toMatchObject({ runs: 0, fetched: 0, lastRun: { status: "succeeded" } });
    expect(stats.has("greenhouse")).toBe(false);
  });

  it("getChannelWindowStats counts a run whose query was cut short after some pages as failed, unlike invalid records", async () => {
    const db = getDb();
    await db.execute(sql`truncate table runs, raw_postings, channels restart identity cascade`);
    await db.insert(schema.channels).values([{ id: "stepstone", family: "stepstone", kind: "guest" }]);
    const at = (iso: string) => new Date(iso);
    await db.insert(schema.runs).values([
      { channelId: "stepstone", status: "partial", startedAt: at("2026-10-07T07:00:00Z"), fetched: 12, newCount: 2, errorCode: "parse" },
      { channelId: "stepstone", status: "partial", startedAt: at("2026-10-08T07:00:00Z"), fetched: 25, newCount: 4, errorCode: "network", interrupted: true },
    ]);
    const stats = await getChannelWindowStats(db, { since: at("2026-10-02T00:00:00Z") });
    expect(stats.get("stepstone")).toMatchObject({ runs: 2, failed: 1, fetched: 37, lastRun: { status: "partial", errorCode: "network", interrupted: true } });
  });

  it("getBoardSeenCounts counts postings per board inside the window, from the stored envelope", async () => {
    const db = getDb();
    await db.execute(sql`truncate table runs, raw_postings, channels restart identity cascade`);
    await db.insert(schema.channels).values([{ id: "greenhouse", family: "ats", kind: "ats" }, { id: "indeed", family: "indeed", kind: "guest" }]);
    const env = (token: string) => ({ source: { ats: "greenhouse", token }, posting: { id: token } });
    await upsertRawPostings(db, { channelId: "greenhouse", runId: null, fetchedAt: new Date("2026-10-07T00:00:00Z"), items: [{ externalId: "1", url: null, payload: env("zellwerk") }, { externalId: "2", url: null, payload: env("zellwerk") }, { externalId: "3", url: null, payload: env("werbenetz") }] });
    await upsertRawPostings(db, { channelId: "greenhouse", runId: null, fetchedAt: new Date("2026-08-01T00:00:00Z"), items: [{ externalId: "4", url: null, payload: env("werbenetz") }] });
    await upsertRawPostings(db, { channelId: "indeed", runId: null, fetchedAt: new Date("2026-10-07T00:00:00Z"), items: [{ externalId: "5", url: null, payload: { title: "x" } }] });
    const counts = await getBoardSeenCounts(db, { since: new Date("2026-10-01T00:00:00Z"), atsIds: ["greenhouse", "lever"] });
    expect([...counts.entries()].sort()).toEqual([["greenhouse:werbenetz", 1], ["greenhouse:zellwerk", 2]]);
    expect((await getBoardSeenCounts(db, { since: new Date(0), atsIds: [] })).size).toBe(0);
  });
});
