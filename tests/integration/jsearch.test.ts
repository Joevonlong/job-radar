import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createJsearchChannel } from "@/lib/channels/jsearch";
import type { FetchLike } from "@/lib/channels/http";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { JsearchSettings } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, getMonthUsage, listChannelStates, listJobSources, listRawPostingsForChannel, listRunsForCycle, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { runPipeline } from "@/lib/pipeline";

import { channelsWith } from "../channels/helpers";
import { fixture, MONTH, NOW, response, SEARCH_PAGE } from "../channels/jsearch/helpers";
import { config, quietLogger } from "../cycle/helpers";
import { shippedPipeline } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
const QUOTA = fixture("error-quota-429.json");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table job_sources, jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

/** sources.yaml with jsearch on; 9 queries per cycle (3 keyword groups x (2 cities + remote)), one request each. */
const channelsFor = (edit: Partial<JsearchSettings> = {}) =>
  channelsWith((raw) => {
    Object.assign((raw.sources as Record<string, Record<string, unknown>>).jsearch ?? {}, { enabled: true, pace_requests: false, ...edit });
  });

function setup(options: { settings?: Partial<JsearchSettings>; environment?: Record<string, string | undefined>; fetch: FetchLike }) {
  const channels = channelsFor(options.settings);
  const registry = new ChannelRegistry();
  registry.register(createJsearchChannel({ settings: () => channels.sources.jsearch, environment: options.environment ?? { JSEARCH_API_KEY: "test-key-not-real" }, now: () => NOW }));
  const run = () => runCycle("manual", { registry, config: { ...config(), channels }, logger: quietLogger, sleep: async () => {}, channelIds: ["jsearch"], fetch: options.fetch, now: () => NOW });
  return { registry, run };
}

const answer = (status: number, body: unknown) => async () => response(status, body);

describe("runCycle with the jsearch channel", () => {
  it("stores the postings verbatim, books one request per query, and the pipeline turns them into jobs with the best apply link", async () => {
    const calls: string[] = [];
    const { registry, run } = setup({
      fetch: async (requestUrl) => {
        calls.push(requestUrl);
        return response(200, SEARCH_PAGE);
      },
    });
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(9);

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.map((r) => r.status)).toEqual(Array(9).fill("succeeded"));
    expect(runs[0]).toMatchObject({ channelId: "jsearch", fetched: 4, newCount: 4 });
    // the same four postings come back for every query: stored once
    const raw = await listRawPostingsForChannel(getDb(), "jsearch");
    expect(raw).toHaveLength(4);
    expect(raw[0]?.payloadJson).toMatchObject({ search: { job_title: "Senior AI Engineer (m/w/d)" }, detail: null });
    expect((await getMonthUsage(getDb(), MONTH)).get("jsearch")).toEqual({ records: 9, usd: 0 });

    const pipeline = shippedPipeline();
    const piped = await runPipeline(getDb(), { config: pipeline, registry, logger: quietLogger });
    expect(piped).toMatchObject({ processed: 4, parsed: 3, parseFailed: 1 }); // the record without a title cannot be parsed
    const sources = await getDb().select().from(schema.jobSources);
    expect(sources).toHaveLength(3);
    // JSearch is an aggregator (family google): priority 4, and the apply link prefers the company's own page
    expect(sources.every((s) => s.priority === pipeline.apply_priority.google)).toBe(true);
    // the company's own page is both the listing and the apply target: no separate apply link is stored
    const direct = sources.find((s) => s.url === "https://careers.beispiel-robotics.example/jobs/senior-ai-engineer");
    expect(direct).toMatchObject({ applyUrl: null });
    expect(await listJobSources(getDb(), direct?.jobId ?? 0)).toHaveLength(1);
    // an aggregator listing applies through the best job board among its options
    expect(sources.find((s) => s.url === "https://bebee.example/jobs/llm-engineer-remote-eu-abc")).toMatchObject({ applyUrl: "https://de.linkedin.com/jobs/view/llm-engineer-remote-9876543210" });
  });

  it("without JSEARCH_API_KEY nothing is sent and nothing is booked", async () => {
    const calls: string[] = [];
    const { run } = setup({
      environment: {},
      fetch: async (requestUrl) => {
        calls.push(requestUrl);
        return response(200, SEARCH_PAGE);
      },
    });
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(0);
    expect((await getMonthUsage(getDb(), MONTH)).get("jsearch")).toBeUndefined();
    expect(await listRawPostingsForChannel(getDb(), "jsearch")).toHaveLength(0);
  });

  it("a 429 that says the monthly quota is used up opens the circuit at once; later cycles do not call the API", async () => {
    let calls = 0;
    const { run } = setup({
      fetch: async () => {
        calls += 1;
        return calls <= 2 ? response(200, SEARCH_PAGE) : response(429, QUOTA);
      },
    });
    const first = await run();
    const runs = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(runs.slice(0, 3).map((r) => [r.status, r.errorCode])).toEqual([
      ["succeeded", null],
      ["succeeded", null],
      ["failed", "rate_limited"],
    ]);
    // the other queries of the cycle are skipped, not tried
    expect(runs.slice(3).every((r) => r.status === "skipped")).toBe(true);
    expect(calls).toBe(3);
    expect((await listChannelStates(getDb())).find((c) => c.id === "jsearch")).toMatchObject({ circuitState: "open", consecutiveFailures: 1, lastErrorCode: "rate_limited" });
    // only the two answered requests are booked
    expect((await getMonthUsage(getDb(), MONTH)).get("jsearch")?.records).toBe(2);

    const second = await run();
    expect(calls).toBe(3);
    const secondRuns = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(secondRuns.map((r) => r.status)).toEqual(["skipped"]);
  });

  it("stops sending when the monthly request limit is used up and skips the rest of the cycle and later cycles", async () => {
    let calls = 0;
    const { run } = setup({
      settings: { monthly_request_limit: 4 },
      fetch: async () => {
        calls += 1;
        return response(200, SEARCH_PAGE);
      },
    });
    const first = await run();
    expect(calls).toBe(4);
    const runs = await listRunsForCycle(getDb(), first.cycleId as number);
    // the fifth attempt is refused by the budget (skipped); the rest of the cycle gets one more skipped row
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "skipped", "skipped"]);
    expect(runs[4]).toMatchObject({ errorCode: "budget_exceeded" });
    expect(first.status).toBe("partial");
    expect((await getMonthUsage(getDb(), MONTH)).get("jsearch")).toEqual({ records: 4, usd: 0 });

    await run();
    expect(calls).toBe(4);
    // budget exhaustion is not a failure: the circuit stays closed
    expect((await listChannelStates(getDb())).find((c) => c.id === "jsearch")).toMatchObject({ circuitState: "closed", consecutiveFailures: 0 });
  });

  it("a rejected key (401) is an auth_expired failure", async () => {
    const { run } = setup({ fetch: answer(401, fixture("error-invalid-key-401.json")) });
    const result = await run();
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ status: "failed", errorCode: "auth_expired" });
    expect(runs[0]?.error).toContain("JSEARCH_API_KEY");
  });
});
