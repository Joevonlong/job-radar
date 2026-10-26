// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSmartrecruitersChannel, smartrecruitersAdapter } from "@/lib/channels/ats";
import { wrapPosting } from "@/lib/channels/ats/envelope";
import { ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { normalizedPostingDraftSchema, type HttpResponse, type RawPostingInput } from "@/lib/channels/types";

import { atsChannelsWith, atsContext, company, depsWith, fixtureJson, inputs, response, routedFetch } from "./helpers";

const BASE = "https://api.smartrecruiters.com/v1/companies/ExampleLabs/postings";
const LIST_URL = `${BASE}?limit=100&offset=0&country=de`;
const sr = company({ name: "Example Labs", ats: "smartrecruiters", token: "ExampleLabs" });
const list = () => fixtureJson("smartrecruiters-list.json") as { totalFound: number; content: unknown[] };
const detail = (n: number) => fixtureJson(`smartrecruiters-detail-${n}.json`);
const source = { ats: "smartrecruiters", token: "ExampleLabs", companyName: "Example Labs" } as const;
const BOARD_KEY = "smartrecruiters:ExampleLabs";
const PAGE_URL = `${BASE}?limit=2&offset=0&country=de`;
const NEXT_PAGE_URL = `${BASE}?limit=2&offset=2&country=de`;
const otherSr = company({ name: "Other Labs", ats: "smartrecruiters", token: "OtherLabs" });
const OTHER_BASE = "https://api.smartrecruiters.com/v1/companies/OtherLabs/postings";
const OTHER_PAGE_URL = `${OTHER_BASE}?limit=2&offset=0&country=de`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});

afterEach(() => vi.useRealTimers());

function inlineList(ids: string[], token = sr.token) {
  return {
    totalFound: ids.length,
    content: ids.map((id) => ({ id, name: "AI Engineer", company: { identifier: token } })),
  };
}

function channel(companies = [sr]) {
  const deps = depsWith(inputs(companies));
  return { channel: createSmartrecruitersChannel(deps), store: deps.memory };
}

/** Keep the posting assertions while requiring the single-board sweep to report its interruption. */
async function partialPostings(collection: Promise<RawPostingInput[]>): Promise<readonly RawPostingInput[]> {
  try {
    await collection;
  } catch (error) {
    if (!(error instanceof PartialCollectError)) throw error;
    return error.postings;
  }
  return expect.unreachable("expected PartialCollectError");
}

/** sources.yaml with the neutral prefilter plus "AI" as an include term (so "AI Platform Engineer" is kept, "Sales Manager" is not). */
const aiChannels = (edit: (b: Record<string, unknown>) => void = () => {}) =>
  atsChannelsWith("smartrecruiters", (b) => {
    b.title_prefilter = { enabled: true, include_terms: ["AI"], exclude_terms: [] };
    edit(b);
  });

const routes = (listAnswer = response(200, list(), { ETag: 'W/"list-v1"' })) =>
  routedFetch([
    [LIST_URL, listAnswer],
    [`${BASE}/744000000000001`, response(200, detail(1))],
    [`${BASE}/744000000000003`, response(200, detail(3))],
  ]);

const pagedChannels = (pageSize = 2) => aiChannels((b) => {
  b.page_size = pageSize;
  b.country = "de";
  b.fetch_details = true;
});

const firstPage = () => response(200, {
  totalFound: 3,
  content: [list().content[0], list().content[2]],
}, { ETag: 'W/"incomplete-list"' });

const pagedRoutes = (nextPage: HttpResponse) => routedFetch([
  [PAGE_URL, firstPage()],
  [NEXT_PAGE_URL, nextPage],
  [`${BASE}/744000000000001`, response(200, detail(1))],
  [`${BASE}/744000000000003`, response(200, detail(3))],
]);

describe("smartrecruiters sweep", () => {
  it("lists the board, prefilters by title, and fetches the detail of every kept posting", async () => {
    const { fetch, requests } = routes();
    const { ctx, query, logs, sleeps } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();
    const postings = await c.collect(query, ctx);

    // "Sales Manager" is dropped by the title prefilter, so its detail is never requested
    expect(postings.map((p) => p.externalId)).toEqual(["744000000000001", "744000000000003"]);
    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/744000000000001`, `${BASE}/744000000000003`]);
    expect(requests[0]?.headers).not.toHaveProperty("If-None-Match");
    expect(sleeps).toHaveLength(1); // one pause between the two detail requests
    expect(postings[0]?.url).toBe("https://jobs.smartrecruiters.com/ExampleLabs/744000000000001");
    expect(postings[0]?.postedAt).toEqual(new Date("2026-10-01T08:52:15.935Z"));
    expect(logs.filter((l) => l.message === "ats board").map((l) => l.fields)).toEqual([
      { channel: "smartrecruiters", company: "Example Labs", board: "ExampleLabs", outcome: "changed", fetched: 3, kept: 2 },
    ]);
    expect(logs.find((l) => l.message === "ats sweep done")?.fields).not.toHaveProperty("detailFailedBoards");
    // the stored payload is the detail, in the envelope (C1)
    expect(postings[0]?.payload).toEqual({ source, posting: detail(1) });
    for (const p of postings) expect(normalizedPostingDraftSchema.parse(c.parse(p.payload)).companyName).toBe("Example Labs");
    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", completeRead: true, detailRetryIds: [] });
  });

  it("filters by the configured country, and an empty country asks for every country", async () => {
    const all = aiChannels((b) => {
      b.country = "";
      b.page_size = 50;
    });
    const { fetch, requests } = routedFetch([[`${BASE}?limit=50&offset=0`, response(200, { totalFound: 0, content: [] })]]);
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels: all });
    expect(await channel().channel.collect(query, ctx)).toEqual([]);
    expect(requests.map((r) => r.url)).toEqual([`${BASE}?limit=50&offset=0`]);
  });

  it("walks every page of a big board (only the first request is conditional)", async () => {
    const items = list().content;
    const page = (from: number, to: number) => response(200, { totalFound: 3, content: items.slice(from, to) }, { ETag: 'W/"p1"' });
    const { fetch, requests } = routedFetch([
      ["limit=2&offset=0", page(0, 2)],
      ["limit=2&offset=2", page(2, 3)],
      [`${BASE}/744000000000001`, response(200, detail(1))],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    const channels = aiChannels((b) => {
      b.page_size = 2;
    });
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels });
    const { channel: c, store } = channel();
    const postings = await c.collect(query, ctx);
    expect(postings.map((p) => p.externalId)).toEqual(["744000000000001", "744000000000003"]);
    expect(requests.slice(0, 2).map((r) => new URL(r.url).searchParams.get("offset"))).toEqual(["0", "2"]);
    expect(requests[1]?.headers).not.toHaveProperty("If-None-Match");
    expect(store.states.get("smartrecruiters:ExampleLabs")?.etag).toBe('W/"p1"');
  });

  it("records a short board after exactly two requests when three postings are listed out of five announced", async () => {
    const { fetch, requests } = routedFetch([
      ["offset=0", response(200, { totalFound: 5, content: list().content }, { ETag: 'W/"short"' })],
      ["offset=3", response(200, { totalFound: 5, content: [] })],
      [`${BASE}/744000000000001`, response(200, detail(1))],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();

    await expect(c.collect(query, ctx)).resolves.toMatchObject([
      { externalId: "744000000000001" }, { externalId: "744000000000003" },
    ]);

    expect(requests.filter((r) => r.url.includes("offset="))).toHaveLength(2);
    expect(store.checks).toEqual([{ key: { ats: "smartrecruiters", token: sr.token }, update: { status: "short", detailRetryIds: [] } }]);
    expect(store.states.has(BOARD_KEY)).toBe(false);
    expect(logs.find((l) => l.message === "ats board listed fewer than announced")).toMatchObject({
      level: "warn", fields: { board: sr.token, listed: 3, announced: 5 },
    });
    expect(logs.find((l) => l.message === "ats board")?.fields).toMatchObject({ outcome: "short", fetched: 3, kept: 2 });
    expect(logs.find((l) => l.message === "ats sweep done")?.fields).toMatchObject({ failedBoards: 0, softBoards: 1, postings: 2 });
  });

  it.each([
    { details: "resolved", failedDetail: false },
    { details: "still missing", failedDetail: true },
  ])("returns both boards' available details after a later 503 and preserves complete state with retries $details", async ({ failedDetail }) => {
    const otherBody = inlineList(["other-good"], otherSr.token);
    const { fetch, requests } = routedFetch([
      [PAGE_URL, firstPage()],
      [NEXT_PAGE_URL, response(503, "list unavailable")],
      [`${BASE}/744000000000001`, response(200, detail(1))],
      [`${BASE}/744000000000003`, failedDetail ? response(500, "detail unavailable") : response(200, detail(3))],
      [OTHER_PAGE_URL, response(200, otherBody)],
      [`${OTHER_BASE}/other-good`, response(200, otherBody.content[0])],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: pagedChannels() });
    const { channel: c, store } = channel([sr, otherSr]);
    const oldState = {
      etag: 'W/"last-complete"', filterFingerprint: "3:previous-rules:10",
      externalIds: ["old-only", "744000000000003"], detailRetryIds: ["old-retry"],
    };
    store.states.set(BOARD_KEY, structuredClone(oldState));
    store.stored.add("744000000000003");

    await expect(c.collect(query, ctx)).resolves.toMatchObject([
      { externalId: "744000000000001", payload: { source, posting: detail(1) } },
      ...(failedDetail ? [] : [{ externalId: "744000000000003", payload: { source, posting: detail(3) } }]),
      { externalId: "other-good", payload: { source: { token: otherSr.token }, posting: otherBody.content[0] } },
    ]);

    const detailRetryIds = failedDetail ? ["old-retry", "744000000000003"] : ["old-retry"];
    expect(store.checks[0]).toEqual({
      key: { ats: "smartrecruiters", token: sr.token },
      update: { status: "error", errorCode: "network", detailRetryIds },
    });
    expect(store.states.get(BOARD_KEY)).toEqual({ ...oldState, detailRetryIds });
    expect(store.checks[1]?.update).toMatchObject({ status: "ok", completeRead: true });
    expect(requests.map((r) => r.url)).toEqual([
      PAGE_URL, NEXT_PAGE_URL, `${BASE}/744000000000001`, `${BASE}/744000000000003`,
      OTHER_PAGE_URL, `${OTHER_BASE}/other-good`,
    ]);
    expect(logs.find((l) => l.message === "ats board read only in part")).toMatchObject({
      level: "warn", fields: { board: sr.token, code: "network", listed: 2, kept: 2 },
    });
    expect(logs.find((l) => l.message === "ats board" && l.fields.board === sr.token)?.fields).toMatchObject({ outcome: "incomplete" });
    expect(logs.find((l) => l.message === "ats board not found")).toBeUndefined();
    expect(logs.find((l) => l.message === "ats sweep done")?.fields).toMatchObject({ boards: 2, failedBoards: 1, postings: failedDetail ? 2 : 3 });
  });

  it.each([
    { failure: "503", answer: () => response(503, "list unavailable"), code: "network" },
    { failure: "wrong shape", answer: () => response(200, { totalFound: 3, content: "invalid" }), code: "parse" },
  ])("rejects with detailed first-page postings when the next list page has $failure", async ({ answer, code }) => {
    const { fetch, requests } = pagedRoutes(answer());
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels: pagedChannels() });
    const { channel: c, store } = channel();
    const collection = c.collect(query, ctx);

    await expect(collection).rejects.toBeInstanceOf(PartialCollectError);
    await expect(collection).rejects.toMatchObject({
      cause: { name: "ChannelError", code },
      postings: [
        { externalId: "744000000000001", payload: { source, posting: detail(1) } },
        { externalId: "744000000000003", payload: { source, posting: detail(3) } },
      ],
    });
    expect(requests.map((r) => r.url)).toEqual([PAGE_URL, NEXT_PAGE_URL, `${BASE}/744000000000001`, `${BASE}/744000000000003`]);
    expect(store.checks.at(-1)?.update).toEqual({ status: "error", errorCode: code, detailRetryIds: [] });
    expect(store.states.has(BOARD_KEY)).toBe(false);
  });

  it("returns first-page postings normally but records an error when a later list page answers 404", async () => {
    const { fetch } = pagedRoutes(response(404, "page disappeared"));
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: pagedChannels() });
    const { channel: c, store } = channel();

    await expect(c.collect(query, ctx)).resolves.toMatchObject([
      { externalId: "744000000000001", payload: { posting: detail(1) } },
      { externalId: "744000000000003", payload: { posting: detail(3) } },
    ]);

    expect(store.checks.at(-1)?.update).toEqual({ status: "error", errorCode: "unknown", detailRetryIds: [] });
    expect(store.states.has(BOARD_KEY)).toBe(false);
    expect(logs.find((l) => l.message === "ats board")?.fields).toMatchObject({ outcome: "incomplete", fetched: 2, kept: 2 });
    expect(logs.find((l) => l.message === "ats board not found")).toBeUndefined();
    expect(logs.find((l) => l.message === "ats sweep done")?.fields).toMatchObject({ failedBoards: 0, softBoards: 1, postings: 2 });
  });

  it.each([
    { outcome: "short", later404: false },
    { outcome: "error", later404: true },
  ])("resolves an empty prefiltered sweep while recording $outcome for an incomplete list", async ({ outcome, later404 }) => {
    const body = inlineList(later404 ? ["filtered-a", "filtered-b"] : ["filtered-a", "filtered-b", "filtered-b"]);
    const firstUrl = `${BASE}?limit=3&offset=0&country=de`;
    const nextUrl = `${BASE}?limit=3&offset=2&country=de`;
    const { fetch, requests } = routedFetch([
      [firstUrl, response(200, {
        totalFound: 3,
        content: body.content.map((p) => ({ ...p, name: "Sales Manager" })),
      }, { ETag: 'W/"filtered-incomplete"' })],
      [nextUrl, response(404, "page disappeared")],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: pagedChannels(3) });
    const { channel: c, store } = channel();

    await expect(c.collect(query, ctx)).resolves.toEqual([]);

    expect(store.checks.at(-1)?.update).toEqual({
      status: outcome, ...(later404 ? { errorCode: "unknown" } : {}), detailRetryIds: [],
    });
    expect(store.checks.some((check) => check.update.status === "ok")).toBe(false);
    expect(store.states.has(BOARD_KEY)).toBe(false);
    expect(requests.map((r) => r.url)).toEqual(later404 ? [firstUrl, nextUrl] : [firstUrl]);
    expect(logs.find((l) => l.message === "ats sweep done")?.fields).toMatchObject({ failedBoards: 0, softBoards: 1, postings: 0 });
  });

  it("counts distinct ids across pages as short while advancing offsets by raw entries and handing duplicates over once", async () => {
    const body = inlineList(["a", "b", "c"]);
    const { fetch, requests } = routedFetch([
      [PAGE_URL, response(200, { totalFound: 4, content: body.content.slice(0, 2) }, { ETag: 'W/"duplicates"' })],
      [NEXT_PAGE_URL, response(200, { totalFound: 4, content: body.content.slice(1) })],
      [`${BASE}/`, ({ url }) => response(200, body.content.find((p) => p.id === url.slice(BASE.length + 1)))],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: pagedChannels() });
    const { channel: c, store } = channel();
    const oldState = { etag: 'W/"complete"', filterFingerprint: "3:previous-rules:10", externalIds: ["old"], detailRetryIds: ["b"] };
    store.states.set(BOARD_KEY, structuredClone(oldState));

    await expect(c.collect(query, ctx)).resolves.toMatchObject([
      { externalId: "a" }, { externalId: "b" }, { externalId: "c" },
    ]);

    expect(requests.filter((r) => r.url.includes("offset=")).map((r) => r.url)).toEqual([PAGE_URL, NEXT_PAGE_URL]);
    expect(requests.filter((r) => r.url === `${BASE}/b`)).toHaveLength(1);
    expect(store.checks.at(-1)?.update).toEqual({ status: "short", detailRetryIds: ["b"] });
    expect(store.states.get(BOARD_KEY)).toEqual(oldState);
    expect(logs.find((l) => l.message === "ats board listed fewer than announced")?.fields).toMatchObject({ listed: 3, announced: 4 });
    expect(logs.find((l) => l.message === "ats board")?.fields).toMatchObject({ outcome: "short", duplicates: 1 });
  });

  it.each([
    { outcome: "error", nextPage: () => response(503, "list unavailable") },
    { outcome: "short", nextPage: () => response(200, { totalFound: 2, content: [] }) },
  ])("keeps an unlisted detail retry through an incomplete read ($outcome) and rejects the following 304", async ({ outcome, nextPage }) => {
    const body = inlineList(["a", "b"]);
    const etag = 'W/"unresolved-list"';
    const { channel: c, store } = channel();
    store.stored.add("b");
    const completeChannels = aiChannels((settings) => { settings.max_results = 10; });
    const first = atsContext("smartrecruiters", routedFetch([
      [LIST_URL, response(200, body, { ETag: etag })],
      [`${BASE}/a`, response(200, body.content[0])],
      [`${BASE}/b`, response(500, "detail unavailable")],
    ]).fetch, { channels: completeChannels });

    await expect(partialPostings(c.collect(first.query, first.ctx))).resolves.toMatchObject([{ externalId: "a" }]);
    expect(store.states.get(BOARD_KEY)).toMatchObject({ etag, externalIds: ["a", "b"], detailRetryIds: ["b"] });
    const remembered = structuredClone(store.states.get(BOARD_KEY));

    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const partial = routedFetch([
      [LIST_URL, response(200, { totalFound: 2, content: body.content.slice(0, 1) })],
      [`${BASE}?limit=100&offset=1&country=de`, nextPage()],
      [`${BASE}/a`, response(200, body.content[0])],
    ]);
    // Changing the cap makes this read unconditional without changing the remembered complete-list state.
    const second = atsContext("smartrecruiters", partial.fetch, {
      channels: aiChannels((settings) => { settings.max_results = 11; }),
    });
    const collection = c.collect(second.query, second.ctx);
    if (outcome === "error") await expect(partialPostings(collection)).resolves.toMatchObject([{ externalId: "a" }]);
    else await expect(collection).resolves.toMatchObject([{ externalId: "a" }]);
    expect(partial.requests.map((request) => request.url)).toEqual([
      LIST_URL, `${BASE}?limit=100&offset=1&country=de`, `${BASE}/a`,
    ]);
    expect(partial.requests[0]?.headers).not.toHaveProperty("If-None-Match");
    expect.soft(store.checks.at(-1)?.update).toEqual({
      status: outcome, ...(outcome === "error" ? { errorCode: "network" } : {}), detailRetryIds: ["b"],
    });
    expect.soft(store.states.get(BOARD_KEY)).toEqual(remembered);

    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    const unchanged = routedFetch([[LIST_URL, response(304)]]);
    const third = atsContext("smartrecruiters", unchanged.fetch, { channels: completeChannels });
    await expect.soft(c.collect(third.query, third.ctx)).rejects.toMatchObject({
      name: "ChannelError", code: "unknown", retryable: false,
      message: "1 posting details are still missing from an earlier sweep",
    });
    expect(unchanged.requests).toHaveLength(1);
    expect(unchanged.requests[0]?.headers["If-None-Match"]).toBe(etag);
    expect.soft(store.checks.at(-1)?.update).toEqual({ status: "not_modified", completeRead: false });
    expect.soft(third.logs.find((log) => log.message === "ats sweep done")?.fields).toMatchObject({
      failedBoards: 0, detailFailedBoards: 1, postings: 0,
    });

    // Only a complete list may finally remove an earlier retry that is no longer listed.
    const recovered = atsContext("smartrecruiters", routedFetch([
      [LIST_URL, response(200, inlineList(["a"]), { ETag: 'W/"resolved-list"' })],
      [`${BASE}/a`, response(200, body.content[0])],
    ]).fetch, { channels: completeChannels });
    await expect(c.collect(recovered.query, recovered.ctx)).resolves.toMatchObject([{ externalId: "a" }]);
    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", completeRead: true, detailRetryIds: [] });
  });

  it.each([false, true])("retains skipped details after a partial list and the failure limit (existing state: %s)", async (existing) => {
    const body = inlineList(["failed", "new-skipped", "old-retry"]);
    const { channel: c, store } = channel();
    if (existing) store.states.set(BOARD_KEY, {
      etag: 'W/"complete"', filterFingerprint: "3:previous-rules:10", externalIds: [],
      detailRetryIds: ["old-retry", "unlisted"],
    });
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, { ...body, totalFound: 4 })],
      [`${BASE}?limit=100&offset=3&country=de`, response(503, "list unavailable")],
      [`${BASE}/failed`, response(500, "detail unavailable")],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, {
      channels: aiChannels((settings) => { settings.max_consecutive_detail_failures = 1; }),
    });

    await expect(c.collect(query, ctx)).rejects.toMatchObject({ name: "ChannelError", code: "network", status: 503 });
    expect(requests.map((request) => request.url)).toEqual([
      LIST_URL, `${BASE}?limit=100&offset=3&country=de`, `${BASE}/failed`,
    ]);
    expect(logs.find((log) => log.message === "ats board details missing")?.fields).toMatchObject({ failed: 1, skipped: 2 });
    const detailRetryIds = existing ? ["old-retry", "unlisted", "failed", "new-skipped"] : ["failed", "new-skipped", "old-retry"];
    expect(store.checks.at(-1)?.update).toEqual({ status: "error", errorCode: "network", detailRetryIds });
    if (existing) expect(store.states.get(BOARD_KEY)?.detailRetryIds).toEqual(detailRetryIds);
  });

  it.each(["first", "later"])("propagates cancellation while reading the %s list page body without recording state", async (page) => {
    const abort = new AbortController();
    const abortError = new DOMException("cancelled while reading list", "AbortError");
    const cancelledPage = {
      ...response(200, { totalFound: 3, content: [] }),
      json: async () => { abort.abort(abortError); throw abortError; },
    };
    const { fetch, requests } = routedFetch([
      [PAGE_URL, page === "first" ? cancelledPage : firstPage()],
      [NEXT_PAGE_URL, cancelledPage],
    ]);
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels: pagedChannels(), signal: abort.signal });
    const { channel: c, store } = channel();

    await expect(c.collect(query, ctx)).rejects.toBe(abortError);

    expect(abort.signal.aborted).toBe(true);
    expect(requests.map((r) => r.url)).toEqual(page === "first" ? [PAGE_URL] : [PAGE_URL, NEXT_PAGE_URL]);
    expect(store.checks).toEqual([]);
    expect(store.states.size).toBe(0);
    expect(store.touched).toEqual([]);
  });

  it("preserves a later list body stream's network error as the cause of the partial collection", async () => {
    const networkError = new ChannelError("network", "list stream interrupted", { retryable: true });
    const { fetch } = pagedRoutes({
      ...response(200, { totalFound: 3, content: [] }),
      json: async () => { throw networkError; },
    });
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels: pagedChannels() });
    const { channel: c, store } = channel();
    const collection = c.collect(query, ctx);

    await expect(collection).rejects.toBeInstanceOf(PartialCollectError);
    await expect(collection).rejects.toMatchObject({
      cause: { code: "network", retryable: true },
      postings: [
        { externalId: "744000000000001", payload: { posting: detail(1) } },
        { externalId: "744000000000003", payload: { posting: detail(3) } },
      ],
    });
    await expect(collection).rejects.toHaveProperty("cause", networkError);
    expect(store.checks.at(-1)?.update).toEqual({ status: "error", errorCode: "network", detailRetryIds: [] });
  });

  it("keeps the first missing-board failure whether a later hard failure has postings or not", async () => {
    // The empty case must stay a plain ChannelError; the case with content must retain that same first cause.
    for (const hasPostings of [false, true]) {
      const body = inlineList(["other-good"], otherSr.token);
      const { fetch } = routedFetch([
        [PAGE_URL, response(404, "board missing")],
        [OTHER_PAGE_URL, hasPostings ? response(200, { ...body, totalFound: 2 }) : response(503, "list unavailable")],
        [`${OTHER_BASE}?limit=2&offset=1`, response(200, { content: "invalid" })],
        [`${OTHER_BASE}/other-good`, response(200, body.content[0])],
      ]);
      const { ctx, query } = atsContext("smartrecruiters", fetch, { channels: pagedChannels() });
      const { channel: c, store } = channel([sr, otherSr]);
      const collection = c.collect(query, ctx);
      const missingBoard = { name: "ChannelError", code: "unknown", status: 404, retryable: false, message: expect.stringContaining(sr.token) };

      if (hasPostings) {
        await expect(collection).rejects.toBeInstanceOf(PartialCollectError);
        await expect(collection).rejects.toMatchObject({
          cause: missingBoard,
          postings: [{ externalId: "other-good", payload: { source: { token: otherSr.token }, posting: body.content[0] } }],
        });
      } else {
        await expect(collection).rejects.toBeInstanceOf(ChannelError);
        await expect(collection).rejects.not.toBeInstanceOf(PartialCollectError);
        await expect(collection).rejects.toMatchObject(missingBoard);
      }
      expect(store.checks.map((check) => check.update)).toEqual([
        { status: "error", errorCode: "not_found" },
        hasPostings ? { status: "error", errorCode: "parse", detailRetryIds: [] } : { status: "error", errorCode: "network" },
      ]);
    }
  });

  it("returns both boards' postings when a later-page network failure shares a sweep with a short board", async () => {
    const otherBody = inlineList(["other-good"], otherSr.token);
    const { fetch } = routedFetch([
      [PAGE_URL, firstPage()],
      [NEXT_PAGE_URL, response(503, "list unavailable")],
      [`${BASE}/744000000000001`, response(200, detail(1))],
      [`${BASE}/744000000000003`, response(200, detail(3))],
      [OTHER_PAGE_URL, response(200, { ...otherBody, totalFound: 2 })],
      [`${OTHER_BASE}?limit=2&offset=1`, response(200, { totalFound: 2, content: [] })],
      [`${OTHER_BASE}/other-good`, response(200, otherBody.content[0])],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: pagedChannels() });
    const { channel: c, store } = channel([sr, otherSr]);

    await expect(c.collect(query, ctx)).resolves.toMatchObject([
      { externalId: "744000000000001", payload: { posting: detail(1) } },
      { externalId: "744000000000003", payload: { posting: detail(3) } },
      { externalId: "other-good", payload: { posting: otherBody.content[0] } },
    ]);

    expect(store.checks.map((check) => check.update)).toEqual([
      { status: "error", errorCode: "network", detailRetryIds: [] },
      { status: "short", detailRetryIds: [] },
    ]);
    expect(logs.find((l) => l.message === "ats sweep done")?.fields).toMatchObject({ boards: 2, failedBoards: 1, softBoards: 1, postings: 3 });
  });

  it("[regression guard] answers 304 with no unresolved details: no further requests, postings touched", async () => {
    const { channel: c, store } = channel();
    const first = atsContext("smartrecruiters", routes().fetch, { channels: aiChannels() });
    await c.collect(first.query, first.ctx);
    expect(store.states.get(BOARD_KEY)).toMatchObject({ etag: 'W/"list-v1"', externalIds: ["744000000000001", "744000000000003"], detailRetryIds: [] });

    const second = routedFetch([[LIST_URL, response(304)]]);
    const b = atsContext("smartrecruiters", second.fetch, { channels: aiChannels() });
    expect(await c.collect(b.query, b.ctx)).toEqual([]);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.headers["If-None-Match"]).toBe('W/"list-v1"');
    // fetch would otherwise add "Cache-Control: no-cache", which SmartRecruiters answers with 200 (verified live)
    expect(second.requests[0]?.headers["Cache-Control"]).toBe("max-age=0");
    expect(store.touched.at(-1)).toEqual(["744000000000001", "744000000000003"]);
    expect(store.checks.at(-1)?.update).toEqual({ status: "not_modified", completeRead: true });
    expect(store.states.get(BOARD_KEY)?.detailRetryIds).toEqual([]);
    expect(b.logs.find((l) => l.message === "ats board still has unresolved details")).toBeUndefined();
    expect(b.logs.find((l) => l.message === "ats sweep done")?.fields).not.toHaveProperty("detailFailedBoards");
  });

  it.each([
    { name: "rejects every 304 with unresolved stored details until a successful 200 clears them", stored: true, healthyOther: false },
    { name: "rejects every 304 with unresolved never-stored details until a successful 200 clears them", stored: false, healthyOther: false },
    { name: "returns a healthy board's postings while another board has unresolved details on 304", stored: true, healthyOther: true },
  ])("$name", async ({ stored, healthyOther }) => {
    const other = company({ name: "Other Labs", ats: "smartrecruiters", token: "OtherLabs" });
    const otherBase = "https://api.smartrecruiters.com/v1/companies/OtherLabs/postings";
    const otherListUrl = `${otherBase}?limit=100&offset=0&country=de`;
    const ids = ["a1", "a2"];
    const body = inlineList(ids);
    const otherBody = inlineList(["b-good"], other.token);
    let etag = 'W/"unresolved"';
    let detailsAvailable = false;
    const { fetch, requests } = routedFetch([
      [LIST_URL, ({ headers }) => headers["If-None-Match"] === etag ? response(304) : response(200, body, { ETag: etag })],
      [`${BASE}/`, ({ url }) => detailsAvailable
        ? response(200, body.content.find((p) => p.id === url.slice(BASE.length + 1)))
        : response(500, "detail unavailable")],
      [otherListUrl, response(200, otherBody)],
      [`${otherBase}/b-good`, response(200, otherBody.content[0])],
    ]);
    const deps = depsWith(inputs(healthyOther ? [sr, other] : [sr]));
    const c = createSmartrecruitersChannel(deps);
    const store = deps.memory;
    if (stored) for (const id of ids) store.stored.add(id);
    const healthyPostings = healthyOther
      ? [{ externalId: "b-good", payload: { source: { token: other.token }, posting: otherBody.content[0] } }]
      : [];
    // A never-stored first miss clears the validator; a second failed 200 retains it.
    for (let round = 0; round < (stored ? 1 : 2); round += 1) {
      const first = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
      const collection = c.collect(first.query, first.ctx);
      if (healthyOther) await expect(collection).resolves.toMatchObject(healthyPostings);
      else await expect(collection).rejects.toMatchObject({ name: "ChannelError", code: "network", status: 500 });
      expect(store.states.get(BOARD_KEY)).toMatchObject({
        etag: stored || round > 0 ? etag : null, externalIds: stored ? ids : [], detailRetryIds: ids,
      });
    }

    for (const at of ["2026-10-08T12:00:00Z", "2026-10-09T12:00:00Z"]) {
      vi.setSystemTime(new Date(at));
      const before = requests.length;
      const touched = [...store.touched];
      const state = structuredClone(store.states.get(BOARD_KEY));
      const unchanged = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
      const collection = c.collect(unchanged.query, unchanged.ctx);
      if (healthyOther) {
        await expect(collection).resolves.toMatchObject(healthyPostings);
      } else {
        await expect(collection).rejects.toBeInstanceOf(ChannelError);
        await expect(collection).rejects.toMatchObject({
          name: "ChannelError", code: "unknown", retryable: false,
          message: "2 posting details are still missing from an earlier sweep",
        });
      }
      expect(requests.slice(before).map((r) => r.url)).toEqual([
        LIST_URL, ...(healthyOther ? [otherListUrl, `${otherBase}/b-good`] : []),
      ]);
      expect(requests[before]?.headers["If-None-Match"]).toBe(etag);
      expect(store.checks.filter((check) => check.key.token === sr.token).at(-1)?.update).toEqual({ status: "not_modified", completeRead: false });
      expect(store.states.get(BOARD_KEY)).toEqual(state);
      expect(store.touched).toEqual([...touched, stored ? ids : []]);
      expect(unchanged.logs.find((l) => l.message === "ats board still has unresolved details")).toMatchObject({
        level: "warn", fields: { board: sr.token, count: 2 },
      });
      expect(unchanged.logs.find((l) => l.message === "ats board" && l.fields.board === sr.token)?.fields).toEqual({
        channel: "smartrecruiters", company: sr.name, board: sr.token, outcome: "not_modified", fetched: 0, kept: 0,
      });
      expect(unchanged.logs.find((l) => l.message === "ats sweep done")?.fields).toMatchObject({
        boards: healthyOther ? 2 : 1, failedBoards: 0, detailFailedBoards: 1, postings: healthyOther ? 1 : 0,
      });
    }

    etag = 'W/"resolved"';
    detailsAvailable = true;
    const recovered = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    await expect(c.collect(recovered.query, recovered.ctx)).resolves.toMatchObject([
      ...ids.map((externalId) => ({ externalId })), ...healthyPostings,
    ]);
    expect(store.states.get(BOARD_KEY)).toMatchObject({ etag, externalIds: ids, detailRetryIds: [] });
    expect(store.checks.filter((check) => check.key.token === sr.token).at(-1)?.update).toMatchObject({ status: "ok", completeRead: true, detailRetryIds: [] });
    expect(recovered.logs.find((l) => l.message === "ats sweep done")?.fields).not.toHaveProperty("detailFailedBoards");

    const unchanged = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    await expect(c.collect(unchanged.query, unchanged.ctx)).resolves.toMatchObject(healthyPostings);
    expect(store.checks.filter((check) => check.key.token === sr.token).at(-1)?.update).toEqual({ status: "not_modified", completeRead: true });
    expect(store.states.get(BOARD_KEY)?.detailRetryIds).toEqual([]);
    expect(store.touched.at(-1)).toEqual(ids);
    expect(unchanged.logs.find((l) => l.message === "ats board still has unresolved details")).toBeUndefined();
    expect(unchanged.logs.find((l) => l.message === "ats sweep done")?.fields).not.toHaveProperty("detailFailedBoards");
  });

  it("skips a posting that closed between the list and its detail (404)", async () => {
    const { fetch } = routedFetch([
      [LIST_URL, response(200, list())],
      [`${BASE}/744000000000001`, response(404, "gone")],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();
    store.stored.add("744000000000001");
    const postings = await c.collect(query, ctx);
    expect(postings.map((p) => p.externalId)).toEqual(["744000000000003"]);
    expect(logs.filter((l) => l.message === "ats board").map((l) => l.fields.kept)).toEqual([2]);
    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", kept: 2, externalIds: ["744000000000003"] });
    expect(store.touched).toEqual([]);
    expect(logs.find((l) => l.message === "ats sweep done")?.fields.postings).toBe(1);
  });

  it("stores the list entry when fetch_details is off", async () => {
    const { fetch, requests } = routedFetch([[LIST_URL, response(200, list())]]);
    const channels = aiChannels((b) => {
      b.fetch_details = false;
    });
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels });
    const postings = await channel().channel.collect(query, ctx);
    expect(requests).toHaveLength(1);
    expect(postings).toHaveLength(2);
    expect(channel().channel.parse(postings[0]?.payload)).toMatchObject({ title: "AI Platform Engineer (m/f/x)", description: "" });
  });

  it.each([
    { name: "rejects with the first detail error when one board loses every detail and the other list fails", goodDetail: false, healthyOther: false },
    { name: "rejects with collected postings when one board loses some details and the other list fails", goodDetail: true, healthyOther: false },
    { name: "returns both boards' postings when one board loses a detail and the other is fully healthy", goodDetail: true, healthyOther: true },
  ])("$name", async ({ goodDetail, healthyOther }) => {
    const other = company({ name: "Other Labs", ats: "smartrecruiters", token: "OtherLabs" });
    const otherBase = "https://api.smartrecruiters.com/v1/companies/OtherLabs/postings";
    const otherListUrl = `${otherBase}?limit=100&offset=0&country=de`;
    const firstList = inlineList(["a-failed", "a-good"]);
    const otherList = inlineList(["b-good"], other.token);
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, firstList, { ETag: 'W/"a"' })],
      [`${BASE}/a-failed`, response(500, "detail unavailable")],
      [`${BASE}/a-good`, goodDetail ? response(200, firstList.content[1]) : response(500, "detail unavailable")],
      [otherListUrl, healthyOther ? response(200, otherList) : response(503, "list unavailable")],
      [`${otherBase}/b-good`, response(200, otherList.content[0])],
    ]);
    const deps = depsWith(inputs([sr, other]));
    const c = createSmartrecruitersChannel(deps);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });

    if (healthyOther) {
      await expect(c.collect(query, ctx)).resolves.toMatchObject([
        { externalId: "a-good", payload: { source: { token: sr.token }, posting: firstList.content[1] } },
        { externalId: "b-good", payload: { source: { token: other.token }, posting: otherList.content[0] } },
      ]);
    } else if (goodDetail) {
      await expect(c.collect(query, ctx)).rejects.toMatchObject({
        name: "PartialCollectError",
        cause: { name: "ChannelError", code: "network", status: 500 },
        postings: [{ externalId: "a-good", payload: { source, posting: firstList.content[1] } }],
      });
    } else {
      // Board order chooses the detail's 500, not the later list's 503; no partial with zero postings.
      await expect(c.collect(query, ctx)).rejects.toMatchObject({ name: "ChannelError", code: "network", status: 500 });
    }

    expect(requests.map((r) => r.url)).toEqual([
      LIST_URL, `${BASE}/a-failed`, `${BASE}/a-good`, otherListUrl,
      ...(healthyOther ? [`${otherBase}/b-good`] : []),
    ]);
    const retryIds = goodDetail ? ["a-failed"] : ["a-failed", "a-good"];
    expect(deps.memory.checks).toMatchObject([
      { key: { ats: "smartrecruiters", token: sr.token }, update: { status: "ok", etag: null, detailRetryIds: retryIds } },
      { key: { ats: "smartrecruiters", token: other.token }, update: healthyOther ? { status: "ok" } : { status: "error", errorCode: "network" } },
    ]);
    expect(deps.memory.states.get(BOARD_KEY)).toMatchObject({ detailRetryIds: retryIds });
    expect(logs.find((l) => l.message === "ats board" && l.fields.board === sr.token)?.fields).toMatchObject({
      outcome: "changed", kept: 2, detailFailed: retryIds.length,
    });
    expect(logs.find((l) => l.message === "ats board details missing")?.fields).toMatchObject({
      board: sr.token, failed: retryIds.length, skipped: 0, code: "network",
    });
    expect(logs.find((l) => l.message === "ats sweep done")?.fields).toMatchObject({
      boards: 2, failedBoards: healthyOther ? 0 : 1, detailFailedBoards: 1, postings: healthyOther ? 2 : goodDetail ? 1 : 0,
    });
  });

  it.each([
    { storage: "stored", stored: true, etag: 'W/"x"', externalIds: ["744000000000003", "744000000000001"] },
    { storage: "new", stored: false, etag: null, externalIds: ["744000000000003"] },
  ])("keeps the board healthy when a $storage posting's detail returns 500", async ({ stored, etag, externalIds }) => {
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, list(), { ETag: 'W/"x"' })],
      [`${BASE}/744000000000001`, response(500, "unavailable")],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();
    if (stored) store.stored.add("744000000000001");

    await expect(partialPostings(c.collect(query, ctx))).resolves.toMatchObject([{ externalId: "744000000000003", payload: { posting: detail(3) } }]);

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/744000000000001`, `${BASE}/744000000000003`]);
    expect(store.touched).toEqual([["744000000000001"]]);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", completeRead: false, etag, externalIds, detailRetryIds: ["744000000000001"], total: 3, kept: 2,
    });
    expect(store.states.get(BOARD_KEY)).toMatchObject({ etag, externalIds, detailRetryIds: ["744000000000001"] });
    const warning = logs.find((l) => l.message === "ats board details missing");
    expect(warning).toMatchObject({ level: "warn", fields: { board: sr.token, failed: 1, skipped: 0, code: "network" } });
    expect(warning?.fields).not.toHaveProperty("stoppedBy");
    const report = logs.find((l) => l.message === "ats board")?.fields;
    expect(report).toMatchObject({ outcome: "changed", kept: 2, detailFailed: 1 });
    expect(report).not.toHaveProperty("detailSkipped");
    expect(logs.find((l) => l.message === "ats sweep done")?.fields).toMatchObject({ failedBoards: 0, postings: 1 });
  });

  it("counts a non-JSON detail as a parse failure while keeping the board healthy", async () => {
    const { fetch } = routedFetch([
      [LIST_URL, response(200, list(), { ETag: 'W/"x"' })],
      [`${BASE}/744000000000001`, response(200, "not json at all")],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();

    await expect(partialPostings(c.collect(query, ctx))).resolves.toMatchObject([{ externalId: "744000000000003" }]);

    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag: null, externalIds: ["744000000000003"], detailRetryIds: ["744000000000001"],
    });
    expect(logs.find((l) => l.message === "ats board details missing")).toMatchObject({
      level: "warn", fields: { board: sr.token, failed: 1, skipped: 0, code: "parse" },
    });
  });

  it("touches stored over-cap ids before any detail request and survives a detail failure", async () => {
    const { channel: c, store } = channel();
    store.stored.add("744000000000003");
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, list(), { ETag: 'W/"x"' })],
      [`${BASE}/744000000000001`, () => {
        expect(store.touched).toEqual([["744000000000003"]]);
        return response(200, "not json at all");
      }],
    ]);
    const channels = aiChannels((b) => { b.max_results = 1; });
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels });

    await expect(c.collect(query, ctx)).rejects.toMatchObject({ code: "parse" });

    expect(store.touched).toEqual([["744000000000003"], ["744000000000001"]]);
    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/744000000000001`]);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag: null, externalIds: ["744000000000003"], detailRetryIds: ["744000000000001"], total: 3, kept: 1,
    });
  });

  it("records the ETag when a never-stored posting already on the retry list fails again", async () => {
    const { channel: c, store } = channel();
    store.states.set(BOARD_KEY, { etag: null, filterFingerprint: null, externalIds: [], detailRetryIds: ["744000000000001"] });
    const { fetch } = routedFetch([
      [LIST_URL, response(200, list(), { ETag: 'W/"x"' })],
      [`${BASE}/744000000000001`, response(500, "unavailable")],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });

    await expect(partialPostings(c.collect(query, ctx))).resolves.toMatchObject([{ externalId: "744000000000003" }]);

    expect(store.stored.has("744000000000001")).toBe(false);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag: 'W/"x"', externalIds: ["744000000000003"], detailRetryIds: ["744000000000001"],
    });
    expect(store.states.get(BOARD_KEY)).toMatchObject({ etag: 'W/"x"', detailRetryIds: ["744000000000001"] });
  });

  it("resets the consecutive failure count after a successful detail and returns the other seven postings", async () => {
    const body = inlineList(Array.from({ length: 10 }, (_, i) => String(i + 1)));
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, body)],
      [`${BASE}/`, ({ url }) => {
        const id = url.slice(BASE.length + 1);
        return ["1", "3", "5"].includes(id) ? response(500, "unavailable") : response(200, body.content.find((p) => p.id === id));
      }],
    ]);
    // Omitting the setting exercises the designed default of three consecutive failures.
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();

    await expect(partialPostings(c.collect(query, ctx))).resolves.toMatchObject(["2", "4", "6", "7", "8", "9", "10"].map((externalId) => ({ externalId })));

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, ...body.content.map((p) => `${BASE}/${p.id}`)]);
    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", kept: 10, detailRetryIds: ["1", "3", "5"] });
    expect(logs.find((l) => l.message === "ats board")?.fields).toMatchObject({ detailFailed: 3, kept: 10 });
    expect(logs.find((l) => l.message === "ats board")?.fields).not.toHaveProperty("detailSkipped");
    expect(logs.find((l) => l.message === "ats board details missing")?.fields).not.toHaveProperty("stoppedBy");
  });

  it("skips the remaining seven details after three consecutive failures and touches stored skipped ids", async () => {
    const body = inlineList(Array.from({ length: 10 }, (_, i) => String(i + 1)));
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, body, { ETag: 'W/"ten"' })],
      [`${BASE}/`, ({ url }) => {
        const id = url.slice(BASE.length + 1);
        return ["1", "2", "3"].includes(id) ? response(500, "unavailable") : response(200, body.content.find((p) => p.id === id));
      }],
    ]);
    const { channel: c, store } = channel();
    store.stored.add("4");
    store.stored.add("10");
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });

    await expect(c.collect(query, ctx)).rejects.toMatchObject({ code: "network", status: 500 });

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/1`, `${BASE}/2`, `${BASE}/3`]);
    expect(store.touched).toEqual([["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]]);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag: null, externalIds: ["4", "10"], detailRetryIds: ["1", "2", "3"], total: 10, kept: 10,
    });
    expect(logs.find((l) => l.message === "ats board")?.fields).toMatchObject({ detailFailed: 3, detailSkipped: 7, kept: 10 });
    expect(logs.find((l) => l.message === "ats board details missing")).toMatchObject({
      level: "warn", fields: { board: sr.token, failed: 3, skipped: 7, code: "network", stoppedBy: "network" },
    });
  });

  it("requests a skipped new posting first next round so persistent detail failures cannot starve it", async () => {
    const body = inlineList(["bad1", "bad2", "bad3", "good-new"]);
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, body, { ETag: 'W/"same-list"' })],
      [`${BASE}/good-new`, response(200, body.content[3])],
      [`${BASE}/bad`, response(500, "unavailable")],
    ]);
    const { channel: c, store } = channel();
    const first = atsContext("smartrecruiters", fetch, { channels: aiChannels() });

    await expect(c.collect(first.query, first.ctx)).rejects.toMatchObject({ code: "network", status: 500 });

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/bad1`, `${BASE}/bad2`, `${BASE}/bad3`]);
    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", etag: null, detailRetryIds: ["bad1", "bad2", "bad3"] });
    // The next collect loads the state recorded by the first through the real memory store.
    expect(await store.load({ ats: "smartrecruiters", token: sr.token })).toMatchObject({
      etag: null, externalIds: [], detailRetryIds: ["bad1", "bad2", "bad3"],
    });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const second = atsContext("smartrecruiters", fetch, { channels: aiChannels() });

    await expect(partialPostings(c.collect(second.query, second.ctx))).resolves.toMatchObject([{ externalId: "good-new" }]);

    expect(requests.slice(4).map((r) => r.url)).toEqual([LIST_URL, `${BASE}/good-new`, `${BASE}/bad1`, `${BASE}/bad2`, `${BASE}/bad3`]);
    expect(requests[4]?.headers).not.toHaveProperty("If-None-Match");
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag: 'W/"same-list"', externalIds: ["good-new"], detailRetryIds: ["bad1", "bad2", "bad3"],
    });
  });

  it("retains a prior retry skipped after three new detail failures and clears the ETag", async () => {
    const body = inlineList(["n1", "n2", "n3", "r1"]);
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, body, { ETag: 'W/"retry"' })],
      [`${BASE}/`, response(500, "detail unavailable")],
    ]);
    const { channel: c, store } = channel();
    store.states.set(BOARD_KEY, { etag: null, filterFingerprint: null, externalIds: [], detailRetryIds: ["r1"] });
    const channels = aiChannels((b) => { b.max_consecutive_detail_failures = 3; });
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels });

    await expect(c.collect(query, ctx)).rejects.toMatchObject({ code: "network", status: 500 });

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/n1`, `${BASE}/n2`, `${BASE}/n3`]);
    expect(store.touched).toEqual([["n1", "n2", "n3", "r1"]]);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag: null, externalIds: [], detailRetryIds: ["n1", "n2", "n3", "r1"], total: 4, kept: 4,
    });
    expect(store.states.get(BOARD_KEY)).toMatchObject({ etag: null, detailRetryIds: ["n1", "n2", "n3", "r1"] });
    expect(logs.find((l) => l.message === "ats board details missing")?.fields).toMatchObject({
      failed: 3, skipped: 1, stoppedBy: "network",
    });
  });

  it("keeps the ETag when new details succeed and only a prior retry is skipped after failures in the retry group", async () => {
    const body = inlineList(["n1", "n2", "n3", "r2", "r3", "r4", "r1"]);
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, body, { ETag: 'W/"retry"' })],
      [`${BASE}/r`, response(500, "detail unavailable")],
      [`${BASE}/n`, ({ url }) => response(200, body.content.find((p) => p.id === url.slice(BASE.length + 1)))],
    ]);
    const { channel: c, store } = channel();
    store.states.set(BOARD_KEY, { etag: null, filterFingerprint: null, externalIds: [], detailRetryIds: ["r2", "r3", "r4", "r1"] });
    const channels = aiChannels((b) => { b.max_consecutive_detail_failures = 3; });
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels });

    await expect(partialPostings(c.collect(query, ctx))).resolves.toMatchObject([
      { externalId: "n1" }, { externalId: "n2" }, { externalId: "n3" },
    ]);

    expect(requests.map((r) => r.url)).toEqual([
      LIST_URL, ...["n1", "n2", "n3", "r2", "r3", "r4"].map((id) => `${BASE}/${id}`),
    ]);
    expect(store.touched).toEqual([["r2", "r3", "r4", "r1"]]);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag: 'W/"retry"', externalIds: ["n1", "n2", "n3"], detailRetryIds: ["r2", "r3", "r4", "r1"],
    });
    expect(store.states.get(BOARD_KEY)).toMatchObject({ etag: 'W/"retry"', detailRetryIds: ["r2", "r3", "r4", "r1"] });
    expect(logs.find((l) => l.message === "ats board details missing")?.fields).toMatchObject({
      failed: 3, skipped: 1, stoppedBy: "network",
    });
  });

  it.each([
    { status: 403, code: "blocked" },
    { status: 429, code: "rate_limited" },
  ])("stops details at the first $code host refusal with the rest skipped", async ({ status, code }) => {
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, list(), { ETag: 'W/"x"' })],
      [`${BASE}/744000000000001`, response(status, "refused")],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    // atsContext sets maxRetries to zero, so a 429 has exhausted its retries on this request.
    const { ctx, query, logs, sleeps } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();
    store.stored.add("744000000000003");

    await expect(c.collect(query, ctx)).rejects.toMatchObject({ code, status });

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/744000000000001`]);
    expect(sleeps).toEqual([]);
    expect(store.touched).toEqual([["744000000000001", "744000000000003"]]);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", externalIds: ["744000000000003"], detailRetryIds: ["744000000000001"],
    });
    expect(logs.find((l) => l.message === "ats board details missing")).toMatchObject({
      level: "warn", fields: { board: sr.token, failed: 1, skipped: 1, code, stoppedBy: code },
    });
  });

  it("propagates cancellation while reading the last detail body without recording a failure", async () => {
    const abort = new AbortController();
    const abortError = new DOMException("cancelled while reading detail", "AbortError");
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, list())],
      [`${BASE}/744000000000001`, response(200, detail(1))],
      [`${BASE}/744000000000003`, {
        ...response(200, detail(3)),
        json: async () => { abort.abort(abortError); throw abortError; },
      }],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels(), signal: abort.signal });
    const { channel: c, store } = channel();

    await expect(c.collect(query, ctx)).rejects.toBe(abortError);

    expect(abort.signal.aborted).toBe(true);
    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/744000000000001`, `${BASE}/744000000000003`]);
    expect(store.checks).toEqual([]);
    expect(store.states.size).toBe(0);
    expect(store.touched).toEqual([]);
    expect(logs.filter((l) => ["ats board failed", "ats board details missing"].includes(l.message))).toEqual([]);
  });

  it("[regression guard] rejects cancellation after the last detail body succeeds without recording board state", async () => {
    const abort = new AbortController();
    const abortError = new DOMException("cancelled after reading detail", "AbortError");
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, list())],
      [`${BASE}/744000000000001`, response(200, detail(1))],
      [`${BASE}/744000000000003`, {
        ...response(200, detail(3)),
        json: async () => {
          const body = detail(3);
          abort.abort(abortError);
          return body;
        },
      }],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels(), signal: abort.signal });
    const { channel: c, store } = channel();

    await expect(c.collect(query, ctx)).rejects.toBe(abortError);

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/744000000000001`, `${BASE}/744000000000003`]);
    expect(store.checks).toEqual([]);
    expect(store.states.size).toBe(0);
    expect(store.touched).toEqual([]);
    expect(logs.filter((l) => ["ats board failed", "ats board details missing"].includes(l.message))).toEqual([]);
  });

  it("counts a broken detail stream as a network failure without wrapping it as parse", async () => {
    const { fetch } = routedFetch([
      [LIST_URL, response(200, list())],
      [`${BASE}/744000000000001`, {
        ...response(200, detail(1)),
        json: async () => { throw new ChannelError("network", "detail stream interrupted"); },
      }],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();

    await expect(partialPostings(c.collect(query, ctx))).resolves.toMatchObject([{ externalId: "744000000000003" }]);

    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", detailRetryIds: ["744000000000001"] });
    expect(logs.find((l) => l.message === "ats board details missing")).toMatchObject({
      level: "warn", fields: { board: sr.token, failed: 1, skipped: 0, code: "network" },
    });
  });

  it("requests new then stored then retry-listed details while returning postings in board order", async () => {
    const ids = ["retry-stored-1", "stored-1", "new-1", "retry-new", "stored-2", "new-2", "retry-stored-2"];
    const body = inlineList(ids);
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, body)],
      [`${BASE}/`, ({ url }) => response(200, body.content.find((p) => p.id === url.slice(BASE.length + 1)))],
    ]);
    const { channel: c, store } = channel();
    store.states.set(BOARD_KEY, {
      etag: null, filterFingerprint: null,
      externalIds: ["stored-2", "retry-stored-2", "stored-1", "retry-stored-1"],
      detailRetryIds: ["retry-new", "retry-stored-2", "retry-stored-1", "no-longer-listed"],
    });
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });

    await expect(c.collect(query, ctx)).resolves.toMatchObject(ids.map((id) => ({ externalId: id, payload: { posting: { id } } })));

    expect(requests.map((r) => r.url)).toEqual([
      LIST_URL,
      ...["new-1", "new-2", "stored-1", "stored-2", "retry-stored-1", "retry-new", "retry-stored-2"].map((id) => `${BASE}/${id}`),
    ]);
    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", externalIds: ids, detailRetryIds: [] });
  });

  it("a list in another shape is a parse error", async () => {
    const { ctx, query } = atsContext("smartrecruiters", routedFetch([[LIST_URL, response(200, { content: "x" })]]).fetch);
    await expect(channel().channel.collect(query, ctx)).rejects.toMatchObject({ code: "parse" });
  });
});

describe("smartrecruiters parse", () => {
  const parse = (n: number) => smartrecruitersAdapter.parse(wrapPosting(source, detail(n)));

  it("maps a detail: sections (role first, company last), location, level and language", () => {
    const d = parse(1);
    expect(normalizedPostingDraftSchema.parse(d)).toBeTruthy();
    expect(d).toMatchObject({
      title: "AI Platform Engineer (m/f/x)",
      companyName: "Example Labs",
      workplace: "hybrid",
      contractHint: "Full-time",
      seniorityHint: "Mid-Senior Level",
      descriptionLanguage: "en",
      salary: null,
      sourceUrl: "https://jobs.smartrecruiters.com/ExampleLabs/744000000000001-example",
      applyUrl: "https://jobs.smartrecruiters.com/ExampleLabs/744000000000001-example?oga=true",
    });
    expect(d.locations).toEqual([{ label: "München, BY, Germany", city: "München", countryCode: "DE" }]);
    expect(d.description.startsWith("Job Description\nBuild and run AI services & platforms.")).toBe(true);
    expect(d.description.endsWith("Company Description\nWe build AI products.")).toBe(true);
    expect(d.description).toContain("- Experience with cloud infrastructure");
    expect(d.extra).toMatchObject({ ats: "smartrecruiters", department: "Data", function: "Engineering" });
  });

  it("maps remote, drops the 'not applicable' level, and tolerates a bare list entry", () => {
    expect(parse(3).workplace).toBe("remote");
    expect(smartrecruitersAdapter.parse(wrapPosting(source, { id: "1", name: "AI Engineer", experienceLevel: { label: "Not Applicable" } })).seniorityHint).toBeNull();
    const bare = smartrecruitersAdapter.parse(wrapPosting(source, list().content[0]));
    expect(bare).toMatchObject({ description: "", workplace: "hybrid", sourceUrl: null });
  });

  it("rejects a posting without a name and a payload from another ATS", () => {
    expect(() => smartrecruitersAdapter.parse(wrapPosting(source, { id: "1" }))).toThrow(ChannelError);
    expect(() => smartrecruitersAdapter.parse(wrapPosting({ ...source, ats: "lever" }, detail(1)))).toThrow(/smartrecruiters posting envelope/);
  });

  it("describe() builds the posting URL from the company identifier", () => {
    expect(smartrecruitersAdapter.describe(list().content[0])).toMatchObject({
      externalId: "744000000000001",
      url: "https://jobs.smartrecruiters.com/ExampleLabs/744000000000001",
    });
    expect(smartrecruitersAdapter.describe({ name: "no id" })).toBeNull();
  });
});
