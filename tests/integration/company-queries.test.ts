import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { createFixtureChannel, FIXTURE_SETTINGS, type FixturePosting } from "@/lib/channels/fixture";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { stubContext } from "../channels/helpers";
import { buildCompanyQueries, buildQueries } from "@/lib/channels/query";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { Channel, SearchQuery } from "@/lib/channels/types";
import { buildWatchedCompanyKeys } from "@/lib/companies/marks";
import { loadConfig, writeConfig, ensureProfileFiles } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, listPushCandidates, listRawPostingsForChannel, listRunsForCycle, schema } from "@/lib/db";
import * as runRepo from "@/lib/db/repos/runs";
import { runMigrations } from "@/lib/db/migrate";
import { currentPreferences, runFilter } from "@/lib/filter";
import * as market from "@/lib/market";
import { loadPipeline } from "@/lib/market";
import { selectForPush } from "@/lib/notify/select";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { collectOf, config, pinnedSearch } from "../cycle/helpers";

let temp: TempConfig;
const databaseUrl = inject("testDatabaseUrl");
const NOW = new Date("2026-10-30T08:00:00Z");
const logs: LogRecord[] = [];
const logger = createLogger({ sink: (record) => logs.push(record) });
const names = ["Northstar Labs", "Moonbeam"];

beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; await runMigrations(); });
beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, jobs, companies, runs, cycles, channels restart identity cascade`);
  temp = makeTempConfig();
  await writeConfig("interests", { ...loadConfig("interests"), watched_companies: names });
  logs.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); resetCycleSteps(); temp.cleanup(); });
afterAll(async () => { await closeDb(); });

function setup(options: { rotation?: boolean; interval?: number; cap?: number; maxCatchUp?: number } = {}) {
  const cfg = config({ search: { ...pinnedSearch(), keyword_groups: { a: ["alpha"], b: ["beta"] }, locations: ["Berlin"], remote_scope: "none",
    watched_company_queries: { enabled: true, max_per_cycle: options.cap ?? 1, min_interval_hours: options.interval ?? 24, max_results: 7 } } });
  cfg.channels.collect.query_rotation = options.rotation ?? true;
  cfg.channels.collect.max_catch_up_hours = options.maxCatchUp ?? 168;
  const registry = new ChannelRegistry();
  const add = (id: string, company: boolean, collect: Channel["collect"] = async () => [], extra: Partial<Channel> = {}, enabled = true, companyQueries = true) => {
    const fixture = createFixtureChannel({ id, family: "linkedin", usesQueries: true, postings: [] });
    registry.register({ ...fixture, supportsCompanyQueries: company, collect, ...extra }, { settings: { ...FIXTURE_SETTINGS, enabled, companyQueries } });
    return fixture;
  };
  const run = async (order: string[], now = NOW) => {
    const result = await runCycle("manual", { registry, config: cfg, cascades: [{ family: "linkedin", order }], logger, now: () => now, sleep: async () => {} });
    await getDb().update(schema.runs).set({ startedAt: now }).where(eq(schema.runs.cycleId, result.cycleId!));
    return { result, rows: await listRunsForCycle(getDb(), result.cycleId!), collect: collectOf(result) };
  };
  return { cfg, registry, add, run };
}
const isCompany = (q: SearchQuery) => q.company !== null;
const posting = (id: string, company: string): FixturePosting => ({ id, company, title: "AI Engineer", city: "Hamburg", country: "DE", remote: false,
  description: "Build reliable software. Full-time permanent position.", url: `https://example.test/jobs/${id}`, posted_at: NOW.toISOString() });

describe("company-query collection", () => {
  it.each(["disabled", "empty"])("does not introduce pipeline reads when company queries are %s", async (mode) => {
    const test = setup();
    if (mode === "disabled") test.cfg.search.watched_company_queries.enabled = false;
    else await writeConfig("interests", { ...loadConfig("interests"), watched_companies: [] });
    const pipeline = vi.spyOn(market, "loadPipeline").mockImplementation(() => { throw new Error("must not load"); });
    test.add("company", true);
    const { rows } = await test.run(["company"]);
    expect(pipeline).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "succeeded")).toBe(true);
  });

  it("does not create candidates for disabled, unconfigured, opted-out, or unsupported members", async () => {
    for (const kind of ["disabled", "unconfigured", "opted-out", "unsupported"]) {
      const test = setup();
      test.add(kind, kind !== "unsupported", async () => [], kind === "unconfigured" ? { isConfigured: () => false } : {}, kind !== "disabled", kind !== "opted-out");
      const result = await test.run([kind]);
      expect(result.rows.every((row) => buildQueries(test.cfg.search, "manual").some((q) => q.id === row.queryHash))).toBe(true);
      expect(result.collect.queries).toBe(2);
    }
  });

  it.each([true, false])("rotates scarce capacity without starving either query kind (rotation %s)", async (rotation) => {
    const test = setup({ rotation, cap: 1, interval: 1 });
    let served: SearchQuery[] = [];
    test.add("limited", true, async (query) => {
      if (served.length >= 1) throw new ChannelError("budget_exceeded", "cycle capacity");
      served.push(query); return [];
    });
    const all: string[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      served = [];
      const { rows } = await test.run(["limited"], new Date(NOW.getTime() + cycle * 3_600_000));
      all.push(...served.map((q) => q.id));
      expect(rows.filter((row) => row.status === "succeeded" && served.find((q) => q.id === row.queryHash)?.company)).toHaveLength(0 + Number(served.some(isCompany)));
      expect(served.filter(isCompany).length).toBeLessThanOrEqual(1);
    }
    if (rotation) {
      const company = buildCompanyQueries(test.cfg.search, names.map((name, i) => ({ name, key: i ? "moonbeam" : "northstar-labs", hasBoard: false })), 24);
      expect(new Set(all)).toEqual(new Set([...buildQueries(test.cfg.search, "manual"), ...company].map((q) => q.id)));
    } else expect(new Set(all).size).toBe(1);
  });

  it("skips ineligible members without runs or circuit changes", async () => {
    const test = setup();
    test.add("keyword-only", false);
    test.add("company-capable", true);
    const { rows } = await test.run(["keyword-only", "company-capable"]);
    expect(rows.map((r) => r.channelId)).toEqual(["keyword-only", "keyword-only", "company-capable"]);
    expect(rows.every((r) => r.status === "succeeded")).toBe(true);
  });

  it.each(["blocked", "budget_exceeded"] as const)("shares per-cycle %s failures with company queries", async (code) => {
    const test = setup();
    let attempts = 0;
    test.add("first", true, async () => { attempts++; throw new ChannelError(code, "test refusal"); });
    test.add("second", true);
    const { rows, collect } = await test.run(["first", "second"]);
    expect(attempts).toBe(1);
    expect(collect.unusable.first).toBe(code);
    expect(rows.filter((r) => r.channelId === "second")).toHaveLength(3);
  });

  it("records a company skip on its eligible holder and continues later keyword queries", async () => {
    const test = setup({ cap: 2 });
    // Give keywords newer turns, so a company query is first next time.
    test.add("keyword-only", false);
    let refuse = false;
    test.add("company-capable", true, async () => { if (refuse) throw new ChannelError("budget_exceeded", "no room"); return []; });
    await test.run(["keyword-only", "company-capable"]);
    await getDb().update(schema.runs).set({ startedAt: new Date(NOW.getTime() - 3_600_000) }).where(eq(schema.runs.channelId, "company-capable"));
    refuse = true;
    const { rows } = await test.run(["keyword-only", "company-capable"], new Date(NOW.getTime() + 25 * 3_600_000));
    expect(rows.filter((r) => r.channelId === "keyword-only")).toHaveLength(2);
    expect(rows.find((r) => r.windowHours === null)).toMatchObject({ channelId: "company-capable", status: "skipped" });
    expect(rows.find((r) => r.windowHours === null)?.error).not.toContain("keyword-only");
    expect(rows[0]?.channelId).toBe("company-capable");
    expect(rows.at(-1)?.channelId).toBe("keyword-only");
  });

  it("a retryable company failure fails its query without falling through", async () => {
    const test = setup();
    test.add("first", true, async (q) => { if (isCompany(q)) throw new ChannelError("network", "retry exhausted"); return []; });
    test.add("second", true);
    const { rows } = await test.run(["first", "second"]);
    expect(rows.filter((r) => r.channelId === "second")).toEqual([]);
    expect(rows.at(-1)).toMatchObject({ status: "failed", errorCode: "network" });
  });

  it.each([false, true])("filters unrelated employers before persisting even partial answers (%s)", async (partial) => {
    const test = setup();
    const auditConfig = loadConfig("deliveryAudit");
    await writeConfig("deliveryAudit", { ...auditConfig, scope: { ...auditConfig.scope, channel_kinds: ["manual"] } });
    const fixture = createFixtureChannel({ postings: [posting("same", "Northstar Labs GmbH"), posting("other-watched", "Moonbeam"), posting("wrong", "Agency")] });
    const records = await fixture.collect(buildQueries(test.cfg.search, "manual")[0]!, stubContext());
    // A broken payload is deliberately kept, so the pipeline can diagnose it.
    records.push({ externalId: "broken", url: null, payload: { invalid: true } });
    test.add("company", true, async (q) => {
      if (!isCompany(q)) return [];
      if (partial) throw new PartialCollectError(records, new ChannelError("network", "lost later page"));
      return records;
    }, { parse: fixture.parse });
    const { rows } = await test.run(["company"]);
    const stored = await listRawPostingsForChannel(getDb(), "company");
    expect(stored.map((r) => r.externalId).sort()).toEqual(["broken", "other-watched", "same"]);
    expect(rows.at(-1)).toMatchObject({ fetched: 4, newCount: 3, status: partial ? "partial" : "succeeded", interrupted: partial });
    expect(logs.find((r) => r.message === "company query matched")?.fields.company_mismatch).toBe(1);
    const audit = await getDb().select().from(schema.deliveryItems);
    expect(audit.filter((r) => r.disposition === "discarded_on_failure")).toHaveLength(1);
  });

  it("uses family-wide eligible turns when a different member starts", async () => {
    const test = setup();
    test.add("paid", false);
    test.add("guest", true);
    await test.run(["guest", "paid"]);
    const next = await test.run(["paid", "guest"], new Date(NOW.getTime() + 2 * 3_600_000));
    // The second company is still unrun and due; the first cannot bypass its interval.
    expect(next.rows.filter((r) => r.channelId === "guest")).toHaveLength(1);
    const firstCompany = buildCompanyQueries(test.cfg.search, [{ name: names[0]!, key: "northstar-labs", hasBoard: false }], 24)[0]!;
    expect(next.rows.some((r) => r.queryHash === firstCompany.id)).toBe(false);
  });

  it("widens company coverage after a gap and caps the window", async () => {
    const test = setup({ maxCatchUp: 48 });
    const windows: number[] = [];
    test.add("company", true, async (q) => { if (isCompany(q)) windows.push(q.windowHours); return []; });
    test.cfg.search.watched_company_queries.max_per_cycle = 2;
    await test.run(["company"]);
    await test.run(["company"], new Date(NOW.getTime() + 100 * 3_600_000));
    expect(windows).toEqual([24, 24, 48, 48]);
  });

  it("uses interval plus tolerance for a channel that cannot catch up", async () => {
    const test = setup({ interval: 36, maxCatchUp: 40 });
    const windows: number[] = [];
    test.add("company", true, async (q) => { if (isCompany(q)) windows.push(q.windowHours); return []; }, { supportsCatchUp: () => false });
    test.cfg.channels.collect.catch_up_tolerance_hours = 6;
    await test.run(["company"]);
    expect(windows).toEqual([40]);
  });

  it("a company-only budget refusal falls through to the next eligible member", async () => {
    const test = setup();
    test.add("first", true, async (q) => { if (isCompany(q)) throw new ChannelError("budget_exceeded", "company allowance refused"); return []; });
    test.add("second", true);
    const { rows } = await test.run(["first", "second"]);
    expect(rows.map((r) => [r.channelId, r.status])).toEqual([["first", "succeeded"], ["first", "succeeded"], ["first", "skipped"], ["second", "succeeded"]]);
    const [state] = await getDb().select().from(schema.channels).where(eq(schema.channels.id, "first"));
    expect(state?.consecutiveFailures).toBe(0);
  });

  it("skips an open circuit for company queries without another failure strike", async () => {
    const test = setup();
    test.cfg.channels.circuit_breaker.failures = 1;
    test.add("first", true, async () => { throw new ChannelError("network", "retry exhausted"); });
    test.add("second", true);
    const { rows } = await test.run(["first", "second"]);
    expect(rows.filter((r) => r.channelId === "first")).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ channelId: "second", status: "succeeded" });
    const [state] = await getDb().select().from(schema.channels).where(eq(schema.channels.id, "first"));
    expect(state).toMatchObject({ circuitState: "open", consecutiveFailures: 1 });
  });

  it("uses capped list order when history is unreadable, and lists companies in a dry run without reading history", async () => {
    const test = setup();
    test.add("company", true);
    const history = vi.spyOn(runRepo, "getQueryRunHistory").mockRejectedValue(new Error("history unavailable"));
    const { collect } = await test.run(["company"]);
    expect(collect.rotation.linkedin?.historyUnavailable).toBe(true);
    expect(Object.values(collect.companyQueryKeys ?? {})).toEqual(["northstar-labs", "moonbeam"]);
    expect(logs.find((r) => r.message === "query rotation")?.fields.companyQueries).toEqual({ candidates: 2, due: 2, selected: 1 });
    history.mockClear();
    const result = await runCycle("manual", { dryRun: true, registry: test.registry, config: test.cfg, cascades: [{ family: "linkedin", order: ["company"] }], logger, now: () => NOW, sleep: async () => {} });
    expect(history).not.toHaveBeenCalled();
    expect(collectOf(result).queryPlan?.filter((q) => q.company).map((q) => q.company?.name)).toEqual(names);
  });

  it("retains only the watched Hamburg onsite job through filtering and push selection", async () => {
    const test = setup();
    const fixture = createFixtureChannel({ postings: [posting("watched", "Northstar Labs"), posting("wrong", "Agency")] });
    test.add("company", true, async (q, ctx) => isCompany(q) ? fixture.collect(q, ctx) : [], { parse: fixture.parse });
    await ensureProfileFiles();
    registerBuiltinCycleSteps();
    await test.run(["company"]);
    const jobs = await getDb().select().from(schema.jobs);
    expect(jobs).toHaveLength(1);
    const { preferences, snapshot, me } = await currentPreferences(getDb());
    preferences.locations = ["Berlin"];
    await runFilter(getDb(), { preferences, snapshotId: snapshot.id, me, pipeline: loadPipeline(), logger });
    const scores = await getDb().select().from(schema.scores);
    expect(scores).toMatchObject([{ filterResult: "passed", filterReasons: ["watched_company_location:Hamburg"] }]);
    const selected = selectForPush(await listPushCandidates(getDb(), { since: new Date(0) }), {
      config: { push_min_score: 70, push_min_score_high_value: 60, max_per_cycle: 10 }, watchedKeys: buildWatchedCompanyKeys(names, loadPipeline()), alreadyNotified: new Set(),
    });
    expect(selected.selected.map((item) => item.candidate.jobId)).toEqual([jobs[0]!.id]);
  });
});
