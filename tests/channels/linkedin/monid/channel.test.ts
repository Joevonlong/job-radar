// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { CascadeController } from "@/lib/channels/cascade";
import { BudgetExceededError, PartialCollectError } from "@/lib/channels/errors";

import jobs from "../../../fixtures/monid/harvestapi-jobs.json";
import { completed, harness, query, response, settings } from "./helpers";

const splitQuery = () => query({ keywords: ["A".repeat(120), "B".repeat(120)] });
const unsettled = (output: unknown[]) => completed({ output, billing: undefined, billedUnits: undefined });

describe("Monid channel accounting", () => {
  it("identifies itself and is not configured without a key", async () => {
    const h = await harness([], { environment: {} });
    expect(h.channel).toMatchObject({ id: "linkedin-monid", family: "linkedin", kind: "paid", usesQueries: true });
    expect(h.channel.isConfigured?.()).toBe(false);
    const attempt = vi.fn(async () => h.channel.collect(query(), h.ctx));
    const cascade = new CascadeController({ family: "linkedin", order: [h.channel.id] }, {
      availability: () => h.channel.isConfigured?.() ? null : "not_configured",
    });
    expect(await cascade.serve(attempt)).toEqual({ status: "skipped", reasons: { "linkedin-monid": "not_configured" }, attempts: [] });
    expect(attempt).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
    expect(h.ctx.budget.snapshot().usd).toBe(0);
  });

  it("recomputes each split run limit from the remaining budget including another flat fee", async () => {
    const h = await harness([
      response(200, completed({ output: [jobs[0]], billedUnits: 3, cost: { value: 0.007, currency: "USD" } })),
      response(200, unsettled(jobs)),
    ], { settings: settings({ monthly_budget_usd: 0.01 }) });
    expect(await h.channel.collect(splitQuery(), h.ctx)).toHaveLength(2);
    expect(h.requests.map((r) => (r.body.input as Record<string, unknown>).maxItems)).toEqual([5, 2]);
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 5, usd: 0.01 });
  });

  it("charges a separate flat fee for each split run", async () => {
    const h = await harness([response(200, unsettled([jobs[0]])), response(200, unsettled([jobs[1]]))]);
    await h.channel.collect(splitQuery(), h.ctx);
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 2, usd: 0.004 });
  });

  it("caps the first run to affordable items and refuses when one item is unaffordable", async () => {
    const h = await harness([response(200, unsettled([]))], { settings: settings({ monthly_budget_usd: 0.003 }) });
    await h.channel.collect(query(), h.ctx);
    expect(h.requests[0]?.body.input).toMatchObject({ maxItems: 2 });
    expect(h.ctx.budget.snapshot().usd).toBe(0.001);
    const none = await harness([], { settings: settings({ monthly_budget_usd: 0.001 }) });
    await expect(none.channel.collect(query(), none.ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(none.requests).toHaveLength(0);
    expect(none.ctx.budget.snapshot().usd).toBe(0);
  });

  it("refuses a result cap that cannot cover one item for each split keyword run", async () => {
    const h = await harness();
    await expect(h.channel.collect({ ...splitQuery(), maxResults: 1 }, h.ctx)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(h.requests).toHaveLength(0);
    expect(h.ctx.budget.snapshot().usd).toBe(0);
  });

  it("uses the smaller global headroom without defaulting to real resources", async () => {
    const h = await harness([], { globalCapUsd: 0.001 });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(h.requests).toHaveLength(0);
  });

  it.each([0, -1])("refuses nonpositive headroom before running even with tiny positive prices: %s", async (usdLeft) => {
    const h = await harness([], { settings: settings({ price_per_1k_usd: 0.0000001, flat_fee_usd: 0 }) });
    const snapshot = h.ctx.budget.snapshot();
    vi.spyOn(h.ctx.budget, "snapshot").mockReturnValue({ ...snapshot, usdLeft });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(h.requests).toHaveLength(0);
    expect(h.ctx.budget.snapshot().usd).toBe(0);
  });

  it("records actual bills even when settlement exceeds the local or global budget", async () => {
    const h = await harness([response(200, completed({ output: jobs, cost: { value: 0.04, currency: "USD" } }))],
      { settings: settings({ monthly_budget_usd: 0.02 }), globalCapUsd: 0.015 });
    const consume = vi.spyOn(h.ctx.budget, "consume");
    expect(await h.channel.collect(query(), h.ctx)).toHaveLength(2);
    expect(consume).toHaveBeenCalledWith(2, { costUsd: 0.04, allowOverspend: true });
    expect(h.ctx.budget.snapshot()).toMatchObject({ usd: 0.04, usdLeft: 0 });
  });

  it("accounts before validating output, including invalid output and provider errors", async () => {
    for (const run of [completed({ output: { unexpected: jobs }, billedUnits: 7 }), completed({ providerResponse: { httpStatus: 500 }, billedUnits: 7 })]) {
      const h = await harness([response(200, run)]);
      await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: run.providerResponse.httpStatus === 500 ? "network" : "parse" });
      expect(h.ctx.budget.snapshot()).toMatchObject({ records: 7, usd: 0.003 });
    }
  });

  it.each([undefined, null, {}, "invalid output"])("charges the limit once before rejecting uncountable successful output: %j", async (output) => {
    const h = await harness([response(200, completed({ output, billing: undefined, billedUnits: undefined }))]);
    const consume = vi.spyOn(h.ctx.budget, "consume");
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ code: "parse", retryable: false });
    expect(consume).toHaveBeenCalledExactlyOnceWith(0, { costUsd: 0.011, allowOverspend: true });
    expect(h.ctx.budget.snapshot().usd).toBe(0.011);
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", fields: { runId: "run_example", limit: 10 } }));
  });

  it("keeps raw counts before dedupe, local date filtering and skipping provider error items", async () => {
    const old = { ...jobs[1], postedDate: "2026-10-24T08:00:00Z" };
    const h = await harness([response(200, unsettled([jobs[0], jobs[0], old, { error: "Fictional provider error" }]))]);
    expect(await h.channel.collect(query({ windowHours: 10 }), h.ctx)).toHaveLength(1);
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 4, usd: 0.005 });
    expect(h.logs).toContainEqual(expect.objectContaining({ message: "monid items skipped", fields: { errorItems: 1, outsideWindow: 1 } }));
  });

  it("keeps date-only postings until their day ends and unknown dates without guessing", async () => {
    const h = await harness([response(200, unsettled([{ ...jobs[0], postedDate: "2026-10-25" }, { ...jobs[1], postedDate: "invalid" }]))]);
    expect(await h.channel.collect(query({ windowHours: 18 }), h.ctx)).toHaveLength(2);
  });

  it("retains malformed and unidentified items verbatim so parsing can fail after persistence", async () => {
    const broken = { ...jobs[0], title: "" };
    const unidentified = { title: "Unidentified role", company: { name: "Example" }, postedDate: "2020-01-01" };
    const h = await harness([response(200, unsettled([broken, unidentified, null]))]);
    const postings = await h.channel.collect(query({ windowHours: 10 }), h.ctx);
    expect(postings).toHaveLength(3);
    expect(postings[0]).toMatchObject({ externalId: "4385163817", payload: broken });
    expect(postings[1]).toMatchObject({ externalId: expect.stringMatching(/^unidentified:[a-f0-9]{64}$/), payload: unidentified });
    expect(postings[2]?.payload).toBeNull();
    for (const posting of postings) expect(() => h.channel.parse(posting.payload)).toThrow(expect.objectContaining({ code: "parse" }));
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 3, usd: 0.004 });
  });

  it("does not infer remote status from a remote query", async () => {
    const h = await harness([response(200, unsettled([{ ...jobs[0], workplaceType: undefined }]))]);
    const postings = await h.channel.collect(query({ remote: true, remoteScope: "worldwide", location: null }), h.ctx);
    expect(h.channel.parse(postings[0]?.payload).workplace).toBe("unknown");
  });

  it.each([
    [{ status: "FAILED" }, 0.011], [{ status: "TIMED_OUT" }, 0.011],
    [{ status: "BLOCKED" }, 0], [{ status: "STOPPED" }, 0],
  ])("estimates terminal %j according to its state", async (run, usd) => {
    const h = await harness([response(200, run)]);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toMatchObject({ retryable: run.status !== "BLOCKED" });
    expect(h.ctx.budget.snapshot().usd).toBe(usd);
  });

  it("logs calculated-only and malformed costs and retains the documented zero settlement", async () => {
    const micro = (value: number) => ({ value, unit: "MICRO_DOLLAR", currency: "USD" });
    for (const [billing, expected, warning] of [
      [{ calculatedCost: micro(4000) }, 0.004, "monid using calculated cost without settled fields"],
      [{ actualCost: { value: 9, unit: "UNKNOWN", currency: "USD" } }, 0.003, "monid cost fields could not be parsed"],
      [{ calculatedCost: "invalid", reportedCost: micro(4000), actualCost: micro(0) }, 0.004, "monid cost fields could not be parsed"],
      [{ calculatedCost: micro(3000), actualCost: micro(0), reportedCost: micro(0) }, 0, null],
    ] as const) {
      const h = await harness([response(200, completed({ billing, output: jobs }))]);
      await h.channel.collect(query(), h.ctx);
      expect(h.ctx.budget.snapshot().usd).toBe(expected);
      if (warning) expect(h.logs.some((l) => l.message === warning)).toBe(true);
    }
  });

  it("treats a completed provider 404 as empty success and preserves explicit zero cost", async () => {
    const h = await harness([response(200, completed({ providerResponse: { httpStatus: 404 }, output: { error: "No matches" }, cost: { value: 0, currency: "USD" }, billing: undefined, billedUnits: 0 }))]);
    expect(await h.channel.collect(query(), h.ctx)).toEqual([]);
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 0, usd: 0 });
  });
});

describe("partial split results", () => {
  it("throws earlier postings and the original failure after recording both runs' charges", async () => {
    const h = await harness([response(200, unsettled([jobs[0]])), response(200, { status: "FAILED", cost: { value: 0.004, currency: "USD" } })]);
    const error: unknown = await h.channel.collect(splitQuery(), h.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialCollectError);
    expect(error).toMatchObject({ planned: false, cause: { code: "network", retryable: true }, postings: [{ externalId: "4385163817" }] });
    expect(h.ctx.budget.snapshot()).toMatchObject({ records: 1, usd: 0.006 });
  });

  it("marks a local budget stop as planned and does not consume a second time", async () => {
    const h = await harness([response(200, unsettled([jobs[0]]))], { settings: settings({ monthly_budget_usd: 0.002 }) });
    const consume = vi.spyOn(h.ctx.budget, "consume");
    await expect(h.channel.collect(splitQuery(), h.ctx)).rejects.toMatchObject({ planned: true, cause: { code: "budget_exceeded" }, postings: [{ externalId: "4385163817" }] });
    expect(consume).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(1);
    expect(h.ctx.budget.snapshot().usd).toBe(0.002);
  });

  it("does not call a remote budget refusal planned, and never bills it twice", async () => {
    const h = await harness([response(200, unsettled([jobs[0]])), response(503, { error: "Wallet inactive" })]);
    const consume = vi.spyOn(h.ctx.budget, "consume");
    await expect(h.channel.collect(splitQuery(), h.ctx)).rejects.toMatchObject({ planned: false, cause: { code: "budget_exceeded" }, postings: [{ externalId: "4385163817" }] });
    expect(consume).toHaveBeenCalledOnce();
    expect(h.ctx.budget.snapshot().usd).toBe(0.002);
  });
});
