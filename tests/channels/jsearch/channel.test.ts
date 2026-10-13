// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BudgetExceededError, ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { ChannelRegistry } from "@/lib/channels/registry";
import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { classifyRateLimit } from "@/lib/channels/jsearch/client";
import { assertRequestsAllowed, pacedAllowance } from "@/lib/channels/jsearch/pace";
import { buildRequests, datePostedFor } from "@/lib/channels/jsearch/query";
import { interleaveRecords } from "@/lib/channels/jsearch";
import { settingsFromConfig } from "@/lib/channels/registry";
import type { RawPostingInput } from "@/lib/channels/types";
import { hashPayload } from "@/lib/db/repos/raw-postings";

import {
  api,
  type Handler,
  fixture,
  harness,
  ID_AGGREGATOR,
  ID_BROKEN,
  ID_DIRECT,
  ID_NO_DESCRIPTION,
  jsearchWith,
  query,
  RECORDS,
  response,
  SEARCH_EMPTY,
  SEARCH_PAGE,
  SEARCH_V2,
  shippedJsearch,
} from "./helpers";

const QUOTA = fixture("error-quota-429.json");
const RATE = fixture("error-rate-429.json");

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("shipped configuration (C8)", () => {
  it("ships jsearch off, with the free RapidAPI plan's request limit and no overage", () => {
    expect(shippedJsearch()).toMatchObject({
      enabled: false,
      monthly_budget_usd: 0,
      api_base_url: "https://jsearch.p.rapidapi.com",
      country: "de",
      pages_per_query: 1,
      keywords_per_query: 1,
      monthly_request_limit: 200,
      overage_cost_per_request_usd: 0,
      pace_requests: true,
      fetch_details: false,
    });
  });

  it("books requests against the monthly request limit", () => {
    expect(settingsFromConfig("jsearch", jsearchWith({ monthly_request_limit: 50 })).freeRecordsPerMonth).toBe(50);
  });

  it("registers with the built-in channels", () => {
    const registry = new ChannelRegistry();
    registerBuiltinChannels(registry);
    expect(registry.get("jsearch")).toMatchObject({ family: "google", kind: "api", usesQueries: true });
  });
});

describe("query building", () => {
  it("maps the look-back window to the smallest date_posted value that covers it", () => {
    expect([10, 24, 25, 72, 100, 168, 169, 800].map(datePostedFor)).toEqual(["today", "today", "3days", "3days", "week", "week", "month", "month"]);
  });

  it("searches `<keyword> in <city>`, the first keywords_per_query of the group", () => {
    expect(buildRequests(query(), { keywords_per_query: 1 }).map((r) => r.query)).toEqual(["AI Engineer in Berlin"]);
    expect(buildRequests(query(), { keywords_per_query: 5 }).map((r) => r.query)).toEqual(["AI Engineer in Berlin", "LLM Engineer in Berlin"]);
  });

  it("remote queries have no city and ask for work-from-home jobs", () => {
    const [request] = buildRequests(query({ location: null, remote: true, remoteScope: "home_country" }), { keywords_per_query: 1 });
    expect(request).toEqual({ query: "AI Engineer", datePosted: "today", remote: true });
  });
});

describe("collect", () => {
  it("without JSEARCH_API_KEY the channel is not configured: no request, no usage, an info line", async () => {
    const h = await harness(api(), { deps: { environment: {} } });
    expect(await h.channel.collect(query(), h.ctx)).toEqual([]);
    expect(h.calls).toHaveLength(0);
    expect(h.budget.attempt.records).toBe(0);
    expect(h.logs.some((l) => l.level === "info" && l.message.includes("not configured"))).toBe(true);
    // a blank key counts as unset
    const blank = await harness(api(), { deps: { environment: { JSEARCH_API_KEY: "  " } } });
    expect(await blank.channel.collect(query(), blank.ctx)).toEqual([]);
    expect(blank.calls).toHaveLength(0);
  });

  it("sends the RapidAPI headers and the documented search parameters", async () => {
    const h = await harness(api());
    await h.channel.collect(query(), h.ctx);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call?.url.origin + call?.url.pathname).toBe("https://jsearch.p.rapidapi.com/search");
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({ query: "AI Engineer in Berlin", page: "1", num_pages: "1", country: "de", date_posted: "today" });
    expect(call?.headers).toMatchObject({ "X-RapidAPI-Key": "test-key-not-real", "X-RapidAPI-Host": "jsearch.p.rapidapi.com" });
  });

  it("adds language, work_from_home and one request per keyword when configured", async () => {
    const h = await harness(api(), { settings: { keywords_per_query: 2, language: "en", pages_per_query: 2 } });
    await h.channel.collect(query({ location: null, remote: true, remoteScope: "home_country" }), h.ctx);
    expect(h.calls.map((c) => c.url.searchParams.get("query"))).toEqual(["AI Engineer", "LLM Engineer"]);
    for (const call of h.calls) {
      expect(call.url.searchParams.get("work_from_home")).toBe("true");
      expect(call.url.searchParams.get("language")).toBe("en");
      expect(call.url.searchParams.get("num_pages")).toBe("2");
    }
    // 2 keywords x 2 pages = 4 requests booked
    expect(h.budget.attempt.records).toBe(4);
  });

  it("keeps every posting verbatim, drops what has no id, and cleans the link tracking", async () => {
    const h = await harness(api());
    const postings = await h.channel.collect(query(), h.ctx);
    expect(postings.map((p) => p.externalId)).toEqual([ID_DIRECT, ID_AGGREGATOR, ID_NO_DESCRIPTION, ID_BROKEN]);
    expect(postings[0]).toMatchObject({
      url: "https://careers.beispiel-robotics.example/jobs/senior-ai-engineer",
      payload: { search: RECORDS[0], detail: null },
    });
    expect(postings[0]?.postedAt?.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    // the malformed record is kept as delivered; the pipeline flags it when parsing
    expect(postings[3]?.payload).toEqual({ search: RECORDS[3], detail: null });
    expect(h.logs.every((l) => !JSON.stringify(l).includes("test-key-not-real"))).toBe(true);
  });

  it("books one request per page against the budget, and only after the answer arrived", async () => {
    const h = await harness(api());
    await h.channel.collect(query(), h.ctx);
    expect(h.budget.attempt).toEqual({ records: 1, usd: 0 });
    expect(h.usage.rows.get("jsearch")).toEqual({ records: 1, usd: 0 });

    const failing = await harness(() => response(500, "boom"));
    await rejection(failing.channel.collect(query(), failing.ctx));
    expect(failing.usage.rows.get("jsearch")).toBeUndefined();
  });

  it("caps the result at the query's maxResults and merges keyword results without duplicates", async () => {
    const h = await harness(api(), { settings: { keywords_per_query: 2 } });
    const postings = await h.channel.collect(query({ maxResults: 3 }), h.ctx);
    expect(postings.map((p) => p.externalId)).toEqual([ID_DIRECT, ID_AGGREGATOR, ID_NO_DESCRIPTION]);
    expect(interleaveRecords([[{ job_id: "a" }, { job_id: "b" }], [{ job_id: "b" }, { job_id: "c" }]], 10).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(interleaveRecords([[{ job_id: "a" }, { job_id: "b" }, { job_id: "c" }]], 2).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("accepts the /search-v2 envelope (data.jobs) and an empty answer", async () => {
    const v2 = await harness(api({ page: SEARCH_V2 }));
    const [posting] = await v2.channel.collect(query(), v2.ctx);
    expect(posting?.externalId).toMatch(/^b1Y2R05LU3ll/);
    const empty = await harness(api({ page: SEARCH_EMPTY }));
    expect(await empty.channel.collect(query(), empty.ctx)).toEqual([]);
    expect(empty.budget.attempt.records).toBe(1); // an empty answer is still a request
  });

  it("fetches /job-details only for postings without a description (one batched call), and attaches the record", async () => {
    const h = await harness(api(), { settings: { fetch_details: true } });
    const postings = await h.channel.collect(query(), h.ctx);
    const detailCalls = h.calls.filter((c) => c.url.pathname === "/job-details");
    expect(detailCalls).toHaveLength(1);
    // the malformed record has no description either; the two ids go in one call
    expect(detailCalls[0]?.url.searchParams.get("job_id")).toBe(`${ID_NO_DESCRIPTION},${ID_BROKEN}`);
    expect(detailCalls[0]?.url.searchParams.get("country")).toBe("de");
    const withDetail = postings.find((p) => p.externalId === ID_NO_DESCRIPTION);
    expect((withDetail?.payload as { detail: { job_description: string } }).detail.job_description).toContain("Tafel AI");
    expect(postings.find((p) => p.externalId === ID_DIRECT)?.payload).toMatchObject({ detail: null });
    expect(postings.find((p) => p.externalId === ID_BROKEN)?.payload).toMatchObject({ detail: null });
    // 1 search + 2 detail ids (every id of a batch counts as a request)
    expect(h.budget.attempt.records).toBe(3);
  });

  it("respects max_details_per_query and does no lookup when fetch_details is off", async () => {
    const off = await harness(api());
    await off.channel.collect(query(), off.ctx);
    expect(off.calls.filter((c) => c.url.pathname === "/job-details")).toHaveLength(0);
    const none = await harness(api(), { settings: { fetch_details: true, max_details_per_query: 0 } });
    await none.channel.collect(query(), none.ctx);
    expect(none.calls.filter((c) => c.url.pathname === "/job-details")).toHaveLength(0);
  });

  it("keeps the search results when the details lookup fails", async () => {
    const h = await harness(({ url }) => (url.pathname === "/search" ? response(200, SEARCH_PAGE) : response(500, "down")), { settings: { fetch_details: true } });
    const postings = await h.channel.collect(query(), h.ctx);
    expect(postings).toHaveLength(4);
    expect(h.logs.some((l) => l.level === "warn" && l.message.includes("details unavailable"))).toBe(true);
    expect(h.budget.attempt.records).toBe(1);
  });
});

describe("usage: monthly request limit, overage and pacing", () => {
  it("stops before sending when the monthly limit is used up and no overage is priced", async () => {
    const h = await harness(api(), { usage: { jsearch: { records: 200, usd: 0 } } });
    const error = await rejection(h.channel.collect(query(), h.ctx));
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).code).toBe("budget_exceeded");
    expect(h.calls).toHaveLength(0);
  });

  it("goes on past the limit when an overage price is set and the monthly budget covers it", async () => {
    const h = await harness(api(), { usage: { jsearch: { records: 200, usd: 0 } }, settings: { monthly_budget_usd: 0.006, overage_cost_per_request_usd: 0.003 } });
    expect(await h.channel.collect(query(), h.ctx)).toHaveLength(4);
    expect(h.budget.attempt.usd).toBeCloseTo(0.003, 6);
    expect(h.usage.rows.get("jsearch")?.usd).toBeCloseTo(0.003, 6);
    // the budget is now at 0.003 of 0.006: a second request fits, a third does not
    await h.channel.collect(query(), h.ctx);
    await expect(h.channel.collect(query(), h.ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(h.calls).toHaveLength(2);
  });

  it("an overage price with no budget behind it sends nothing", async () => {
    const h = await harness(api(), { usage: { jsearch: { records: 200, usd: 0 } }, settings: { monthly_budget_usd: 0, overage_cost_per_request_usd: 0.003 } });
    await expect(h.channel.collect(query(), h.ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(h.calls).toHaveLength(0);
  });

  it("paces the limit over the month: on 7 October 46 of 200 requests are available", async () => {
    expect(pacedAllowance(200, new Date("2026-10-07T08:00:00Z"), "2026-10")).toBe(46);
    expect(pacedAllowance(200, new Date("2026-10-01T00:00:00Z"), "2026-10")).toBe(7);
    expect(pacedAllowance(200, new Date("2026-10-31T23:00:00Z"), "2026-10")).toBe(200);
    // the budget month and the clock disagree (time zone edge): no pacing
    expect(pacedAllowance(200, new Date("2026-11-01T00:30:00Z"), "2026-10")).toBe(200);

    const within = await harness(api(), { usage: { jsearch: { records: 45, usd: 0 } } });
    expect(await within.channel.collect(query(), within.ctx)).toHaveLength(4);
    const over = await harness(api(), { usage: { jsearch: { records: 46, usd: 0 } } });
    await expect(over.channel.collect(query(), over.ctx)).rejects.toThrow(/paced share/);
    expect(over.calls).toHaveLength(0);
    // pacing off: the whole limit is available at once
    const unpaced = await harness(api(), { usage: { jsearch: { records: 46, usd: 0 } }, settings: { pace_requests: false } });
    expect(await unpaced.channel.collect(query(), unpaced.ctx)).toHaveLength(4);
  });

  it("assertRequestsAllowed checks the whole batch, not just the next request", async () => {
    const h = await harness(api(), { usage: { jsearch: { records: 198, usd: 0 } }, settings: { pace_requests: false } });
    const settings = { ...shippedJsearch(), pace_requests: false };
    expect(() => assertRequestsAllowed(h.budget, settings, 2, new Date())).not.toThrow();
    expect(() => assertRequestsAllowed(h.budget, settings, 3, new Date())).toThrow(BudgetExceededError);
  });
});

describe("failures", () => {
  it("a used-up monthly quota (429) is not retried and opens the circuit by itself", async () => {
    const h = await harness(() => response(429, QUOTA), { settings: { rate_limit_retries: 3 } });
    const error = (await rejection(h.channel.collect(query(), h.ctx))) as ChannelError;
    expect(error).toMatchObject({ code: "rate_limited", retryable: false, tripsCircuit: true, status: 429 });
    expect(h.calls).toHaveLength(1);
    expect(error.message).not.toContain("rapidapi.com"); // the response body is not copied into the error
    expect(h.usage.rows.get("jsearch")).toBeUndefined();
  });

  it("recognises quota answers by the remaining-requests header too", async () => {
    const h = await harness(() => response(429, "", { "X-RateLimit-Requests-Remaining": "0" }));
    expect(await rejection(h.channel.collect(query(), h.ctx))).toMatchObject({ code: "rate_limited", tripsCircuit: true });
  });

  it("a per-second rate limit (429) is retried after a throttle delay and then succeeds", async () => {
    const h = await harness((_call, n) => (n < 2 ? response(429, RATE) : response(200, SEARCH_PAGE)), { settings: { rate_limit_retries: 2 } });
    expect(await h.channel.collect(query(), h.ctx)).toHaveLength(4);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.budget.attempt.records).toBe(1); // only the answered request is booked
  });

  it("gives up after rate_limit_retries and reports a retryable rate_limited error that does not trip the circuit", async () => {
    const h = await harness(() => response(429, RATE), { settings: { rate_limit_retries: 1 } });
    const error = (await rejection(h.channel.collect(query(), h.ctx))) as ChannelError;
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, tripsCircuit: false });
    expect(h.calls).toHaveLength(2);
  });

  it("an hourly or daily limit is not retried and does not trip the circuit", async () => {
    expect(classifyRateLimit("You have exceeded the hourly rate limit", null)).toBe("window");
    const h = await harness(() => response(429, { message: "Daily limit reached" }));
    expect(await rejection(h.channel.collect(query(), h.ctx))).toMatchObject({ code: "rate_limited", retryable: false, tripsCircuit: false });
    expect(h.calls).toHaveLength(1);
  });

  it("classifies 429 bodies", () => {
    expect(classifyRateLimit(JSON.stringify(QUOTA), null)).toBe("quota");
    expect(classifyRateLimit(JSON.stringify(RATE), null)).toBe("burst");
    expect(classifyRateLimit("", "0")).toBe("quota");
    expect(classifyRateLimit("", "12")).toBe("burst");
  });

  it("401 and 403 are credential problems (auth_expired), not retried", async () => {
    for (const [status, file] of [
      [401, "error-invalid-key-401.json"],
      [403, "error-not-subscribed-403.json"],
    ] as const) {
      const h = await harness(() => response(status, fixture(file)));
      const error = (await rejection(h.channel.collect(query(), h.ctx))) as ChannelError;
      expect(error).toMatchObject({ code: "auth_expired", retryable: false, tripsCircuit: false });
      expect(error.message).toContain("JSEARCH_API_KEY");
      expect(error.message).not.toContain("test-key-not-real");
      expect(h.calls).toHaveLength(1);
    }
  });

  it("5xx answers are retried by the http client and arrive as network errors", async () => {
    const h = await harness(() => response(503, "unavailable"));
    expect(await rejection(h.channel.collect(query(), h.ctx))).toMatchObject({ code: "network", retryable: true });
  });

  it("rejects answers that are not JSON, not the expected shape, or not status OK", async () => {
    const notJson = await harness(() => response(200, "<html>"));
    expect(await rejection(notJson.channel.collect(query(), notJson.ctx))).toMatchObject({ code: "parse" });
    const wrongShape = await harness(() => response(200, { status: "OK", data: "nope" }));
    expect(await rejection(wrongShape.channel.collect(query(), wrongShape.ctx))).toMatchObject({ code: "parse" });
    const errorStatus = await harness(() => response(200, { status: "ERROR", error: { message: "bad" }, data: [] }));
    expect(await rejection(errorStatus.channel.collect(query(), errorStatus.ctx))).toMatchObject({ code: "unknown", retryable: false });
  });

  it("an invalid sources.yaml block is a non-retryable error", async () => {
    const h = await harness(api());
    const broken = { ...h.ctx, settings: { ...h.ctx.settings, extra: { enabled: true } } };
    expect(await rejection(h.channel.collect(query(), broken))).toMatchObject({ code: "unknown", retryable: false });
  });
});

describe("jsearch: the RapidAPI key goes only to the JSearch host", () => {
  it("refuses a changed api_base_url without the opt-in, before any request", async () => {
    const h = await harness(api(), { settings: { api_base_url: "https://jsearch-proxy.example" } });
    const error = await rejection(h.channel.collect(query(), h.ctx));
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).retryable).toBe(false);
    expect((error as ChannelError).message).toContain("JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1");
    expect(h.calls).toHaveLength(0);
  });

  it("uses it with JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1 (and warns)", async () => {
    const h = await harness(api(), { settings: { api_base_url: "https://jsearch-proxy.example" }, deps: { environment: { JSEARCH_API_KEY: "test-key-not-real", JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" } } });
    await h.channel.collect(query(), h.ctx).catch(() => undefined);
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls[0]?.url.host).toBe("jsearch-proxy.example");
    expect(h.logs.some((l) => l.level === "warn" && l.message === "jsearch: custom API endpoint")).toBe(true);
  });
});

// ---- a query that fails or stops after some of its requests: what was read is kept

async function partial(promise: Promise<unknown>): Promise<PartialCollectError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(PartialCollectError);
  return error as PartialCollectError;
}

/** The first request is answered as `api()` does, every later search fails with `later`. */
function laterSearchFails(later: () => ReturnType<typeof response> | Error): Handler {
  return (call, n) => (call.url.pathname === "/search" && n >= 1 ? later() : api()(call, n));
}

const IDS = [ID_DIRECT, ID_AGGREGATOR, ID_NO_DESCRIPTION, ID_BROKEN];

describe("a later keyword whose request fails", () => {
  it("keeps the first keyword's postings as an interruption with the original failure, and asks for no details", async () => {
    const h = await harness(laterSearchFails(() => response(503, "unavailable")), { settings: { keywords_per_query: 2, fetch_details: true } });
    const error = await partial(h.channel.collect(query(), h.ctx));
    expect(error.planned).toBeFalsy();
    expect(error.cause).toMatchObject({ code: "network", retryable: true });
    expect(error.postings.map((p) => p.externalId)).toEqual(IDS);
    expect(h.calls.map((c) => c.url.pathname)).toEqual(["/search", "/search"]);
    // only the answered request is booked
    expect(h.budget.attempt.records).toBe(1);
    expect(h.usage.rows.get("jsearch")).toEqual({ records: 1, usd: 0 });
  });

  it("carries the flags of each kind of 429 to the cause", async () => {
    const quota = await harness(laterSearchFails(() => response(429, QUOTA)), { settings: { keywords_per_query: 2, rate_limit_retries: 3 } });
    const quotaError = await partial(quota.channel.collect(query(), quota.ctx));
    expect(quotaError.cause).toMatchObject({ code: "rate_limited", retryable: false, tripsCircuit: true, status: 429 });
    expect(quotaError.postings).toHaveLength(4);
    expect(quota.calls).toHaveLength(2);

    const window = await harness(laterSearchFails(() => response(429, { message: "Daily limit reached" })), { settings: { keywords_per_query: 2, rate_limit_retries: 3 } });
    const windowError = await partial(window.channel.collect(query(), window.ctx));
    expect(windowError.cause).toMatchObject({ code: "rate_limited", retryable: false, tripsCircuit: false });
    expect(window.calls).toHaveLength(2);

    const burst = await harness(laterSearchFails(() => response(429, RATE)), { settings: { keywords_per_query: 2, rate_limit_retries: 1 } });
    const burstError = await partial(burst.channel.collect(query(), burst.ctx));
    expect(burstError.cause).toMatchObject({ code: "rate_limited", retryable: true, tripsCircuit: false });
    // the first request, then the failing one and its one retry
    expect(burst.calls).toHaveLength(3);
    expect(burstError.postings).toHaveLength(4);
  });

  it("throws the original failure when the first keyword fails, or when nothing was read before the failure", async () => {
    const first = await harness(() => response(503, "unavailable"), { settings: { keywords_per_query: 2 } });
    const firstError = await rejection(first.channel.collect(query(), first.ctx));
    expect(firstError).toBeInstanceOf(ChannelError);
    expect(firstError).toMatchObject({ code: "network" });

    const empty = await harness((call, n) => (n === 0 ? response(200, SEARCH_EMPTY) : response(503, "unavailable")), { settings: { keywords_per_query: 2 } });
    const emptyError = await rejection(empty.channel.collect(query(), empty.ctx));
    expect(emptyError).not.toBeInstanceOf(PartialCollectError);
    expect(emptyError).toMatchObject({ code: "network" });
  });

  it("does not wrap a cancellation", async () => {
    // the cycle is cancelled while the first keyword's request is in flight; the second keyword starts with a cancelled signal
    const cancelling: { h?: Awaited<ReturnType<typeof harness>> } = {};
    cancelling.h = await harness(
      (call, n) => {
        cancelling.h?.abort();
        return api()(call, n);
      },
      { settings: { keywords_per_query: 2 } },
    );
    const { h } = cancelling;
    const error = await rejection(h.channel.collect(query(), h.ctx));
    expect(error).not.toBeInstanceOf(PartialCollectError);
    expect((error as Error).name).toMatch(/AbortError|TimeoutError/);
  });
});

describe("a later keyword the plan does not allow before its request (planned stop)", () => {
  const usage = { jsearch: { records: 45, usd: 0 } };

  it("keeps the first keyword's postings as a planned budget stop, with no second request and a log line", async () => {
    const h = await harness(api(), { usage, settings: { keywords_per_query: 2 } });
    const error = await partial(h.channel.collect(query(), h.ctx));
    expect(error.planned).toBe(true);
    expect(error.cause).toBeInstanceOf(BudgetExceededError);
    expect(error.postings.map((p) => p.externalId)).toEqual(IDS);
    expect(h.calls).toHaveLength(1);
    expect(h.logs.some((l) => l.level === "info" && l.message === "jsearch budget reached mid-query")).toBe(true);
    expect(h.usage.rows.get("jsearch")).toEqual({ records: 46, usd: 0 });
  });

  it("is still a plain budget refusal when the first keyword is refused, or when nothing was read before the refusal", async () => {
    const first = await harness(api(), { usage: { jsearch: { records: 46, usd: 0 } }, settings: { keywords_per_query: 2 } });
    const firstError = await rejection(first.channel.collect(query(), first.ctx));
    expect(firstError).toBeInstanceOf(BudgetExceededError);
    expect(first.calls).toHaveLength(0);

    const empty = await harness(api({ page: SEARCH_EMPTY }), { usage, settings: { keywords_per_query: 2 } });
    const emptyError = await rejection(empty.channel.collect(query(), empty.ctx));
    expect(emptyError).toBeInstanceOf(BudgetExceededError);
    expect(emptyError).not.toBeInstanceOf(PartialCollectError);
  });
});

// ---- details already stored are not replaced by none

const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  job_id: id,
  job_title: `Role ${id}`,
  employer_name: "Acme GmbH",
  job_description: null,
  job_city: "Hamburg",
  job_location: "Hamburg, Germany",
  job_country: "DE",
  ...extra,
});
const pageOf = (...records: unknown[]) => ({ status: "OK", data: records });
const detailRecord = (id: string, description: string | null, extra: Record<string, unknown> = {}) => ({ ...rec(id, { job_description: description }), ...extra });
const storedPayload = (id: string, description: string | null) => ({ search: rec(id), detail: detailRecord(id, description) });
const OLD = "Old description, as stored weeks ago.";

/** `/search` answers `page`; `/job-details` answers with `details(ids)` (default: nothing found). */
function routes(page: unknown, details: (ids: string[]) => ReturnType<typeof response> = () => response(200, pageOf())): Handler {
  return ({ url }) => (url.pathname === "/search" ? response(200, page) : details((url.searchParams.get("job_id") ?? "").split(",")));
}
const detailsOf = (build: (id: string) => unknown) => (ids: string[]) => response(200, pageOf(...ids.map(build)));
const payloadOf = (postings: readonly RawPostingInput[], id: string) => postings.find((p) => p.externalId === id)?.payload as Record<string, unknown>;

describe("a stored detail keeps the description of a posting the search left without one", () => {
  const known = new Map([["a", storedPayload("a", OLD)]]);
  const expected = { search: rec("a"), detail: detailRecord("a", OLD), detail_source: "stored" };

  it("after a later keyword's request failed (no detail request goes out)", async () => {
    const h = await harness((call, n) => (call.url.pathname === "/search" && n >= 1 ? response(503, "unavailable") : routes(pageOf(rec("a")))(call, n)), {
      settings: { keywords_per_query: 2, fetch_details: true },
      known,
    });
    const error = await partial(h.channel.collect(query(), h.ctx));
    expect(h.calls.map((c) => c.url.pathname)).toEqual(["/search", "/search"]);
    expect(payloadOf(error.postings, "a")).toEqual(expected);
  });

  it("after a planned stop whose detail request is refused as well", async () => {
    const h = await harness(routes(pageOf(rec("a"))), { usage: { jsearch: { records: 45, usd: 0 } }, settings: { keywords_per_query: 2, fetch_details: true }, known });
    const error = await partial(h.channel.collect(query(), h.ctx));
    expect(error.planned).toBe(true);
    expect(h.calls.map((c) => c.url.pathname)).toEqual(["/search"]);
    expect(payloadOf(error.postings, "a")).toEqual(expected);
  });

  it("after the detail request failed", async () => {
    const h = await harness(routes(pageOf(rec("a")), () => response(503, "unavailable")), { settings: { fetch_details: true }, known });
    const postings = await h.channel.collect(query(), h.ctx);
    expect(h.calls.map((c) => c.url.pathname)).toEqual(["/search", "/job-details"]);
    expect(payloadOf(postings, "a")).toEqual(expected);
  });

  it("when it is beyond max_details_per_query", async () => {
    const h = await harness(routes(pageOf(rec("fresh"), rec("a")), detailsOf((id) => detailRecord(id, "Fresh description."))), {
      settings: { fetch_details: true, max_details_per_query: 1 },
      known,
    });
    const postings = await h.channel.collect(query(), h.ctx);
    expect(h.calls.find((c) => c.url.pathname === "/job-details")?.url.searchParams.get("job_id")).toBe("fresh");
    expect(payloadOf(postings, "a")).toEqual(expected);
    expect(payloadOf(postings, "fresh")).toEqual({ search: rec("fresh"), detail: detailRecord("fresh", "Fresh description.") });
  });

  it("when fetch_details is off (nothing is requested, the store is still read)", async () => {
    const h = await harness(routes(pageOf(rec("a"))), { settings: { fetch_details: false }, known });
    const postings = await h.channel.collect(query(), h.ctx);
    expect(h.calls.map((c) => c.url.pathname)).toEqual(["/search"]);
    expect(payloadOf(postings, "a")).toEqual(expected);
  });

  it("a freshly fetched detail with a description replaces it, and no marker is written", async () => {
    const h = await harness(routes(pageOf(rec("a")), detailsOf((id) => detailRecord(id, "Fresh description."))), { settings: { fetch_details: true }, known });
    const postings = await h.channel.collect(query(), h.ctx);
    const payload = payloadOf(postings, "a");
    expect(payload).toEqual({ search: rec("a"), detail: detailRecord("a", "Fresh description.") });
    expect("detail_source" in payload).toBe(false);
  });

  it("nothing stored and no detail: the detail is null and no marker is written", async () => {
    const h = await harness(routes(pageOf(rec("a"))), { settings: { fetch_details: false } });
    const payload = payloadOf(await h.channel.collect(query(), h.ctx), "a");
    expect(payload).toEqual({ search: rec("a"), detail: null });
    expect("detail_source" in payload).toBe(false);
  });

  it("a search description that is there is never replaced and the stored detail is not even attached", async () => {
    const h = await harness(routes(pageOf(rec("a", { job_description: "Described by the search." }))), { settings: { fetch_details: false }, known });
    const payload = payloadOf(await h.channel.collect(query(), h.ctx), "a");
    expect(payload).toEqual({ search: rec("a", { job_description: "Described by the search." }), detail: null });
  });

  it("a detail that came back with an empty description does not displace the stored one", async () => {
    const withStored = await harness(routes(pageOf(rec("a")), detailsOf((id) => detailRecord(id, ""))), { settings: { fetch_details: true }, known });
    expect(payloadOf(await withStored.channel.collect(query(), withStored.ctx), "a")).toEqual(expected);

    const alone = await harness(routes(pageOf(rec("a")), detailsOf((id) => detailRecord(id, ""))), { settings: { fetch_details: true } });
    const payload = payloadOf(await alone.channel.collect(query(), alone.ctx), "a");
    expect(payload).toEqual({ search: rec("a"), detail: detailRecord("a", "") });
    expect("detail_source" in payload).toBe(false);
  });

  it.each([
    ["has no description key", undefined],
    ["has a null description", null],
    ["has an empty description", ""],
    ["has a blank description", "  \t "],
  ])("a stored detail that %s is not reused: the detail is null and no marker is written", async (_name, description) => {
    const stored = storedPayload("a", description ?? null);
    if (description === undefined) delete (stored.detail as Record<string, unknown>).job_description;
    const h = await harness(routes(pageOf(rec("a"))), { settings: { fetch_details: false }, known: new Map([["a", stored]]) });
    const payload = payloadOf(await h.channel.collect(query(), h.ctx), "a");
    expect(payload).toEqual({ search: rec("a"), detail: null });
    expect("detail_source" in payload).toBe(false);
  });

  it.each([
    ["has no description key", undefined],
    ["has a null description", null],
    ["has an empty description", ""],
    ["has a blank description", "  \t "],
  ])("a search record that %s is a missing description: the stored one is used", async (_name, description) => {
    const search = rec("a");
    if (description === undefined) delete (search as Record<string, unknown>).job_description;
    else search.job_description = description as null;
    const h = await harness(routes(pageOf(search)), { settings: { fetch_details: false }, known });
    const payload = payloadOf(await h.channel.collect(query(), h.ctx), "a");
    expect(payload).toEqual({ search, detail: detailRecord("a", OLD), detail_source: "stored" });
  });

  it("asks for the details of exactly the postings it treats as missing (the same judgement)", async () => {
    const blank = [rec("none"), rec("null", { job_description: null }), rec("empty", { job_description: "" }), rec("blank", { job_description: "  " })];
    delete (blank[0] as Record<string, unknown>).job_description;
    const h = await harness(routes(pageOf(...blank, rec("full", { job_description: "Here." }))), { settings: { fetch_details: true } });
    await h.channel.collect(query(), h.ctx);
    expect(h.calls.find((c) => c.url.pathname === "/job-details")?.url.searchParams.get("job_id")).toBe("none,null,empty,blank");
  });

  it("repeated reuse gives the same payload and hash; a freshly fetched detail changes it", async () => {
    const run = async (stored: unknown, fresh: boolean) => {
      const h = await harness(routes(pageOf(rec("a")), fresh ? detailsOf((id) => detailRecord(id, "Fresh description.")) : undefined), {
        settings: { fetch_details: fresh },
        known: new Map([["a", stored]]),
      });
      return payloadOf(await h.channel.collect(query(), h.ctx), "a");
    };
    const first = await run(storedPayload("a", OLD), false);
    const second = await run(first, false);
    expect(second).toEqual(first);
    expect(hashPayload(second)).toBe(hashPayload(first));
    const third = await run(second, true);
    expect("detail_source" in third).toBe(false);
    expect(hashPayload(third)).not.toBe(hashPayload(first));
    // and back to the stored description of the fresh detail
    const fourth = await run(third, false);
    expect(fourth).toMatchObject({ detail: third.detail, detail_source: "stored" });
  });
});

describe("what the search paid for is booked in full, and bookkeeping errors are not swallowed", () => {
  /** The free requests are used up, an overage is priced and the budgets have room at the time of the check. */
  const paid = { usage: { jsearch: { records: 200, usd: 0 } }, settings: { monthly_budget_usd: 1, overage_cost_per_request_usd: 0.003, pace_requests: false } } as const;

  it("a search that was answered while another unit used up the global cap is kept and booked", async () => {
    const run: { h?: Awaited<ReturnType<typeof harness>> } = {};
    run.h = await harness(
      (call, n) => {
        // the competing unit's usage is in the books before this answer is looked at
        if (n === 0) void run.h?.spendElsewhere(0.004);
        return api()(call, n);
      },
      { ...paid, settings: { ...paid.settings, keywords_per_query: 2 }, paidCapUsd: 0.004 },
    );
    const { h } = run;
    const error = await partial(h.channel.collect(query(), h.ctx));
    expect(error.postings).toHaveLength(4);
    // the next keyword is refused before its request: a planned stop
    expect(error.planned).toBe(true);
    expect(h.usage.rows.get("jsearch")).toEqual({ records: 201, usd: 0.003 });
  });

  it("a detail batch that was answered while another unit used up the global cap is kept and booked", async () => {
    const run: { h?: Awaited<ReturnType<typeof harness>> } = {};
    run.h = await harness(
      (call, n) => {
        if (call.url.pathname === "/job-details") void run.h?.spendElsewhere(0.007);
        return api()(call, n);
      },
      { ...paid, settings: { ...paid.settings, fetch_details: true }, paidCapUsd: 0.01 },
    );
    const { h } = run;
    const postings = await h.channel.collect(query(), h.ctx);
    expect(payloadOf(postings, ID_NO_DESCRIPTION).detail).toMatchObject({ job_id: ID_NO_DESCRIPTION });
    // 1 search + the 2 ids of the details batch
    expect(h.usage.rows.get("jsearch")?.records).toBe(203);
    expect(h.usage.rows.get("jsearch")?.usd).toBeCloseTo(0.009, 6);
  });

  it("an error of the usage store while booking the search propagates as it is", async () => {
    const failing = { loadUsage: async () => new Map(), addUsage: async () => Promise.reject(new Error("usage store down")) };
    const h = await harness(api(), { usageStore: failing });
    const error = await rejection(h.channel.collect(query(), h.ctx));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChannelError);
    expect((error as Error).message).toBe("usage store down");
  });

  it("an error of the usage store while booking the details propagates as it is (it is not 'details unavailable')", async () => {
    let writes = 0;
    const failing = {
      loadUsage: async () => new Map(),
      addUsage: async () => {
        writes += 1;
        if (writes === 2) throw new Error("usage store down");
      },
    };
    const h = await harness(api(), { usageStore: failing, settings: { fetch_details: true } });
    const error = await rejection(h.channel.collect(query(), h.ctx));
    expect(error).not.toBeInstanceOf(ChannelError);
    expect((error as Error).message).toBe("usage store down");
    expect(writes).toBe(2);
  });
});
