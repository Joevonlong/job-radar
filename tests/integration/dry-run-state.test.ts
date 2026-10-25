import { createServer } from "node:net";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getChannelRows, getDb, getMonthUsage, schema, upsertRawPostings, type Db } from "@/lib/db";
import { classifyProbeFailure, probeCycleState } from "@/lib/db/health";
import { runMigrations } from "@/lib/db/migrate";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";

import { collectOf, config, probeChannel, quietLogger, settings } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T07:00:00Z");
const MONTH = "2026-10";
let ro: ReadOnlyDb;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
  ro = createReadOnlyDb({ url });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, runs, cycles, channels, runtime_state restart identity cascade`);
});

afterEach(() => {
  resetCycleSteps();
});

afterAll(async () => {
  await ro?.close();
  await closeDb();
});

async function snapshot(): Promise<Record<string, string>> {
  const tables = await getDb().execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name`);
  const hashes: Record<string, string> = {};
  for (const { table_name: table } of tables) {
    const [row] = await getDb().execute<{ hash: string }>(sql`
      select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) as hash
      from ${sql.identifier("public")}.${sql.identifier(table)} t`);
    if (!row) throw new Error(`no snapshot for ${table}`);
    hashes[table] = row.hash;
  }
  return hashes;
}

function dry(registry: ChannelRegistry, extra: Partial<RunCycleOptions> = {}) {
  return runCycle("manual", { dryRun: true, db: ro.db, registry, config: config(), logger: quietLogger, sleep: async () => {}, now: () => NOW, ...extra });
}

async function seedKnownPosting() {
  await getDb().insert(schema.channels).values({ id: "known-probe", family: "ats", kind: "api" });
  await upsertRawPostings(getDb(), {
    channelId: "known-probe",
    runId: null,
    items: [{ externalId: "k1", url: null, payload: { id: "k1" } }],
  });
}

function registerKnownProbe(registry: ChannelRegistry) {
  const seen: string[] = [];
  registry.register({
    ...probeChannel("known-probe", { usesQueries: false }),
    async collect(_query, ctx) {
      seen.push(...(await ctx.known.payloads(["k1", "k2"])).keys());
      return [];
    },
  }, { settings: settings() });
  return seen;
}

describe("dry runs with persisted cycle state", () => {
  it("skips a paid channel whose monthly budget is already exhausted", async () => {
    await getDb().insert(schema.channels).values({ id: "indeed", family: "indeed", kind: "paid", monthUsage: { [MONTH]: { records: 10, usd: 10 } } });
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { id: "indeed", costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 10 } });
    const before = await snapshot();

    const result = await dry(registry);

    expect(fixture.seen).toHaveLength(0);
    expect(collectOf(result).channels.indeed?.skipped).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it("uses the persisted spend of other channels for the global paid cap", async () => {
    await getDb().insert(schema.channels).values({ id: "linkedin-brightdata", family: "linkedin", kind: "paid", monthUsage: { [MONTH]: { records: 10, usd: 14.5 } } });
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { id: "indeed", costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 10 } });
    const cfg = config();
    cfg.channels.paid_total_monthly_budget_usd = 15;
    const before = await snapshot();

    await dry(registry, { config: cfg });

    expect(fixture.seen).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  it("skips a channel whose circuit is still cooling down", async () => {
    await getDb().insert(schema.channels).values({
      id: "indeed", family: "indeed", kind: "api", circuitState: "open", consecutiveFailures: 3,
      circuitOpenUntil: new Date(NOW.getTime() + 3_600_000),
    });
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { id: "indeed" });
    const before = await snapshot();

    const result = await dry(registry);

    expect(fixture.seen).toHaveLength(0);
    expect(collectOf(result).channels.indeed?.skipped).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["read-only", "writable"] as const)("probes a cooled-down circuit once and only reopens it in memory with a %s database", async (connection) => {
    const until = new Date(NOW.getTime() - 3_600_000);
    await getDb().insert(schema.channels).values({
      id: "indeed", family: "indeed", kind: "api", circuitState: "open", consecutiveFailures: 3, circuitOpenUntil: until,
    });
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { id: "indeed", failure: { code: "network", times: 1 } });
    const before = await snapshot();

    await dry(registry, { db: connection === "read-only" ? ro.db : getDb() });

    expect(fixture.seen).toHaveLength(1);
    expect((await getChannelRows(getDb(), ["indeed"]))[0]).toMatchObject({ circuitState: "open", circuitOpenUntil: until });
    expect(await snapshot()).toEqual(before);
  });

  it("provides stored postings to a channel through its known-postings view", async () => {
    await seedKnownPosting();
    const registry = new ChannelRegistry();
    const seen = registerKnownProbe(registry);
    const before = await snapshot();

    await dry(registry);

    expect(seen).toEqual(["k1"]);
    expect(await snapshot()).toEqual(before);
  });

  it("exposes stored postings to cycle steps without exposing a writable database handle", async () => {
    await seedKnownPosting();
    const captured: { db?: Db | null; known?: Map<string, unknown> } = {};
    registerCycleStep("collect", async (ctx) => {
      Object.assign(captured, { db: ctx.db, known: await ctx.channels.known("known-probe").payloads(["k1"]) });
    });

    await dry(new ChannelRegistry());

    expect(captured.db).toBeNull();
    expect(captured.known?.size).toBe(1);
  });

  it("keeps all database rows unchanged and skips every later step even with a writable database", async () => {
    await getDb().insert(schema.channels).values({
      id: "indeed", family: "indeed", kind: "api", monthUsage: { [MONTH]: { records: 1, usd: 1 } },
      circuitState: "open", consecutiveFailures: 3, circuitOpenUntil: new Date(NOW.getTime() - 3_600_000),
    });
    await seedKnownPosting();
    const registry = new ChannelRegistry();
    const paid = registerFixtureChannel(registry, { id: "fx-paid", family: "linkedin", costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 100 } });
    registerFixtureChannel(registry, { id: "indeed", failure: { code: "network", times: 4 } });
    registerKnownProbe(registry);
    const laterSteps = ["pipeline", "filter", "signals", "ai", "notify", "maintenance"] as const;
    const spies = laterSteps.map((name) => {
      const spy = vi.fn(async () => {});
      registerCycleStep(name, spy);
      return spy;
    });
    const before = await snapshot();
    const usage = await getMonthUsage(getDb(), MONTH);

    const result = await dry(registry, { db: getDb(), cascades: [{ family: "linkedin", order: ["fx-paid"] }] });

    expect(paid.seen.length).toBeGreaterThan(0);
    expect(collectOf(result).channels["fx-paid"]?.costUsd).toBeGreaterThan(0);
    expect(await getMonthUsage(getDb(), MONTH)).toEqual(usage);
    expect(await snapshot()).toEqual(before);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const name of laterSteps) expect(result.summary.steps.find((step) => step.name === name)?.status).toBe("skipped");
  });
});

describe("cycle state probe", () => {
  it("recognizes a migrated database", async () => {
    await expect(probeCycleState(ro.db)).resolves.toBe("ok");
  });

  it("recognizes a reachable database without migrations", async () => {
    const name = `${new URL(url).pathname.slice(1)}_unmigrated`;
    const admin = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`create database "${name}"`);
      const target = new URL(url);
      target.pathname = `/${name}`;
      const empty = createReadOnlyDb({ url: target.toString() });
      try {
        await expect(probeCycleState(empty.db)).resolves.toBe("not_migrated");
      } finally {
        await empty.close();
      }
    } finally {
      try {
        await admin.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await admin.end({ timeout: 2 });
      }
    }
  });

  it("returns unreachable when the database port has no listener", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (address === null || typeof address === "string") throw new Error("no unused TCP port");
    const target = new URL(url);
    target.port = String(address.port);
    const unavailable = createReadOnlyDb({ url: target.toString(), connectTimeoutSeconds: 1 });
    try {
      await expect(probeCycleState(unavailable.db)).resolves.toBe("unreachable");
    } finally {
      await unavailable.close();
    }
  });

  it.each([
    { name: "a missing table", error: { code: "42P01" }, expected: "not_migrated" },
    { name: "a missing column", error: { code: "42703" }, expected: "not_migrated" },
    { name: "a wrapped missing table", error: { cause: { code: "42P01" } }, expected: "not_migrated" },
    { name: "a wrapped missing column", error: { cause: { code: "42703" } }, expected: "not_migrated" },
    { name: "a permission denial", error: { code: "42501" }, expected: "unreadable" },
    { name: "an error without a code", error: new Error("read failed"), expected: "unreadable" },
  ])("classifies $name as $expected", ({ error, expected }) => {
    expect(classifyProbeFailure(error)).toBe(expected);
  });
});
