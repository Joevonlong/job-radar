/**
 * The test buttons. The web side leaves `test_channel` / `test_ai` / `test_telegram` requests (reused while open,
 * rate limited once finished), the runner claims the channel and Telegram tests, the ai-worker the AI test, and a
 * channel test writes nothing but its own request row.
 */
import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { aiWorkerRequestKinds, processNextControlRequest, registerControlHandler, resetControlHandlers, runnerRequestKinds } from "@/lib/control";
import { loadControlRequestView } from "@/lib/control/request-view";
import { requestTestAi, requestTestChannel, requestTestTelegram } from "@/lib/control/service";
import { createTestChannelHandler } from "@/lib/control/test-channel";
import { resetConfigCache } from "@/lib/config";
import { closeDb, createCycle, getControlRequest, getDb, insertControlRequest, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";

const url = inject("testDatabaseUrl");
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  temp = makeTempConfig();
  await getDb().execute(sql`truncate table control_requests, raw_postings, runs, cycles, channels restart identity cascade`);
});

afterEach(() => {
  temp.cleanup();
  resetControlHandlers();
});

afterAll(async () => {
  await closeDb();
});

function setMinInterval(seconds: number): void {
  const file = path.join(temp.configDir, "schedule.yaml");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/min_interval_seconds: \d+/, `min_interval_seconds: ${seconds}`));
  resetConfigCache();
}

describe("web side", () => {
  it("validates, reuses an open request and refuses a repeat inside the interval", async () => {
    expect(await requestTestChannel({ channelId: "not-a-channel" })).toMatchObject({ status: "error", error: "unknownChannel" });
    expect(await requestTestChannel({ channelId: "indeed", extra: 1 })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestTestAi({ provider: "gpt" })).toMatchObject({ status: "error", error: "invalidPayload" });

    const first = await requestTestChannel({ channelId: "indeed" });
    expect(first).toMatchObject({ status: "queued", kind: "test_channel", existing: false });
    expect(await requestTestChannel({ channelId: "indeed" })).toMatchObject({ status: "queued", existing: true });
    // another channel is its own request
    expect(await requestTestChannel({ channelId: "arbeitsagentur" })).toMatchObject({ status: "queued", existing: false });

    // finished a moment ago: refused for min_interval_seconds (30 in the shipped schedule.yaml)
    if (first.status !== "queued") throw new Error("not queued");
    await getDb().update(schema.controlRequests).set({ status: "done", finishedAt: sql`now()` }).where(sql`id = ${first.request}`);
    const refused = await requestTestChannel({ channelId: "indeed" });
    expect(refused).toMatchObject({ status: "error", error: "tooSoon" });
    expect(refused.status === "error" ? refused.retryAfterSeconds : 0).toBeGreaterThan(0);

    setMinInterval(0);
    expect(await requestTestChannel({ channelId: "indeed" })).toMatchObject({ status: "queued", existing: false });
  });

  it("queues the AI and Telegram tests", async () => {
    expect(await requestTestAi({ provider: "codex-cli" })).toMatchObject({ status: "queued", kind: "test_ai" });
    expect(await requestTestTelegram()).toMatchObject({ status: "queued", kind: "test_telegram" });
    expect(await requestTestTelegram()).toMatchObject({ status: "queued", existing: true });
  });
});

describe("who claims what", () => {
  it("the runner takes the channel and Telegram tests, the ai-worker the AI test (execution: host)", async () => {
    const db = getDb();
    await insertControlRequest(db, { kind: "test_ai", payload: { provider: "claude-cli" } });
    const channel = await insertControlRequest(db, { kind: "test_channel", payload: { channelId: "indeed" } });
    const telegram = await insertControlRequest(db, { kind: "test_telegram", payload: {} });
    const seen: string[] = [];
    for (const kind of ["test_channel", "test_telegram", "test_ai"] as const) {
      registerControlHandler(kind, async (request) => {
        seen.push(`${request.kind}#${request.id}`);
        return { status: "done", result: {} };
      });
    }
    const runner = { db, signal: new AbortController().signal, logger: quietLogger, kinds: () => runnerRequestKinds("host") };
    while ((await processNextControlRequest(runner)) !== null) {
      // drain what the runner may take
    }
    expect(seen).toEqual([`test_channel#${channel.id}`, `test_telegram#${telegram.id}`]);
    const worker = { ...runner, kinds: () => aiWorkerRequestKinds("host") };
    expect((await processNextControlRequest(worker))?.kind).toBe("test_ai");
  });
});

describe("test_channel handler", () => {
  it("fetches in memory: only the request row changes, and the view shows the result", async () => {
    const db = getDb();
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "arbeitsagentur" });
    registerControlHandler("test_channel", createTestChannelHandler({ registry, config: cycleConfig(), sleep: async () => {} }));
    const row = await insertControlRequest(db, { kind: "test_channel", payload: { channelId: "arbeitsagentur" } });
    const done = await processNextControlRequest({ db, signal: new AbortController().signal, logger: quietLogger, kinds: () => runnerRequestKinds("host") });
    expect(done).toMatchObject({ id: row.id, status: "done", result: { fetched: 5, parsed: 5 } });

    // no run, raw posting, cycle, or channel row (usage and circuit state live on the channel row)
    const counts = await db.execute<{ runs: number; raw: number; cycles: number; channels: number }>(sql`
      select (select count(*)::int from runs) as runs, (select count(*)::int from raw_postings) as raw,
             (select count(*)::int from cycles) as cycles, (select count(*)::int from channels) as channels
    `);
    expect(counts[0]).toEqual({ runs: 0, raw: 0, cycles: 0, channels: 0 });

    const view = await loadControlRequestView(db, row.id);
    expect(view).toMatchObject({ id: row.id, kind: "test_channel", status: "done", result: { fetched: 5, parsed: 5, parseFailed: 0 } });
    expect(view?.result.sampleTitles).toHaveLength(3);
  });

  it("does not test while a cycle is running", async () => {
    const db = getDb();
    const registry = new ChannelRegistry();
    const channel = registerFixtureChannel(registry, { id: "arbeitsagentur" });
    await createCycle(db, { kind: "weekday_morning" });
    registerControlHandler("test_channel", createTestChannelHandler({ registry, config: cycleConfig(), sleep: async () => {} }));
    const row = await insertControlRequest(db, { kind: "test_channel", payload: { channelId: "arbeitsagentur" } });
    await processNextControlRequest({ db, signal: new AbortController().signal, logger: quietLogger, kinds: () => runnerRequestKinds("host") });
    expect(await getControlRequest(db, row.id)).toMatchObject({ status: "failed", result: { error: "another_cycle_running" } });
    expect(channel.seen).toHaveLength(0);
  });

  it("the request view only serves the requests a button makes", async () => {
    const db = getDb();
    const other = await insertControlRequest(db, { kind: "translate_job", payload: { jobId: 1 } });
    expect(await loadControlRequestView(db, other.id)).toBeNull();
    expect(await loadControlRequestView(db, 999_999)).toBeNull();
  });
});
