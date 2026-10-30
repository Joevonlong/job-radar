import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import type { CascadeSpec } from "@/lib/channels/cascade";
import { BudgetExceededError, ChannelError, PartialCollectError } from "@/lib/channels/errors";
import type { FetchLike } from "@/lib/channels/http";
import { createJsearchChannel } from "@/lib/channels/jsearch";
import { ChannelRegistry } from "@/lib/channels/registry";
import { createStepstoneChannel } from "@/lib/channels/stepstone";
import type { Channel, RawPostingInput } from "@/lib/channels/types";
import { runCycle, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import {
  closeDb,
  getChannelRows,
  getDb,
  getLatestCycleRuns,
  getLatestCycleSummary,
  getShellCycleStatus,
  listChannelCycleHistory,
  listRawPostingsForChannel,
  listRecentRunsByChannel,
  listRunsForCycle,
} from "@/lib/db";
import { markJobsPossiblyClosed } from "@/lib/db/repos/jobs";
import { runMigrations } from "@/lib/db/migrate";
import { cycleOutcome } from "@/lib/sources/view";

import { channelsWith, shippedSearch } from "../channels/helpers";
import { response as jsearchResponse, SEARCH_PAGE } from "../channels/jsearch/helpers";
import { fixtureHtml, htmlResponse } from "../channels/web/helpers";
import { collectOf, config, pinnedSearch, probeChannel, quietLogger, settings } from "../cycle/helpers";

/**
 * A paginated query that fails after some pages (`PartialCollectError`): the postings already fetched are stored, the run is
 * `partial` with the `interrupted` marker and the failure's code, and the failure counts exactly like a failed attempt (circuit,
 * cascade, collect step status, closure check). Told apart throughout from a `partial` whose only problem is invalid records.
 */

const url = inject("testDatabaseUrl");
const T0 = new Date("2026-10-07T07:00:00Z");
const at = (hours: number) => () => new Date(T0.getTime() + hours * 3_600_000);

/** Circuit settings pinned here, so the arithmetic does not follow the shipped file. */
const FAILURES_TO_OPEN = 2;
const COOLDOWN_HOURS = 10;
const channels = () =>
  channelsWith((raw) => {
    raw.circuit_breaker = { failures: FAILURES_TO_OPEN, cooldown_hours: COOLDOWN_HOURS };
  });

const record = (id: string): RawPostingInput => ({ externalId: id, url: `https://jobs.example.test/${id}`, payload: { id } });
const network = () => new ChannelError("network", "HTTP 503 from example.test: server error", { status: 503 });
const pageParse = () => new ChannelError("parse", "example.test: page 2 does not match the expected shape");
const blocked = () => new ChannelError("blocked", "HTTP 403 from example.test: request blocked", { status: 403, tripsCircuit: true });

/** A channel whose every query fails after returning `kept` (one sweep query unless `usesQueries`). */
function interruptedChannel(id: string, cause: () => ChannelError, kept: string[] = ["p1", "p2"], usesQueries = false): Channel {
  return {
    ...probeChannel(id, { usesQueries }),
    async collect() {
      throw new PartialCollectError(kept.map(record), cause());
    },
  };
}

function run(registry: ChannelRegistry, options: RunCycleOptions = {}) {
  return runCycle("manual", {
    registry,
    config: { ...config(), channels: channels(), search: pinnedSearch() },
    logger: quietLogger,
    sleep: async () => {},
    now: at(0),
    ...options,
  });
}

const collectStatus = (result: Awaited<ReturnType<typeof run>>) => result.summary.steps.find((s) => s.name === "collect")?.status;
const channelRow = async (id: string) => (await getChannelRows(getDb(), [id]))[0];

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);
});

afterEach(() => {
  resetCycleSteps();
});

afterAll(async () => {
  await closeDb();
});

describe("an interrupted query", () => {
  it("control: a channel that answers completely is a succeeded run without the marker", async () => {
    const registry = new ChannelRegistry();
    registry.register(probeChannel("whole", { usesQueries: false, records: () => [record("p1"), record("p2")] }), { settings: settings() });
    const result = await run(registry);

    expect(collectStatus(result)).toBe("ok");
    expect(collectOf(result).channels.whole).toMatchObject({ runs: 1, succeeded: 1, failed: 0, interrupted: 0, fetched: 2, inserted: 2 });
    const [only] = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(only).toMatchObject({ status: "succeeded", interrupted: false, errorCode: null, error: null });
    expect(await channelRow("whole")).toMatchObject({ consecutiveFailures: 0, health: "healthy" });
  });

  it("stores the fetched postings, records a partial run with the marker and the failure's code, and counts the failure", async () => {
    const registry = new ChannelRegistry();
    registry.register(interruptedChannel("cut", network), { settings: settings() });
    const result = await run(registry);

    const [only] = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(only).toMatchObject({ status: "partial", interrupted: true, errorCode: "network", fetched: 2, newCount: 2 });
    expect(only?.error).toMatch(/^interrupted after 2 postings: HTTP 503/);
    const stored = await listRawPostingsForChannel(getDb(), "cut");
    expect(stored.map((r) => [r.externalId, r.runId])).toEqual([
      ["p1", only?.id],
      ["p2", only?.id],
    ]);
    // the summary: no success, one interruption, the failure's code
    expect(collectOf(result).channels.cut).toMatchObject({ runs: 1, succeeded: 0, failed: 0, skipped: 0, interrupted: 1, fetched: 2, inserted: 2, errorCodes: { network: 1 } });
    // all attempts interrupted: the step fails like "all failed", although the postings are stored
    expect(collectOf(result).status).toBe("failed");
    expect(collectStatus(result)).toBe("failed");
    expect(await channelRow("cut")).toMatchObject({ consecutiveFailures: 1, lastErrorCode: "network", health: "degraded" });
  });

  it("is told apart from a run that answered completely but with some invalid records (both have error code parse)", async () => {
    const registry = new ChannelRegistry();
    registry.register(interruptedChannel("cut", pageParse), { settings: settings() });
    registry.register(probeChannel("invalid", { usesQueries: false, records: () => [record("ok"), { externalId: "" } as unknown as RawPostingInput] }), {
      settings: settings(),
    });
    const result = await run(registry);
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);

    const cut = runs.find((r) => r.channelId === "cut");
    const invalid = runs.find((r) => r.channelId === "invalid");
    expect(cut).toMatchObject({ status: "partial", errorCode: "parse", interrupted: true });
    expect(invalid).toMatchObject({ status: "partial", errorCode: "parse", interrupted: false });
    expect(invalid?.error).toContain("records rejected");
    // the interrupted one is a failure of the channel, the other a success
    expect(await channelRow("cut")).toMatchObject({ consecutiveFailures: 1, lastErrorCode: "parse" });
    expect(await channelRow("invalid")).toMatchObject({ consecutiveFailures: 0, health: "healthy" });
    expect(collectOf(result).channels.cut).toMatchObject({ succeeded: 0, interrupted: 1 });
    expect(collectOf(result).channels.invalid).toMatchObject({ succeeded: 1, interrupted: 0, errorCodes: { parse: 1 } });
    // one success, one interruption: the step warns
    expect(collectOf(result).status).toBe("partial");
    expect(collectStatus(result)).toBe("partial");
  });

  it("mixed with a successful channel, the collect step is partial", async () => {
    const registry = new ChannelRegistry();
    registry.register(interruptedChannel("cut", blocked), { settings: settings() });
    registry.register(probeChannel("whole", { usesQueries: false }), { settings: settings() });
    const result = await run(registry);
    expect(collectOf(result).channels.cut).toMatchObject({ interrupted: 1, errorCodes: { blocked: 1 } });
    expect(collectOf(result).channels.whole).toMatchObject({ succeeded: 1 });
    expect(collectStatus(result)).toBe("partial");
  });

  it("a budget stop keeps the postings and leaves the circuit alone, as a budget skip does", async () => {
    const registry = new ChannelRegistry();
    registry.register(interruptedChannel("cut", () => new BudgetExceededError("channel", "cut: monthly budget exhausted")), { settings: settings() });
    const result = await run(registry);
    // the attempt, then (the channel is given up on for the cycle, as after a plain budget error) the skipped run of the unit
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ status: "partial", interrupted: true, errorCode: "budget_exceeded", fetched: 2 });
    expect(runs.slice(1).map((r) => [r.status, r.interrupted])).toEqual([["skipped", false]]);
    expect(await listRawPostingsForChannel(getDb(), "cut")).toHaveLength(2);
    expect(collectOf(result).channels.cut).toMatchObject({ interrupted: 1, errorCodes: { budget_exceeded: 1 } });
    expect(collectOf(result).unusable).toEqual({ cut: "budget_exceeded" });
    expect(await channelRow("cut")).toMatchObject({ consecutiveFailures: 0 });
  });

  it("re-fetching a stored posting moves its run_id to the interrupted run; the run row still carries the marker", async () => {
    const registry = new ChannelRegistry();
    let interrupt = false;
    registry.register(
      {
        ...probeChannel("board", { usesQueries: false }),
        async collect() {
          if (interrupt) throw new PartialCollectError([record("p1")], network());
          return [record("p1"), record("p2")];
        },
      },
      { settings: settings() },
    );
    const first = await run(registry);
    interrupt = true;
    const second = await run(registry, { now: at(1) });

    const [firstRun] = await listRunsForCycle(getDb(), first.cycleId as number);
    const [secondRun] = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(firstRun).toMatchObject({ status: "succeeded", interrupted: false });
    expect(secondRun).toMatchObject({ status: "partial", interrupted: true, fetched: 1, newCount: 0 });
    const stored = await listRawPostingsForChannel(getDb(), "board");
    expect(stored.map((r) => [r.externalId, r.runId])).toEqual([
      ["p1", secondRun?.id],
      ["p2", firstRun?.id],
    ]);
    expect(collectOf(second).channels.board).toMatchObject({ interrupted: 1, fetched: 1, inserted: 0, unchanged: 1 });
  });
});

describe("circuit breaker", () => {
  it("interrupted queries open the circuit like failed ones, and settle a half-open probe as a failure", async () => {
    const registry = new ChannelRegistry();
    let cause: () => ChannelError = network;
    let calls = 0;
    registry.register(
      {
        ...probeChannel("cut"),
        async collect() {
          calls += 1;
          throw new PartialCollectError([record(`p${calls}`)], cause());
        },
      },
      { settings: settings() },
    );

    const first = await run(registry);
    expect(calls).toBe(FAILURES_TO_OPEN);
    const runs = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(runs.map((r) => [r.status, r.interrupted])).toEqual([...Array(FAILURES_TO_OPEN).fill(["partial", true]), ["skipped", false]]);
    expect(await channelRow("cut")).toMatchObject({ circuitState: "open", consecutiveFailures: FAILURES_TO_OPEN });

    // after the cooldown one probe goes out; it is interrupted, so the circuit opens again
    cause = pageParse;
    const probe = await run(registry, { now: at(COOLDOWN_HOURS + 1) });
    expect(calls).toBe(FAILURES_TO_OPEN + 1);
    expect((await listRunsForCycle(getDb(), probe.cycleId as number)).map((r) => [r.status, r.interrupted])).toEqual([
      ["partial", true],
      ["skipped", false],
    ]);
    expect(await channelRow("cut")).toMatchObject({ circuitState: "open", consecutiveFailures: FAILURES_TO_OPEN + 1, lastErrorCode: "parse" });
  });

  it("control: a half-open probe that only had invalid records closes the circuit", async () => {
    const registry = new ChannelRegistry();
    let broken = true;
    registry.register(
      {
        ...probeChannel("flaky"),
        async collect() {
          if (broken) throw network();
          return [record("ok"), { externalId: "" } as unknown as RawPostingInput];
        },
      },
      { settings: settings() },
    );
    await run(registry);
    expect(await channelRow("flaky")).toMatchObject({ circuitState: "open" });
    broken = false;
    await run(registry, { now: at(COOLDOWN_HOURS + 1) });
    expect(await channelRow("flaky")).toMatchObject({ circuitState: "closed", consecutiveFailures: 0 });
  });
});

describe("cascade", () => {
  const cascade = (...order: string[]): CascadeSpec[] => [{ family: "linkedin", order }];
  const member = (id: string, collect: Channel["collect"]): Channel => ({ ...probeChannel(id), family: "linkedin", collect });

  it("a non-retryable interruption keeps the postings and hands the same query to the next channel", async () => {
    const registry = new ChannelRegistry();
    registry.register(member("fx-1", async () => Promise.reject(new PartialCollectError([record("l-1")], blocked()))), { settings: settings() });
    registry.register(member("fx-2", async () => [record("l-2")]), { settings: settings() });
    const result = await run(registry, { cascades: cascade("fx-1", "fx-2") });

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ channelId: "fx-1", status: "partial", interrupted: true, errorCode: "blocked" });
    expect(runs.slice(1).every((r) => r.channelId === "fx-2" && r.status === "succeeded")).toBe(true);
    expect(runs[1]?.queryHash).toBe(runs[0]?.queryHash);
    expect(collectOf(result).unusable).toEqual({ "fx-1": "blocked" });
    expect((await listRawPostingsForChannel(getDb(), "fx-1")).map((r) => r.externalId)).toEqual(["l-1"]);
    expect(await channelRow("fx-1")).toMatchObject({ circuitState: "open", lastErrorCode: "blocked" });
  });

  it("a retryable interruption is not handed on: the query counts as failed", async () => {
    const registry = new ChannelRegistry();
    let calls = 0;
    registry.register(
      member("fx-1", async () => {
        calls += 1;
        if (calls === 1) throw new PartialCollectError([record("l-1")], network());
        return [record(`l-${calls}`)];
      }),
      { settings: settings() },
    );
    const second = probeChannel("fx-2");
    registry.register({ ...second, family: "linkedin" }, { settings: settings() });
    const result = await run(registry, { cascades: cascade("fx-1", "fx-2") });
    const served = collectOf(result).served;
    expect(served[0]).toMatchObject({ channelId: "fx-1", status: "failed" });
    expect(served.slice(1).every((s) => s.channelId === "fx-1" && s.status === "served")).toBe(true);
    expect(second.calls).toHaveLength(0);
  });
});

/** An active job of `channelId`, last seen 30 days ago. */
async function staleJob(channelId: string): Promise<number> {
  const db = getDb();
  await db.execute(sql`insert into channels (id, family, kind) values (${channelId}, 'ats', 'api') on conflict do nothing`);
  const [company] = await db.execute<{ id: string }>(sql`insert into companies (name, name_norm) values (${channelId}, ${channelId}) returning id`);
  const [raw] = await db.execute<{ id: string }>(sql`
    insert into raw_postings (channel_id, external_id, payload_json) values (${channelId}, 'stale', '{}'::jsonb) returning id`);
  const [job] = await db.execute<{ id: string }>(sql`
    insert into jobs (company_id, title, title_norm, last_seen_at, status)
    values (${Number(company!.id)}, 'Stale', 'stale', now() - interval '30 days', 'active') returning id`);
  await db.execute(sql`insert into job_sources (job_id, raw_posting_id, channel_id) values (${Number(job!.id)}, ${Number(raw!.id)}, ${channelId})`);
  return Number(job!.id);
}

describe("closure check", () => {
  it("an interrupted run never lets the channel's jobs close; a complete run does", async () => {
    const cutJob = await staleJob("cut");
    const wholeJob = await staleJob("whole");
    const registry = new ChannelRegistry();
    registry.register(interruptedChannel("cut", network), { settings: settings() });
    registry.register(probeChannel("whole", { usesQueries: false }), { settings: settings() });
    await run(registry, { now: () => new Date() });

    const closed = await markJobsPossiblyClosed(getDb(), { now: new Date(), days: 7 });
    expect(closed).toEqual([wholeJob]);
    expect(closed).not.toContain(cutJob);
  });
});

describe("dry run, abort and storage failures", () => {
  it("a dry run reports the kept postings and the interruption, and writes nothing", async () => {
    const registry = new ChannelRegistry();
    registry.register(interruptedChannel("cut", network), { settings: settings() });
    const result = await run(registry, { dryRun: true });
    const collect = collectOf(result);
    expect(collect.channels.cut).toMatchObject({ succeeded: 0, interrupted: 1, fetched: 2, inserted: 0, errorCodes: { network: 1 } });
    expect(collect.dryRun?.cut).toMatchObject({ fetched: 2 });
    expect(collect.status).toBe("failed");
    for (const table of ["cycles", "runs", "raw_postings", "channels"]) {
      const [row] = await getDb().execute<{ n: string }>(sql.raw(`select count(*)::text as n from ${table}`));
      expect(row?.n).toBe("0");
    }
  });

  it("a cancelled cycle discards the postings of an interrupted query, as before", async () => {
    const controller = new AbortController();
    const registry = new ChannelRegistry();
    registry.register(
      {
        ...probeChannel("cut", { usesQueries: false }),
        async collect() {
          controller.abort();
          throw new PartialCollectError([record("p1")], network());
        },
      },
      { settings: settings() },
    );
    const result = await run(registry, { signal: controller.signal });
    const runs = await getDb().execute<{ status: string; error: string | null; interrupted: boolean }>(sql`select status, error, interrupted from runs`);
    expect(runs).toEqual([{ status: "failed", error: "cancelled", interrupted: false }]);
    expect(await listRawPostingsForChannel(getDb(), "cut")).toHaveLength(0);
    expect(result.summary.aborted).toBe(true);
    expect(await channelRow("cut")).toMatchObject({ consecutiveFailures: 0 });
  });

  it("a failure to store the kept postings is ours (InfrastructureError), not the channel's", async () => {
    const registry = new ChannelRegistry();
    // Postgres jsonb refuses \u0000: the upsert fails
    registry.register(
      {
        ...probeChannel("cut", { usesQueries: false }),
        async collect() {
          throw new PartialCollectError([{ externalId: "p1", url: null, payload: { text: "a\u0000b" } }], network());
        },
      },
      { settings: settings() },
    );
    const result = await run(registry);
    const collect = collectOf(result);
    expect(collect.errors).toEqual([expect.stringMatching(/^cut: InfrastructureError: could not store postings of cut/)]);
    const [only] = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(only).toMatchObject({ status: "failed", errorCode: "unknown", error: "could not store postings", interrupted: false });
    expect(await channelRow("cut")).toMatchObject({ consecutiveFailures: 0 });
  });
});

describe("a real paginated channel", () => {
  /** StepStone from the recorded pages; page 2 of every search answers 503. */
  const fetch: FetchLike = async (requestUrl) => {
    const target = new URL(requestUrl);
    if (target.pathname.startsWith("/jobs/")) {
      if (Number(target.searchParams.get("page") ?? "1") > 1) return htmlResponse(503, "busy");
      return htmlResponse(200, fixtureHtml("stepstone", "search-berlin.html"));
    }
    return htmlResponse(404, "gone");
  };

  it("keeps page 1 of a search whose page 2 fails, and records the run as interrupted", async () => {
    const registry = new ChannelRegistry();
    registry.register(createStepstoneChannel({ now: () => new Date("2026-10-07T12:00:00Z") }));
    const sources = channelsWith((raw) => {
      raw.circuit_breaker = { failures: FAILURES_TO_OPEN, cooldown_hours: COOLDOWN_HOURS };
      const stepstone = (raw.sources as Record<string, Record<string, unknown>>).stepstone!;
      stepstone.enabled = true;
      stepstone.max_pages = 2;
    });
    const search = { ...shippedSearch(), keyword_groups: { engineering: ["AI Engineer"] }, locations: ["Berlin"], remote_scope: "none" as const };
    const result = await runCycle("manual", {
      registry,
      config: { ...config(), channels: sources, search },
      logger: quietLogger,
      sleep: async () => {},
      channelIds: ["stepstone"],
      fetch,
    });

    const [only] = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(only).toMatchObject({ channelId: "stepstone", status: "partial", interrupted: true, errorCode: "network", fetched: 5, newCount: 5 });
    expect((await listRawPostingsForChannel(getDb(), "stepstone")).map((r) => r.externalId).sort()).toEqual([
      "90000001",
      "90000002",
      "90000003",
      "90000004",
      "90000008",
    ]);
    expect(collectOf(result).channels.stepstone).toMatchObject({ succeeded: 0, interrupted: 1, errorCodes: { network: 1 } });
    expect(await channelRow("stepstone")).toMatchObject({ consecutiveFailures: 1, lastErrorCode: "network" });
  });
});

describe("the readers tell an interrupted query from one with invalid records (both partial with error code parse)", () => {
  /** One cycle: `cut` fails on page 2 (parse) after storing page 1, `invalid` answers with one invalid record, `whole` answers fully. */
  async function cycleOfThree() {
    const registry = new ChannelRegistry();
    registry.register(interruptedChannel("cut", pageParse), { settings: settings() });
    registry.register(probeChannel("invalid", { usesQueries: false, records: () => [record("ok"), { externalId: "" } as unknown as RawPostingInput] }), {
      settings: settings(),
    });
    registry.register(probeChannel("whole", { usesQueries: false }), { settings: settings() });
    return run(registry, { now: () => new Date() });
  }

  it("Today's cycle summary: interrupted is a (warn-level) failed channel with its code; invalid records stay ok", async () => {
    await cycleOfThree();
    const summary = await getLatestCycleSummary(getDb());
    const byId = new Map(summary?.channels.map((c) => [c.channelId, c]));
    expect(byId.get("cut")).toMatchObject({ outcome: "interrupted", errorCode: "parse", fetched: 2 });
    expect(byId.get("invalid")).toMatchObject({ outcome: "ok", errorCode: null });
    expect(byId.get("whole")).toMatchObject({ outcome: "ok" });
    expect(summary?.failedChannels).toBe(1);
  });

  it("the sidebar status counts the interrupted channel as failed, the other two as ok", async () => {
    await cycleOfThree();
    expect((await getShellCycleStatus(getDb())).sources).toEqual({ ok: 2, failed: 1, circuitOpen: 0 });
  });

  it("/sources: the latest cycle, the per-cycle history and the run list carry the marker", async () => {
    const result = await cycleOfThree();
    const latest = await getLatestCycleRuns(getDb());
    const byId = new Map(latest?.channels.map((c) => [c.channelId, c]));
    expect(byId.get("cut")).toMatchObject({ succeeded: 0, interrupted: 1 });
    expect(byId.get("invalid")).toMatchObject({ succeeded: 1, interrupted: 0 });
    expect(byId.get("whole")).toMatchObject({ succeeded: 1, interrupted: 0 });

    const history = await listChannelCycleHistory(getDb(), 1);
    const [cut] = history.get("cut") ?? [];
    const [invalid] = history.get("invalid") ?? [];
    expect(cut).toMatchObject({ cycleId: result.cycleId, partial: 0, interrupted: 1 });
    expect(invalid).toMatchObject({ cycleId: result.cycleId, partial: 1, interrupted: 0 });
    expect(cycleOutcome(cut ?? null)).toBe("warn");
    expect(cycleOutcome(invalid ?? null)).toBe("warn");

    const recent = await listRecentRunsByChannel(getDb(), 5);
    expect(recent.get("cut")?.find((r) => r.status === "partial")).toMatchObject({ interrupted: true, errorCode: "parse" });
    expect(recent.get("invalid")?.[0]).toMatchObject({ status: "partial", interrupted: false, errorCode: "parse" });
  });
});

describe("migration 0033: runs.interrupted", () => {
  it("keeps every run of a database at 0032 and marks none of them interrupted (each old partial is an invalid-records one)", async () => {
    const admin = new URL(url);
    const name = `${admin.pathname.slice(1)}_m33`;
    const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-mig-"));
    try {
      await adminSql.unsafe(`create database "${name}"`);
      const target = new URL(url);
      target.pathname = `/${name}`;
      // the migrations before this one only
      fs.cpSync(path.resolve("drizzle"), folder, { recursive: true });
      const journalFile = path.join(folder, "meta", "_journal.json");
      const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      const added = journal.entries.find((entry) => entry.tag.endsWith("_run_interrupted"));
      if (!added) throw new Error("migration not found");
      fs.writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx < added.idx) }));
      await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 }, url: target.toString(), migrationsFolder: folder });

      const db = postgres(target.toString(), { max: 1, onnotice: () => {} });
      try {
        await db`insert into channels (id, family, kind) values ('board', 'ats', 'api')`;
        for (const [status, code] of [
          ["succeeded", null],
          ["partial", "parse"],
          ["failed", "network"],
          ["skipped", "budget_exceeded"],
        ] as const) {
          await db`insert into runs (channel_id, status, fetched, error_code, finished_at) values ('board', ${status}, 3, ${code}, now())`;
        }
        const before = await db`select id, channel_id, status::text as status, fetched, error_code, started_at, finished_at from runs order by id`;

        await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 }, url: target.toString() });
        const after = await db`select id, channel_id, status::text as status, fetched, error_code, started_at, finished_at from runs order by id`;
        expect(after).toEqual(before);
        expect((await db`select interrupted from runs order by id`).map((r) => r.interrupted)).toEqual([false, false, false, false]);
        // new rows default to "not interrupted" too
        await db`insert into runs (channel_id) values ('board')`;
        const [fresh] = await db`select interrupted from runs order by id desc limit 1`;
        expect(fresh?.interrupted).toBe(false);
      } finally {
        await db.end({ timeout: 2 });
      }
    } finally {
      await adminSql.unsafe(`drop database if exists "${name}" with (force)`);
      await adminSql.end({ timeout: 2 });
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }, 180_000); // a database built from all migrations
});

describe("a planned budget stop", () => {
  const budgetStop = () => new BudgetExceededError("channel", "cut: paced share of the monthly limit used for now");

  /** A channel that returns two postings and then stops as planned (its next request was refused before it was sent). */
  function stoppingChannel(id: string, cause: () => ChannelError = budgetStop): Channel {
    return {
      ...probeChannel(id, { usesQueries: false }),
      async collect() {
        throw new PartialCollectError([record("p1"), record("p2")], cause(), { planned: true });
      },
    };
  }

  it("stores the postings and records a skipped run: no failure, no interruption, no circuit count", async () => {
    const registry = new ChannelRegistry();
    registry.register(stoppingChannel("cut"), { settings: settings() });
    const result = await run(registry);

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ status: "skipped", interrupted: false, errorCode: "budget_exceeded", fetched: 2, newCount: 2 });
    expect(runs[0]?.error).toMatch(/^budget reached after 2 postings/);
    // the channel is given up on for the cycle, as after a plain budget refusal: the unit's own skipped row follows
    expect(runs.slice(1).map((r) => [r.status, r.interrupted, r.fetched])).toEqual([["skipped", false, 0]]);
    expect((await listRawPostingsForChannel(getDb(), "cut")).map((r) => r.externalId)).toEqual(["p1", "p2"]);
    expect(collectOf(result).channels.cut).toMatchObject({ succeeded: 0, failed: 0, interrupted: 0, skipped: 2, fetched: 2, inserted: 2, errorCodes: { budget_exceeded: 1 } });
    expect(collectOf(result).unusable).toEqual({ cut: "budget_exceeded" });
    expect(await channelRow("cut")).toMatchObject({ consecutiveFailures: 0, circuitState: "closed" });
  });

  it("a planned stop for any other reason is an ordinary interruption", async () => {
    const registry = new ChannelRegistry();
    registry.register(stoppingChannel("cut", network), { settings: settings() });
    const result = await run(registry);
    const [only] = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(only).toMatchObject({ status: "partial", interrupted: true, errorCode: "network", fetched: 2 });
    expect(collectOf(result).channels.cut).toMatchObject({ skipped: 0, interrupted: 1 });
    expect(await channelRow("cut")).toMatchObject({ consecutiveFailures: 1 });
  });

  it("a dry run reports the kept postings and the skip, and writes nothing", async () => {
    const registry = new ChannelRegistry();
    registry.register(stoppingChannel("cut"), { settings: settings() });
    const result = await run(registry, { dryRun: true });
    const collect = collectOf(result);
    expect(collect.channels.cut).toMatchObject({ succeeded: 0, interrupted: 0, fetched: 2, inserted: 0 });
    expect(collect.dryRun?.cut).toMatchObject({ fetched: 2 });
    for (const table of ["cycles", "runs", "raw_postings", "channels"]) {
      const [row] = await getDb().execute<{ n: string }>(sql.raw(`select count(*)::int::text as n from ${table}`));
      expect(row?.n).toBe("0");
    }
  });
});

describe("JSearch whose second keyword is refused before its request", () => {
  /** The month allows `limit` requests and no overage is priced, so a keyword past the limit is refused before it is sent. */
  async function cycle(limit: number, groups: Record<string, string[]>) {
    const registry = new ChannelRegistry();
    registry.register(createJsearchChannel({ environment: { JSEARCH_API_KEY: "test-key-not-real" } }));
    const channelsConfig = channelsWith((raw) => {
      raw.circuit_breaker = { failures: FAILURES_TO_OPEN, cooldown_hours: COOLDOWN_HOURS };
      Object.assign((raw.sources as Record<string, Record<string, unknown>>).jsearch!, {
        enabled: true,
        keywords_per_query: 2,
        monthly_request_limit: limit,
        pace_requests: false,
        fetch_details: false,
      });
    });
    const search = { ...shippedSearch(), keyword_groups: groups, locations: ["Berlin"], remote_scope: "none" as const };
    return runCycle("manual", {
      registry,
      config: { ...config(), channels: channelsConfig, search },
      logger: quietLogger,
      sleep: async () => {},
      channelIds: ["jsearch"],
      fetch: async () => jsearchResponse(200, SEARCH_PAGE),
    });
  }

  it("stores what the first keyword read as a skipped run, and the job only the second keyword would have found stays open", async () => {
    const stale = await staleJob("jsearch");
    const result = await cycle(1, { engineering: ["AI Engineer", "LLM Engineer"] });

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ channelId: "jsearch", status: "skipped", interrupted: false, errorCode: "budget_exceeded" });
    expect(runs[0]?.fetched).toBeGreaterThan(0);
    expect((await listRawPostingsForChannel(getDb(), "jsearch")).filter((r) => r.externalId !== "stale")).toHaveLength(runs[0]?.fetched as number);
    expect(collectOf(result).channels.jsearch).toMatchObject({ succeeded: 0, failed: 0, interrupted: 0 });
    expect(await channelRow("jsearch")).toMatchObject({ consecutiveFailures: 0 });

    // no complete run of the channel came after the job was last seen: it is not closed
    expect(await markJobsPossiblyClosed(getDb(), { now: new Date(), days: 7 })).toEqual([]);
    expect(stale).toBeGreaterThan(0);
  });

  // Intended behaviour: closure is judged per channel and by time. A query's window-limited results are no evidence that a
  // job is gone; the link check that follows is. So a later complete run of the channel lets the stale job become possibly closed.
  it("a complete query of the same channel lets the stale job become possibly closed even when another query was skipped (judged per channel and by time)", async () => {
    const stale = await staleJob("jsearch");
    // the month allows 3 requests: the first query uses 2, the second query's first keyword the third, its second keyword is refused
    const result = await cycle(3, { engineering: ["AI Engineer", "LLM Engineer"], other: ["ML Engineer", "Data Engineer"] });

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.slice(0, 2).map((r) => r.status)).toEqual(["succeeded", "skipped"]);
    expect(await markJobsPossiblyClosed(getDb(), { now: new Date(), days: 7 })).toEqual([stale]);
  });
});
