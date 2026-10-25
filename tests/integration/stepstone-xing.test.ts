import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createXingChannel } from "@/lib/channels/xing";
import { createStepstoneChannel } from "@/lib/channels/stepstone";
import type { FetchLike } from "@/lib/channels/http";
import { ChannelRegistry } from "@/lib/channels/registry";
import { registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { runCycle, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, listJobSources, listRawPostingsForChannel, listRunsForCycle, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import type { PipelineResult } from "@/lib/pipeline";

import { channelsWith, shippedSearch } from "../channels/helpers";
import { fixtureHtml, htmlResponse } from "../channels/web/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T12:00:00Z");
let ro: ReadOnlyDb;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
  ro = createReadOnlyDb({ url });
});

const resetTables = () => getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);

let temp: TempConfig;

beforeEach(async () => {
  temp = makeTempConfig();
  await resetTables();
  registerBuiltinCycleSteps();
});

afterEach(() => {
  resetCycleSteps();
  temp.cleanup();
});

afterAll(async () => {
  await ro?.close();
  await resetTables();
  await closeDb();
});

const STEPSTONE_DETAILS: Record<string, string> = {
  "90000001": "detail-berlin.html",
  "90000003": "detail-multicity.html",
  "90000004": "detail-no-jsonld.html",
};
const XING_DETAILS: Record<string, string> = { "90100004": "detail-salary-range.html" };

/** Both boards served from the recorded pages; anything unrecorded is "gone". */
function boards(calls: string[]): FetchLike {
  return async (requestUrl) => {
    const target = new URL(requestUrl);
    calls.push(`${target.host}${target.pathname}`);
    if (target.host === "www.stepstone.de") {
      if (target.pathname.startsWith("/jobs/")) {
        return htmlResponse(200, fixtureHtml("stepstone", Number(target.searchParams.get("page") ?? "1") > 1 ? "search-empty.html" : "search-berlin.html"));
      }
      const file = STEPSTONE_DETAILS[/-(\d+)-inline\.html$/.exec(target.pathname)?.[1] ?? ""];
      return file ? htmlResponse(200, fixtureHtml("stepstone", file)) : htmlResponse(404, "gone");
    }
    if (target.pathname.startsWith("/jobs/search")) return htmlResponse(200, fixtureHtml("xing", "search-berlin.html"));
    const file = XING_DETAILS[/-(\d+)$/.exec(target.pathname)?.[1] ?? ""];
    return file ? htmlResponse(200, fixtureHtml("xing", file)) : htmlResponse(404, "gone");
  };
}

function cycle(fetch: FetchLike, channelIds: string[], extra: Partial<RunCycleOptions> = {}) {
  const registry = new ChannelRegistry();
  registry.register(createStepstoneChannel({ now: () => NOW }));
  registry.register(createXingChannel({ now: () => NOW }));
  const channels = channelsWith((raw) => {
    const sources = raw.sources as Record<string, Record<string, unknown>>;
    for (const id of ["stepstone", "xing"]) {
      sources[id]!.enabled = true;
      sources[id]!.max_pages = 1;
    }
  });
  const search = { ...shippedSearch(), keyword_groups: { engineering: ["AI Engineer"] }, locations: ["Berlin"], remote_scope: "none" as const };
  return runCycle("manual", { registry, config: { ...config(), channels, search }, logger: quietLogger, sleep: async () => {}, channelIds, fetch, ...extra });
}

describe("runCycle with the stepstone and xing channels", () => {
  it("stores the postings verbatim, then turns them into jobs with the board as their source", async () => {
    const calls: string[] = [];
    const result = await cycle(boards(calls), ["stepstone", "xing"]);
    expect(result.status).toBe("succeeded");

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.map((r) => [r.channelId, r.status, r.fetched, r.newCount]).sort()).toEqual([
      ["stepstone", "succeeded", 5, 5],
      ["xing", "succeeded", 2, 2],
    ]);

    // C1: the raw posting keeps the board's own objects, including the page data
    const stepstone = await listRawPostingsForChannel(getDb(), "stepstone");
    expect(stepstone.map((r) => r.externalId).sort()).toEqual(["90000001", "90000002", "90000003", "90000004", "90000008"]);
    const first = stepstone.find((r) => r.externalId === "90000001");
    expect(first?.payloadJson).toMatchObject({ list: { id: 90000001, section: "main" }, detail: { jsonLd: { "@type": "JobPosting" } } });
    const xing = await listRawPostingsForChannel(getDb(), "xing");
    expect(xing.find((r) => r.externalId === "90100004")?.payloadJson).toMatchObject({ list: { slug: "berlin-ai-solution-engineer-90100004" }, detail: { job: { remoteOptions: ["NON_REMOTE"] } } });

    const pipeline = result.results.pipeline as PipelineResult;
    expect(pipeline).toMatchObject({ processed: 7, parsed: 7, parseFailed: 0, aborted: false });
    expect((await getDb().select().from(schema.rawPostings)).every((r) => r.parseStatus === "parsed" && r.parseError === null)).toBe(true);

    const jobs = await getDb().select().from(schema.jobs);
    expect(jobs).toHaveLength(7);
    const workist = jobs.find((j) => j.titleNorm.includes("ai solution engineer"));
    expect(workist).toMatchObject({ title: "AI Solution Engineer (f/m/d)", workplace: "onsite", contract: "unknown", language: "de" });
    expect(workist?.salaryJson).toMatchObject({ eurPerYear: { min: 50000, max: 65000 } });
    const sources = await listJobSources(getDb(), workist?.id ?? 0);
    expect(sources.map((s) => [s.channelId, s.priority])).toEqual([["xing", 3]]);
    expect(sources[0]?.url).toBe("https://www.xing.com/jobs/berlin-ai-solution-engineer-90100004");

    const berlin = jobs.find((j) => j.title === "Senior Applied AI Engineer (m/w/d)");
    expect(berlin).toMatchObject({ workplace: "hybrid", contract: "permanent" });
    expect(berlin?.description).toContain("[contact removed]");
    expect(berlin?.description).not.toMatch(/@example\.test/);
  });

  it("asks for one search and one page per posting", async () => {
    const calls: string[] = [];
    await cycle(boards(calls), ["stepstone"]);
    // one search + one page per posting (5)
    expect(calls.filter((c) => c.startsWith("www.stepstone.de/jobs/"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/stellenangebote--"))).toHaveLength(5);
  });

  it("records a blocked board as a failed run and does not touch the other one (C2)", async () => {
    const calls: string[] = [];
    const real = boards(calls);
    const fetch: FetchLike = async (requestUrl, init) => (new URL(requestUrl).host === "www.stepstone.de" ? htmlResponse(403, fixtureHtml("stepstone", "blocked-403.html")) : real(requestUrl, init));
    const result = await cycle(fetch, ["stepstone", "xing"]);
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.filter((r) => r.channelId === "stepstone").map((r) => [r.status, r.errorCode])).toContainEqual(["failed", "blocked"]);
    expect(runs.find((r) => r.channelId === "xing")).toMatchObject({ status: "succeeded", fetched: 2 });
    expect(calls.some((c) => c.startsWith("www.xing.com"))).toBe(true);
    expect(await listRawPostingsForChannel(getDb(), "stepstone")).toHaveLength(0);
  });

  it("a dry run reuses stored StepStone details and only requests details that are still missing", async () => {
    const calls: string[] = [];
    await cycle(boards(calls), ["stepstone"]);
    const before = await listRawPostingsForChannel(getDb(), "stepstone");
    expect(before).toHaveLength(5);
    const missing = await getDb().execute<{ external_id: string }>(sql`
      select external_id from raw_postings
      where channel_id = 'stepstone' and payload_json -> 'detail' = 'null'::jsonb
      order by external_id`);
    const missingIds = missing.map((row) => row.external_id);
    expect(missingIds).toEqual(["90000002", "90000008"]);
    const storedIds = before.map((row) => row.externalId).filter((id) => !missingIds.includes(id));
    expect(storedIds).toHaveLength(3);
    calls.length = 0;

    await cycle(boards(calls), ["stepstone"], { dryRun: true, db: ro.db });

    expect(calls.filter((call) => call.startsWith("www.stepstone.de/jobs/"))).toHaveLength(1);
    const detailIds = calls.filter((call) => call.includes("/stellenangebote--")).map((call) => /-(\d+)-inline\.html$/.exec(call)?.[1]).sort();
    expect(detailIds).toEqual(missingIds);
    for (const id of storedIds) expect(detailIds).not.toContain(id);
    expect(await listRawPostingsForChannel(getDb(), "stepstone")).toEqual(before);
  });
});
