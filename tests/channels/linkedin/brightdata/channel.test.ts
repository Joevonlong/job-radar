// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BudgetExceededError, ChannelError } from "@/lib/channels/errors";
import { affordableRecords, keywordStrings, timeRangeFor } from "@/lib/channels/linkedin/brightdata";
import { rawPostingInputSchema } from "@/lib/channels/types";

import { ENV, berlinQuery, brightConfig, fakeProvider, harness, makeChannel } from "./helpers";

const snapshot = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../../fixtures/brightdata/snapshot-berlin.json"), "utf8")) as unknown[];

function brightdata(raw: Record<string, unknown>): Record<string, unknown> {
  const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
  const block = linkedin.brightdata;
  if (!block) throw new Error("no brightdata block");
  return block;
}

describe("channel identity", () => {
  it("is the paid LinkedIn channel with a per-1000 price", () => {
    const channel = makeChannel({ cost: 1.5 });
    expect(channel).toMatchObject({ id: "linkedin-brightdata", family: "linkedin", kind: "paid", usesQueries: true });
    expect(channel.estimateCost?.(1000)).toBeCloseTo(1.5, 9);
    expect(channel.estimateCost?.(2)).toBeCloseTo(0.003, 9);
  });
});

describe("query mapping", () => {
  it("sends one input per query: OR-merged keywords, the city, the country and the 24h range", async () => {
    const provider = fakeProvider({ records: [] });
    const channel = makeChannel();
    const { ctx } = await harness(channel, provider);
    await channel.collect(berlinQuery(), ctx);
    const trigger = provider.requests[0];
    expect(trigger?.body).toEqual([{ location: "Berlin", keyword: '"AI Engineer" OR "LLM Engineer"', country: "DE", time_range: "Past 24 hours" }]);
    expect(trigger?.query.get("limit_per_input")).toBe("10");
    expect(trigger?.query.get("dataset_id")).toBe("gd_lpfll7v5hcqtkxl6l");
  });

  it("maps the remote query to the configured location and the Remote filter", async () => {
    const provider = fakeProvider({ records: [] });
    const channel = makeChannel();
    const { ctx } = await harness(channel, provider);
    await channel.collect(berlinQuery({ location: null, remote: true, remoteScope: { region: ["eu"] } }), ctx);
    expect(provider.requests[0]?.body).toEqual([
      { location: "European Union", keyword: '"AI Engineer" OR "LLM Engineer"', country: "DE", time_range: "Past 24 hours", remote: "Remote" },
    ]);
  });

  it("maps window hours to the provider's discrete ranges (10 h and 24 h both become 'Past 24 hours')", () => {
    expect(timeRangeFor(10)).toEqual({ label: "Past 24 hours", rangeHours: 24 });
    expect(timeRangeFor(24).label).toBe("Past 24 hours");
    expect(timeRangeFor(25).label).toBe("Past week");
    expect(timeRangeFor(168).label).toBe("Past week");
    expect(timeRangeFor(169).label).toBe("Past month");
    expect(timeRangeFor(24 * 31).label).toBeUndefined();
  });

  it("splits a keyword group that does not fit the provider's 200 character limit into several inputs", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Machine Learning Platform Engineer ${i}`);
    const strings = keywordStrings(long);
    expect(strings.length).toBeGreaterThan(1);
    expect(strings.every((s) => s.length <= 200)).toBe(true);
    expect(strings.join(" OR ").split(" OR ")).toHaveLength(12);

    const provider = fakeProvider({ records: [] });
    const channel = makeChannel();
    const { ctx } = await harness(channel, provider);
    await channel.collect(berlinQuery({ keywords: long, maxResults: 20 }), ctx);
    const inputs = provider.requests[0]?.body as unknown[];
    expect(inputs).toHaveLength(strings.length);
    expect(Number(provider.requests[0]?.query.get("limit_per_input"))).toBe(Math.floor(20 / strings.length));
  });

  it("caps limit_per_input at the provider maximum", async () => {
    const provider = fakeProvider({ records: [] });
    const channel = makeChannel();
    const { ctx } = await harness(channel, provider);
    await channel.collect(berlinQuery({ maxResults: 300 }), ctx);
    expect(provider.requests[0]?.query.get("limit_per_input")).toBe("100");
  });
});

describe("collect", () => {
  it("returns every delivered job verbatim, de-duplicated, without provider error records", async () => {
    const provider = fakeProvider({ records: snapshot });
    const channel = makeChannel();
    const { ctx } = await harness(channel, provider);
    const out = await channel.collect(berlinQuery(), ctx);
    expect(out.map((r) => r.externalId)).toEqual(["4385163817", "4385163819", "4385163820", "4385163821"]);
    for (const record of out) expect(rawPostingInputSchema.safeParse(record).success).toBe(true);
    expect(out[0]).toMatchObject({ url: "https://www.linkedin.com/jobs/view/senior-ml-engineer-4385163817?_l=en", payload: snapshot[0] });
    expect(out[0]?.postedAt?.toISOString()).toBe("2026-10-07T06:30:00.000Z");
    expect(out[3]?.postedAt).toBeNull();
    // every delivered job (5, the duplicate included) was billed; the error record was not
    expect(ctx.budget.snapshot().records).toBe(5);
  });

  it("filters locally by posted date when the window is shorter than the provider range", async () => {
    const provider = fakeProvider({ records: snapshot });
    const channel = makeChannel();
    const { ctx } = await harness(channel, provider);
    // now = 08:00; a 10 h window starts at 22:00 the evening before: the 14:00 posting is out, the undated one stays
    const out = await channel.collect(berlinQuery({ windowHours: 10 }), ctx);
    expect(out.map((r) => r.externalId)).toEqual(["4385163817", "4385163819", "4385163821"]);
    expect(provider.requests[0]?.body).toMatchObject([{ time_range: "Past 24 hours" }]);
    expect(ctx.budget.snapshot().records).toBe(5); // filtered-out records were still billed
  });

  it("answers an empty snapshot with no postings and no usage", async () => {
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeProvider({ records: [] }));
    expect(await channel.collect(berlinQuery(), ctx)).toEqual([]);
    expect(ctx.budget.snapshot().records).toBe(0);
  });

  it("is not configured without BRIGHT_DATA_API_KEY, so the cascade skips it instead of calling it", () => {
    expect(makeChannel().isConfigured?.()).toBe(true);
    expect(makeChannel({ environment: {} }).isConfigured?.()).toBe(false);
    expect(makeChannel({ environment: { BRIGHT_DATA_API_KEY: "  " } }).isConfigured?.()).toBe(false);
  });

  it("refuses to run without BRIGHT_DATA_API_KEY and sends nothing", async () => {
    const provider = fakeProvider({ records: snapshot });
    const channel = makeChannel({ environment: {} });
    const { ctx } = await harness(channel, provider);
    await expect(channel.collect(berlinQuery(), ctx)).rejects.toMatchObject({ code: "auth_expired", retryable: false });
    expect(provider.requests).toEqual([]);
  });

  it("reports usage in the log, marks dry runs, and never logs the API key", async () => {
    const channel = makeChannel();
    const live = await harness(channel, fakeProvider({ records: snapshot }));
    await channel.collect(berlinQuery(), live.ctx);
    const dry = await harness(channel, fakeProvider({ records: snapshot }), { cycleId: null });
    await channel.collect(berlinQuery(), dry.ctx);

    const liveDone = live.logs.find((l) => l.message === "bright data snapshot downloaded");
    expect(liveDone?.fields).toMatchObject({ records: 5, providerErrors: 1, freeRecords: 5, paidRecords: 0, usd: 0 });
    expect(liveDone?.fields).not.toHaveProperty("dryRun");
    const dryDone = dry.logs.find((l) => l.message === "bright data snapshot downloaded");
    expect(dryDone?.fields).toMatchObject({ dryRun: true });
    expect(String(dryDone?.fields?.note)).toContain("the provider billed these records");
    expect(JSON.stringify([...live.logs, ...dry.logs])).not.toContain(ENV.BRIGHT_DATA_API_KEY);
  });

  it("raises a channel error for a snapshot that is not an array of records", async () => {
    const channel = makeChannel();
    const { ctx } = await harness(channel, fakeProvider({ records: "<html>" as unknown as unknown[] }));
    await expect(channel.collect(berlinQuery(), ctx)).rejects.toBeInstanceOf(ChannelError);
  });
});

describe("budget", () => {
  const records = (n: number) => Array.from({ length: n }, (_, i) => ({ ...(snapshot[0] as object), job_posting_id: String(1000 + i), url: `https://www.linkedin.com/jobs/view/${1000 + i}` }));

  it("inside the free allowance costs nothing", async () => {
    const channel = makeChannel();
    const h = await harness(channel, fakeProvider({ records: records(10) }), { seed: { records: 100, usd: 0 } });
    await channel.collect(berlinQuery(), h.ctx);
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 110, usd: 0, freeRecordsLeft: 4890 });
  });

  it("using exactly the last free records is still free", async () => {
    const channel = makeChannel();
    const h = await harness(channel, fakeProvider({ records: records(10) }), { seed: { records: 4990, usd: 0 } });
    await channel.collect(berlinQuery(), h.ctx);
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 5000, usd: 0, freeRecordsLeft: 0 });
  });

  it("charges cost_per_1k_usd only for the records beyond the free allowance", async () => {
    const channel = makeChannel({ cost: 1.5 });
    const h = await harness(channel, fakeProvider({ records: records(10) }), { seed: { records: 4995, usd: 0 } });
    await channel.collect(berlinQuery(), h.ctx);
    // 5 free + 5 paid at $1.5 per 1000
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 5005, freeRecordsLeft: 0 });
    expect(h.ctx.budget.snapshot().usd).toBeCloseTo(0.0075, 9);
    const done = h.logs.find((l) => l.message === "bright data snapshot downloaded");
    expect(done?.fields).toMatchObject({ freeRecords: 5, paidRecords: 5 });
  });

  it("asks the provider for no more records than the remaining budget covers", async () => {
    const channel = makeChannel({ cost: 1.5 });
    // free used up, $0.0045 of the channel budget left = 3 records
    const config = brightConfig((raw) => {
      brightdata(raw).monthly_budget_usd = 0.0045;
    });
    const provider = fakeProvider({ records: (limit) => records(limit) });
    const h = await harness(channel, provider, { config, seed: { records: 5000, usd: 0 } });
    expect(affordableRecords(h.ctx.budget.snapshot(), 1.5)).toBe(3);
    await channel.collect(berlinQuery(), h.ctx);
    expect(provider.requests[0]?.query.get("limit_per_input")).toBe("3");
    expect(h.ctx.budget.snapshot().usd).toBeCloseTo(0.0045, 9);
  });

  it("raises BudgetExceeded before any request when nothing is left", async () => {
    const channel = makeChannel();
    const provider = fakeProvider({ records: records(1) });
    const h = await harness(channel, provider, { seed: { records: 5000, usd: 5 } });
    const error = await channel.collect(berlinQuery(), h.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toEqual([]);
  });

  it("a snapshot larger than the budget (provider ignored the limit) is returned and recorded at its actual billed usage", async () => {
    const channel = makeChannel({ cost: 1.5 });
    const config = brightConfig((raw) => {
      brightdata(raw).monthly_budget_usd = 0.003;
    });
    const h = await harness(channel, fakeProvider({ records: records(10) }), { config, seed: { records: 5000, usd: 0 } });
    const out = await channel.collect(berlinQuery(), h.ctx);
    expect(out).toHaveLength(10); // paid for, so kept
    const used = h.ctx.budget.snapshot();
    expect(used.records).toBe(5010);
    expect(used.usd).toBeCloseTo(0.015, 9); // 10 paid records, above the $0.003 budget
    expect(used.usdLeft).toBe(0);
    expect(h.warnings.map((w) => w.message)).toContain("bright data budget exhausted by this snapshot");
    // nothing left for the next query: the cascade must move on
    expect(h.tracker.hasHeadroom(channel)).toBe(false);
  });

  it("billed records the local time window drops still count in usage", async () => {
    const channel = makeChannel();
    const h = await harness(channel, fakeProvider({ records: snapshot }));
    const out = await channel.collect(berlinQuery({ windowHours: 10 }), h.ctx);
    expect(out).toHaveLength(3);
    expect(h.ctx.budget.snapshot().records).toBe(5);
  });

  it("a price of 0 means no paid usage is ever blocked", () => {
    expect(affordableRecords({ freeRecordsLeft: 0, usdLeft: 0 }, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});
