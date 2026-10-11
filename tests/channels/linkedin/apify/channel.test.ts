// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BudgetExceededError, ChannelError } from "@/lib/channels/errors";
import { affordableItems, createApifyChannel, jobIdOfRecord } from "@/lib/channels/linkedin/apify";
import { rawPostingInputSchema } from "@/lib/channels/types";

import { ENV, FIXTURE_ITEMS, apifyConfig, berlinQuery, fakeApify, harness, makeChannel, response } from "./helpers";

const channelRows = (rows: Array<{ externalId: string }>): string[] => rows.map((r) => r.externalId);

describe("channel identity", () => {
  it("is the paid LinkedIn channel with a per-1000 price", () => {
    const channel = makeChannel({ price: 0.4 });
    expect(channel).toMatchObject({ id: "linkedin-apify", family: "linkedin", kind: "paid", usesQueries: true });
    expect(channel.estimateCost?.(1000)).toBeCloseTo(0.4, 9);
    expect(channel.estimateCost?.(5)).toBeCloseTo(0.002, 9);
  });

  it("is configured only with APIFY_TOKEN and (when it is asked) an actor id", () => {
    expect(makeChannel().isConfigured?.()).toBe(true);
    expect(makeChannel({ environment: {} }).isConfigured?.()).toBe(false);
    expect(makeChannel({ environment: { APIFY_TOKEN: "   " } }).isConfigured?.()).toBe(false);
    expect(makeChannel({ actorId: "valig/linkedin-jobs-scraper" }).isConfigured?.()).toBe(true);
    expect(makeChannel({ actorId: "  " }).isConfigured?.()).toBe(false);
  });
});

describe("input generation", () => {
  it("runs the configured actor once per query: OR-merged keywords, city + country, 24h filter, hard caps in the URL", async () => {
    const apify = fakeApify();
    const channel = makeChannel();
    const { ctx } = await harness(channel, apify);
    await channel.collect(berlinQuery(), ctx);

    expect(apify.requests).toHaveLength(1);
    const request = apify.requests[0];
    expect(request).toMatchObject({ method: "POST", path: "/v2/acts/valig~linkedin-jobs-scraper/run-sync-get-dataset-items" });
    expect(request?.body).toEqual({ keywords: '"AI Engineer" OR "LLM Engineer"', location: "Berlin, Germany", datePosted: "r86400", limit: 10 });
    expect(Object.fromEntries(request?.query ?? [])).toEqual({
      format: "json",
      timeout: "300",
      memory: "1024",
      maxItems: "10",
      maxTotalChargeUsd: "10", // the channel's remaining monthly budget
    });
    // the token travels in the Authorization header only, never in the URL
    expect(request?.headers.Authorization).toBe(`Bearer ${ENV.APIFY_TOKEN}`);
    expect(request?.url).not.toContain(ENV.APIFY_TOKEN);
  });

  it("maps the remote query to the configured location and merges remote_input over the template", async () => {
    const apify = fakeApify();
    const channel = makeChannel();
    const { ctx } = await harness(channel, apify);
    await channel.collect(berlinQuery({ location: null, remote: true, remoteScope: { region: ["eu"] } }), ctx);
    expect(apify.requests[0]?.body).toEqual({
      keywords: '"AI Engineer" OR "LLM Engineer"',
      location: "European Union",
      datePosted: "r86400",
      limit: 10,
      urlParam: [{ key: "f_WT", value: "2" }],
    });
  });

  it("maps window hours to the actor's look-back values, and leaves the key out beyond a month", async () => {
    const apify = fakeApify();
    const channel = makeChannel();
    const { ctx } = await harness(channel, apify);
    for (const windowHours of [10, 24, 25, 168, 169, 720, 721]) await channel.collect(berlinQuery({ windowHours }), ctx);
    expect(apify.requests.map((r) => r.body.datePosted)).toEqual(["r86400", "r86400", "r604800", "r604800", "r2592000", "r2592000", undefined]);
  });

  it("follows a changed template: another actor's field names and a numeric limit", async () => {
    const apify = fakeApify();
    const channel = makeChannel();
    const config = apifyConfig((apify_) => {
      apify_.actor_id = "someone/other-actor";
      apify_.input_template = { searchTerms: "{keywords} in {location}", maxItems: "{limit}", fixed: true };
    });
    const { ctx } = await harness(channel, apify, { config });
    await channel.collect(berlinQuery({ maxResults: 7 }), ctx);
    expect(apify.requests[0]?.path).toBe("/v2/acts/someone~other-actor/run-sync-get-dataset-items");
    expect(apify.requests[0]?.body).toEqual({ searchTerms: '"AI Engineer" OR "LLM Engineer" in Berlin, Germany', maxItems: 7, fixed: true });
  });

  it("splits a keyword group that does not fit LinkedIn's keyword field into several runs and shares the limit", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Machine Learning Platform Engineer ${i}`);
    const apify = fakeApify();
    const channel = makeChannel();
    const { ctx } = await harness(channel, apify);
    await channel.collect(berlinQuery({ keywords: long, maxResults: 20 }), ctx);
    const runs = apify.requests;
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.every((r) => String(r.body.keywords).length <= 200)).toBe(true);
    expect(runs.map((r) => r.body.limit)).toEqual(runs.map(() => Math.floor(20 / runs.length)));
  });
});

describe("output", () => {
  it("stores every distinct job by its LinkedIn job id, verbatim, and drops duplicates, error items and records without identity", async () => {
    const apify = fakeApify([response(201, FIXTURE_ITEMS)]);
    const channel = makeChannel();
    const { ctx, logs } = await harness(channel, apify);
    const postings = await channel.collect(berlinQuery(), ctx);

    expect(channelRows(postings)).toEqual(["4385163817", "4385163819", "4385163821", "4385100001"]);
    expect(postings.every((p) => rawPostingInputSchema.safeParse(p).success)).toBe(true);
    expect(postings[0]?.payload).toEqual(FIXTURE_ITEMS[0]); // C1: exactly what the actor delivered
    expect(postings[0]?.url).toBe("https://www.linkedin.com/jobs/view/senior-ml-engineer-at-example-gmbh-4385163817");
    expect(postings[0]?.postedAt?.toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(logs.find((l) => l.message === "apify records not stored")?.fields).toEqual({ outsideWindow: 0, noIdentity: 1 });
  });

  it("applies the local time window to short windows only; a date-only posting day stays valid until its day ends", async () => {
    const apify = fakeApify([response(201, FIXTURE_ITEMS)]);
    const channel = makeChannel();
    const { ctx } = await harness(channel, apify);
    // NOW = 2026-10-07 08:00Z, 10 h window -> cutoff 2026-10-06 22:00Z; the 2026-10-05 posting is out, the 2026-10-06 one still in
    const postings = await channel.collect(berlinQuery({ windowHours: 10 }), ctx);
    expect(channelRows(postings)).toEqual(["4385163817", "4385163819", "4385163821"]);
  });

  it("gives the same external id as the Bright Data channel for the same LinkedIn job", () => {
    const brightdata = { job_posting_id: "4385163817", url: "https://www.linkedin.com/jobs/view/senior-ml-engineer-4385163817?_l=en" };
    expect(jobIdOfRecord(FIXTURE_ITEMS[0] as Record<string, unknown>)).toBe(brightdata.job_posting_id);
    expect(jobIdOfRecord({ url: brightdata.url })).toBe(brightdata.job_posting_id);
    expect(jobIdOfRecord({ id: 4385163819 })).toBe("4385163819");
    expect(jobIdOfRecord({ id: "abc", url: "https://example.com/jobs/1" })).toBeNull();
  });

  it("rejects a response that is not a JSON array of items", async () => {
    for (const body of ["{\"error\": \"x\"}", "not json"]) {
      const channel = makeChannel();
      const { ctx } = await harness(channel, fakeApify([response(201, body)]));
      await expect(channel.collect(berlinQuery(), ctx)).rejects.toMatchObject({ code: "parse" });
    }
  });
});

describe("budget accounting", () => {
  it("records the delivered items plus the run's start fee, billed in full (duplicates and out-of-window ones included)", async () => {
    const apify = fakeApify([response(201, FIXTURE_ITEMS)]);
    const channel = makeChannel();
    const { ctx, tracker } = await harness(channel, apify);
    await channel.collect(berlinQuery({ windowHours: 10 }), ctx);
    // 6 job records (the error item is not a job): 0.001 start + 6 x 0.0004
    const snapshot = ctx.budget.snapshot();
    expect(snapshot.records).toBe(6);
    expect(snapshot.usd).toBeCloseTo(0.0034, 6);
    expect(tracker.globalUsd()).toBeCloseTo(0.0034, 6);
    expect(snapshot.usdLeft).toBeCloseTo(10 - 0.0034, 6);
  });

  it("pays the start fee even for a run that delivers nothing", async () => {
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeApify([response(201, [])]));
    expect(await channel.collect(berlinQuery(), ctx)).toEqual([]);
    expect(ctx.budget.snapshot()).toMatchObject({ records: 0, usd: 0.001 });
  });

  it("sizes the run to what the budget still covers (start fee first) and passes it as the hard cap", async () => {
    const apify = fakeApify();
    const channel = makeChannel();
    const config = apifyConfig((block) => {
      block.monthly_budget_usd = 0.0019;
    });
    const { ctx } = await harness(channel, apify, { config });
    await channel.collect(berlinQuery({ maxResults: 25 }), ctx);
    // (0.0019 - 0.001) / 0.0004 = 2.25 -> 2 items
    expect(apify.requests[0]?.body.limit).toBe(2);
    expect(apify.requests[0]?.query.get("maxItems")).toBe("2");
    expect(apify.requests[0]?.query.get("maxTotalChargeUsd")).toBe("0.0019");
  });

  it("raises budget_exceeded before calling Apify when the month's budget is used up", async () => {
    const apify = fakeApify();
    const channel = makeChannel();
    const { ctx } = await harness(channel, apify, { seed: { records: 25000, usd: 10 } });
    const error = await channel.collect(berlinQuery(), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(apify.requests).toHaveLength(0);
  });

  it("respects the global paid cap, which can be lower than the channel's own budget", async () => {
    const apify = fakeApify();
    const channel = makeChannel();
    const config = apifyConfig((_block, raw) => {
      raw.paid_total_monthly_budget_usd = 15;
    });
    // brightdata already spent 14.999 of the 15 total: not enough for a run + one result
    const { ctx, tracker } = await harness(channel, apify, { config });
    await tracker.forChannel({ ...channel, id: "linkedin-brightdata" }).consume(0, { costUsd: 14.999, allowOverspend: true }).catch(() => {});
    expect(ctx.budget.snapshot().usdLeft).toBeLessThan(0.0014);
    await expect(channel.collect(berlinQuery(), ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(apify.requests).toHaveLength(0);
  });

  it("computes affordable items", () => {
    expect(affordableItems(10, 0.0004, 0.001)).toBe(24997);
    expect(affordableItems(0.001, 0.0004, 0.001)).toBe(0); // the start fee alone eats the budget
    expect(affordableItems(0.0014, 0.0004, 0.001)).toBe(1);
    expect(affordableItems(0, 0, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps what earlier runs delivered when a later run fails, and bills only what ran", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Machine Learning Platform Engineer ${i}`);
    const apify = fakeApify([response(201, [FIXTURE_ITEMS[0]]), response(500, "boom")]);
    const channel = makeChannel();
    const { ctx, warnings } = await harness(channel, apify);
    const postings = await channel.collect(berlinQuery({ keywords: long, maxResults: 20 }), ctx);
    expect(channelRows(postings)).toEqual(["4385163817"]);
    expect(ctx.budget.snapshot()).toMatchObject({ records: 1 });
    expect(warnings.map((w) => w.message)).toContain("apify run failed after earlier runs delivered; keeping those");
  });

  it("marks a dry run in the log (the actor is billed, nothing is persisted)", async () => {
    const channel = makeChannel();
    const { ctx, logs } = await harness(channel, fakeApify([response(201, [FIXTURE_ITEMS[1]])]), { cycleId: null });
    await channel.collect(berlinQuery(), ctx);
    expect(logs.find((l) => l.message === "apify actor run finished")?.fields).toMatchObject({ dryRun: true, items: 1 });
  });
});

describe("failures", () => {
  it("fails with auth_expired (non-retryable) without a token, before any request", async () => {
    const apify = fakeApify();
    const channel = makeChannel({ environment: {} });
    const { ctx } = await harness(channel, apify);
    const error = await channel.collect(berlinQuery(), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "auth_expired", retryable: false });
    expect(apify.requests).toHaveLength(0);
  });

  it("fails non-retryably with an empty actor id", async () => {
    const channel = makeChannel();
    const config = apifyConfig((block) => {
      block.actor_id = "";
    });
    const { ctx } = await harness(channel, fakeApify(), { config });
    await expect(channel.collect(berlinQuery(), ctx)).rejects.toMatchObject({ code: "unknown", retryable: false });
  });

  it.each([
    [402, "budget_exceeded", false],
    [401, "auth_expired", false],
    [403, "blocked", false],
    [400, "unknown", false],
    [404, "unknown", false],
    [408, "network", true],
    [429, "rate_limited", true],
    [500, "network", true],
  ] as const)("classifies HTTP %i as %s and sends the (billable) run only once", async (status, code, retryable) => {
    const apify = fakeApify([response(status, { error: { type: "x", message: "y" } })]);
    const channel = makeChannel();
    const { ctx } = await harness(channel, apify);
    const error = await channel.collect(berlinQuery(), ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, retryable });
    expect(apify.requests).toHaveLength(1);
    expect(ctx.budget.snapshot().usd).toBe(0);
  });

  it("never puts the token into an error message", async () => {
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeApify([response(500, "boom")]));
    const error = (await channel.collect(berlinQuery(), ctx).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(ENV.APIFY_TOKEN);
  });

  it("rejects an incomplete sources.yaml block with a non-retryable error naming the keys", async () => {
    const channel = createApifyChannel({ pricePer1kUsd: () => 0.4, environment: ENV });
    const config = apifyConfig();
    const { ctx } = await harness(channel, fakeApify(), { config });
    const broken = { ...ctx, settings: { ...ctx.settings, extra: { actor_id: "a/b" } } };
    await expect(channel.collect(berlinQuery(), broken)).rejects.toMatchObject({ code: "unknown", retryable: false, message: expect.stringContaining("price_per_1k_usd") });
  });
});
