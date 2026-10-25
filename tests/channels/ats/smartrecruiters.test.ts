// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSmartrecruitersChannel, smartrecruitersAdapter } from "@/lib/channels/ats";
import { wrapPosting } from "@/lib/channels/ats/envelope";
import { ChannelError } from "@/lib/channels/errors";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import { atsChannelsWith, atsContext, company, depsWith, fixtureJson, inputs, response, routedFetch } from "./helpers";

const BASE = "https://api.smartrecruiters.com/v1/companies/ExampleLabs/postings";
const LIST_URL = `${BASE}?limit=100&offset=0&country=de`;
const sr = company({ name: "Example Labs", ats: "smartrecruiters", token: "ExampleLabs" });
const list = () => fixtureJson("smartrecruiters-list.json") as { totalFound: number; content: unknown[] };
const detail = (n: number) => fixtureJson(`smartrecruiters-detail-${n}.json`);
const source = { ats: "smartrecruiters", token: "ExampleLabs", companyName: "Example Labs" } as const;
const BOARD_KEY = "smartrecruiters:ExampleLabs";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});

afterEach(() => vi.useRealTimers());

function inlineList(ids: string[]) {
  return {
    totalFound: ids.length,
    content: ids.map((id) => ({ id, name: "AI Engineer", company: { identifier: sr.token } })),
  };
}

function channel() {
  const deps = depsWith(inputs([sr]));
  return { channel: createSmartrecruitersChannel(deps), store: deps.memory };
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

describe("smartrecruiters sweep", () => {
  it("lists the board, prefilters by title, and fetches the detail of every kept posting", async () => {
    const { fetch, requests } = routes();
    const { ctx, query, logs, sleeps } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c } = channel();
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
    // the stored payload is the detail, in the envelope (C1)
    expect(postings[0]?.payload).toEqual({ source, posting: detail(1) });
    for (const p of postings) expect(normalizedPostingDraftSchema.parse(c.parse(p.payload)).companyName).toBe("Example Labs");
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

  it("does not loop forever when the board lists fewer postings than it announces", async () => {
    const { fetch, requests } = routedFetch([
      ["offset=0", response(200, { totalFound: 5, content: list().content.slice(0, 3) })],
      ["offset=3", response(200, { totalFound: 5, content: [] })],
      [`${BASE}/`, response(200, detail(1))],
    ]);
    const { ctx, query } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    await channel().channel.collect(query, ctx);
    expect(requests.filter((r) => r.url.includes("offset="))).toHaveLength(2);
  });

  it("answers 304 on the first page with an unchanged board: no further requests, postings touched", async () => {
    const { channel: c, store } = channel();
    const first = atsContext("smartrecruiters", routes().fetch, { channels: aiChannels() });
    await c.collect(first.query, first.ctx);
    expect(store.states.get("smartrecruiters:ExampleLabs")).toMatchObject({ etag: 'W/"list-v1"', externalIds: ["744000000000001", "744000000000003"] });

    const second = routedFetch([[LIST_URL, response(304)]]);
    const b = atsContext("smartrecruiters", second.fetch, { channels: aiChannels() });
    expect(await c.collect(b.query, b.ctx)).toEqual([]);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.headers["If-None-Match"]).toBe('W/"list-v1"');
    // fetch would otherwise add "Cache-Control: no-cache", which SmartRecruiters answers with 200 (verified live)
    expect(second.requests[0]?.headers["Cache-Control"]).toBe("max-age=0");
    expect(store.touched.at(-1)).toEqual(["744000000000001", "744000000000003"]);
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

    await expect(c.collect(query, ctx)).resolves.toMatchObject([{ externalId: "744000000000003", payload: { posting: detail(3) } }]);

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/744000000000001`, `${BASE}/744000000000003`]);
    expect(store.touched).toEqual([["744000000000001"]]);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag, externalIds, detailRetryIds: ["744000000000001"], total: 3, kept: 2,
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

    await expect(c.collect(query, ctx)).resolves.toMatchObject([{ externalId: "744000000000003" }]);

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

    await expect(c.collect(query, ctx)).resolves.toEqual([]);

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

    await expect(c.collect(query, ctx)).resolves.toMatchObject([{ externalId: "744000000000003" }]);

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

    await expect(c.collect(query, ctx)).resolves.toMatchObject(["2", "4", "6", "7", "8", "9", "10"].map((externalId) => ({ externalId })));

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

    await expect(c.collect(query, ctx)).resolves.toEqual([]);

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

    await expect(c.collect(first.query, first.ctx)).resolves.toEqual([]);

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/bad1`, `${BASE}/bad2`, `${BASE}/bad3`]);
    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", etag: null, detailRetryIds: ["bad1", "bad2", "bad3"] });
    // The next collect loads the state recorded by the first through the real memory store.
    expect(await store.load({ ats: "smartrecruiters", token: sr.token })).toMatchObject({
      etag: null, externalIds: [], detailRetryIds: ["bad1", "bad2", "bad3"],
    });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const second = atsContext("smartrecruiters", fetch, { channels: aiChannels() });

    await expect(c.collect(second.query, second.ctx)).resolves.toMatchObject([{ externalId: "good-new" }]);

    expect(requests.slice(4).map((r) => r.url)).toEqual([LIST_URL, `${BASE}/good-new`, `${BASE}/bad1`, `${BASE}/bad2`, `${BASE}/bad3`]);
    expect(requests[4]?.headers).not.toHaveProperty("If-None-Match");
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", etag: 'W/"same-list"', externalIds: ["good-new"], detailRetryIds: ["bad1", "bad2", "bad3"],
    });
  });

  it("stops details at the first host refusal and reports blocked with the rest skipped", async () => {
    const { fetch, requests } = routedFetch([
      [LIST_URL, response(200, list(), { ETag: 'W/"x"' })],
      [`${BASE}/744000000000001`, response(403, "forbidden")],
      [`${BASE}/744000000000003`, response(200, detail(3))],
    ]);
    const { ctx, query, logs } = atsContext("smartrecruiters", fetch, { channels: aiChannels() });
    const { channel: c, store } = channel();
    store.stored.add("744000000000003");

    await expect(c.collect(query, ctx)).resolves.toEqual([]);

    expect(requests.map((r) => r.url)).toEqual([LIST_URL, `${BASE}/744000000000001`]);
    expect(store.touched).toEqual([["744000000000001", "744000000000003"]]);
    expect(store.checks.at(-1)?.update).toMatchObject({
      status: "ok", externalIds: ["744000000000003"], detailRetryIds: ["744000000000001"],
    });
    expect(logs.find((l) => l.message === "ats board details missing")).toMatchObject({
      level: "warn", fields: { board: sr.token, failed: 1, skipped: 1, code: "blocked", stoppedBy: "blocked" },
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

    await expect(c.collect(query, ctx)).resolves.toMatchObject([{ externalId: "744000000000003" }]);

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
