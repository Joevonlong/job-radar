// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { registerFixtureChannel, type FixturePosting } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { runCycle } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { parseSnapshot } from "@/lib/db/queries/dedupe-snapshot";
import { runPipeline } from "@/lib/pipeline";
import { buildGuardReport, preparePostings, runReplay, withTitleGuard } from "@/lib/pipeline/replay";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { pipelineWith } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");

const SHARED =
  "You will design and run the services behind our logistics platform, review pull requests, write clear documents, mentor colleagues, plan experiments with the product team, keep production healthy on call, and share what you learn in regular talks with the whole engineering group across every office we have.";
const OTHER =
  "You will plan the marketing calendar for our consumer brands, brief agencies, write campaign reports, negotiate media budgets, run customer interviews with the research team, and present the results to the leadership group every quarter so that the next season starts with a clear plan and shared goals.";

const posting = (id: string, extra: Partial<FixturePosting>): FixturePosting => ({
  id,
  title: `Job ${id}`,
  company: "Acme GmbH",
  city: "Berlin",
  country: "DE",
  remote: false,
  description: SHARED,
  url: `https://jobs.example.test/${id}`,
  posted_at: "2026-10-06T08:00:00Z",
  ...extra,
});

/** Filed in this order (a channel at a time). Covers the four passes, no SimHash, a better source's late title, a related company's take-over and one posting in two channels. */
const LOW: readonly FixturePosting[] = [
  posting("exact-1", { title: "Exact Key Engineer", description: `${SHARED} Exact.` }),
  posting("exact-2", { title: "Exact Key Engineer", description: OTHER }),
  posting("short-1", { title: "Short Text Engineer", description: "Too short for a hash." }),
  posting("short-2", { title: "Short Text Engineer", city: "Köln", description: "Too short again." }),
  posting("near-1", { title: "Near Engineer", city: "Hamburg", description: `${OTHER} One.` }),
  posting("near-2", { title: "Near Engineer (Remote)", city: "Köln", description: `${OTHER} One.` }),
  posting("level-1", { title: "Staff Near Engineer", city: "München", description: `${OTHER} One.` }),
  posting("rewrite-1", { title: "Platform Engineer", company: "Rewrite AG", city: "Bonn", description: `${SHARED} Rewrite.` }),
  posting("related-1", { title: "Data Engineer", company: "Contoso", city: "Bonn", description: `${SHARED} Related.` }),
  posting("twice", { title: "Twice Engineer", company: "Twice AG", city: "Essen", description: `${OTHER} Twice.` }),
];
const HIGH: readonly FixturePosting[] = [
  posting("rewrite-2", { title: "Platform Engineer (Remote)", company: "Rewrite AG", city: "Trier", description: `${SHARED} Rewrite.` }),
  posting("rewrite-3", { title: "Platform Engineer (Remote)", company: "Rewrite AG", city: "Trier", description: OTHER }),
  posting("related-2", { title: "Data Engineer", company: "Contoso Digital GmbH", city: "Mainz", description: `${SHARED} Related.` }),
  posting("related-3", { title: "Analytics Engineer", company: "Contoso Digital GmbH", city: "Bonn", description: `${SHARED} Related.` }),
  posting("related-4", { title: "Data Engineer", company: "Contoso Digital GmbH", city: "Mainz", description: OTHER }),
  posting("twice", { title: "Twice Engineer", company: "Twice AG", city: "Essen", description: `${OTHER} Twice.` }),
];

function registryWith(): ChannelRegistry {
  const registry = new ChannelRegistry();
  registerFixtureChannel(registry, { id: "fx-low", family: "linkedin", usesQueries: false, postings: [...LOW] });
  registerFixtureChannel(registry, { id: "fx-low-twin", family: "linkedin", usesQueries: false, postings: LOW.filter((p) => p.id === "twice") });
  registerFixtureChannel(registry, { id: "fx-high", family: "ats", usesQueries: false, postings: [...HIGH] });
  return registry;
}

/** Raw id -> the smallest raw id of its group: comparable across runs whatever the job ids are. */
function partition(groups: ReadonlyMap<number, number>): Map<number, number> {
  const first = new Map<number, number>();
  for (const [raw, group] of [...groups].sort((a, b) => a[0] - b[0])) if (!first.has(group)) first.set(group, raw);
  return new Map([...groups].map(([raw, group]) => [raw, first.get(group) as number]));
}

const collect = async (registry: ChannelRegistry): Promise<void> => {
  resetCycleSteps();
  await runCycle("manual", { registry, config: cycleConfig(), logger: quietLogger, sleep: async () => {} });
};

const reset = () => getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);

describe("the offline replay", () => {
  let temp: TempConfig;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  });
  beforeEach(async () => {
    temp = makeTempConfig();
    await reset();
    registerBuiltinCycleSteps();
  });
  afterEach(() => {
    resetCycleSteps();
    temp.cleanup();
  });
  afterAll(async () => {
    await closeDb();
  });

  it.each([
    ["the title check on", true],
    ["the title check off", false],
  ])("groups postings exactly as the pipeline does, with %s", async (_name, enabled) => {
    const config = pipelineWith((raw) => ((raw.dedupe as Record<string, unknown>).title_guard = { enabled, same_title_max_distance: 6 }));
    const registry = registryWith();
    await collect(registry);
    const raws = await getDb().select().from(schema.rawPostings).orderBy(schema.rawPostings.id);
    expect(raws.length).toBe(LOW.length + 1 + HIGH.length);
    const result = await runPipeline(getDb(), { relist: { minGapDays: 9 }, config, registry, logger: quietLogger });
    expect(result.processed).toBe(raws.length);
    expect(result.merged.exact_key).toBeGreaterThan(0);
    expect(result.merged.simhash).toBeGreaterThan(0);
    expect(result.merged.same_source).toBeGreaterThan(0);

    const links = await getDb().select().from(schema.jobSources);
    const real = new Map(links.map((link) => [link.rawPostingId, link.jobId]));

    const prepared = preparePostings(raws.map((raw) => ({ id: raw.id, channel_id: raw.channelId, external_id: raw.externalId, payload: raw.payloadJson })), { registry, config });
    expect(prepared.skipped).toEqual([]);
    expect(prepared.withoutSimhash).toBe(2);
    const replay = await runReplay(prepared.postings, config);
    expect([...partition(replay.groups)].sort((a, b) => a[0] - b[0])).toEqual([...partition(real)].sort((a, b) => a[0] - b[0]));
    expect(replay.created).toBe(result.created);
    // the pipeline counts a related-company merge under its SimHash column
    expect(replay.merged.related_company).toBeGreaterThan(0);
    expect({ ...replay.merged, simhash: replay.merged.simhash + replay.merged.related_company, related_company: undefined }).toMatchObject(result.merged);
    expect(replay.blocked).toBe(result.titleGuard.blocked);
    if (enabled) expect(result.titleGuard.blocked).toBeGreaterThan(0);
  });

  it("reports the header, the sweep, the three lists and the audit", async () => {
    const config = pipelineWith(() => {});
    const registry = registryWith();
    const fixture = fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/simhash/snapshot.ndjson"), "utf8");
    const snapshot = parseSnapshot(fixture);
    const report = await buildGuardReport({ snapshot, sha256: "feed", productSha: "cafe", config: withTitleGuard(config, { enabled: true }), seed: 7, registry });
    for (const heading of ["== HEADER ==", "== SWEEP of same_title_max_distance ==", "== LOST merges", "== ADDED merges", "== MOVED postings", "== AUDIT of stored merges"]) expect(report.text).toContain(heading);
    expect(report.text).toContain("product commit: cafe");
    expect(report.text).toContain("sha256 feed");
    expect(report.text).toMatch(/sample seed: 7/);
    expect(report.text).toMatch(/old rule\s+\d+/);
    for (const limit of [3, 4, 5, 6, 7, 8]) expect(report.text).toMatch(new RegExp(`same<=${limit}\\s+\\d+`));
    const again = await buildGuardReport({ snapshot, sha256: "feed", productSha: "cafe", config: withTitleGuard(config, { enabled: true }), seed: 7, registry });
    expect(again.text).toBe(report.text);
    expect(report.text).toMatch(/LOST merges: one group under the old rule, apart now \(1\)/);
    expect(report.text).toMatch(/ADDED merges: apart under the old rule, one group now \(1\)/);
  });
});
