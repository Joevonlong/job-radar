// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createGreenhouseChannel, createLeverChannel, createMemoryAtsBoardStore } from "@/lib/channels/ats";
import { ChannelError } from "@/lib/channels/errors";
import { normalizedPostingDraftSchema, rawPostingInputSchema } from "@/lib/channels/types";

import { atsChannelsWith, atsContext, company, depsWith, fixtureJson, inputs, response, routedFetch } from "./helpers";

const GH_URL = "boards-api.greenhouse.io/v1/boards/examplelabs/jobs?content=true";
const GH_KEPT = ["6186419001", "6186419002", "6186419003", "6186419006"];
const gh = company({ name: "Example Labs", ats: "greenhouse", token: "examplelabs" });
const lv = company({ name: "Example Corp", ats: "lever", token: "examplecorp" });

function greenhouse(opts: { watched?: string[]; companies?: ReturnType<typeof company>[]; store?: ReturnType<typeof createMemoryAtsBoardStore> } = {}) {
  const deps = depsWith(inputs(opts.companies ?? [gh], { watched: opts.watched ?? [] }), opts.store);
  return { channel: createGreenhouseChannel(deps), store: deps.memory };
}

const lastLog = (logs: Array<{ message: string; fields: Record<string, unknown> }>, message: string) =>
  logs.filter((l) => l.message === message).map((l) => l.fields);

describe("greenhouse sweep", () => {
  it("fetches every board and keeps only titles matching a search.yaml keyword", async () => {
    const { fetch, requests } = routedFetch([[GH_URL, response(200, fixtureJson("greenhouse-board.json"), { ETag: 'W/"v1"' })]]);
    const { ctx, query, logs } = atsContext("greenhouse", fetch);
    const { channel } = greenhouse();

    const postings = await channel.collect(query, ctx);

    expect(postings.map((p) => p.externalId)).toEqual(GH_KEPT);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).not.toHaveProperty("If-None-Match");
    expect(requests[0]?.headers.Accept).toBe("application/json");
    expect(lastLog(logs, "ats board")).toEqual([
      { channel: "greenhouse", company: "Example Labs", board: "examplelabs", outcome: "changed", fetched: 6, kept: 4 },
    ]);
    expect(lastLog(logs, "ats board listed duplicate ids")).toEqual([]);
    for (const p of postings) expect(rawPostingInputSchema.safeParse(p).success).toBe(true);
    // C1: the posting is stored verbatim inside the envelope
    const verbatim = (fixtureJson("greenhouse-board.json") as { jobs: unknown[] }).jobs[0];
    expect(postings[0]?.payload).toEqual({ source: { ats: "greenhouse", token: "examplelabs", companyName: "Example Labs" }, posting: verbatim });
    expect(postings[0]?.url).toBe("https://job-boards.greenhouse.io/examplelabs/jobs/6186419001");
    expect(postings[0]?.postedAt).toEqual(new Date("2026-09-14T10:42:28-04:00"));
    // and what is stored parses back into a valid draft with the company from companies.yaml
    for (const p of postings) expect(normalizedPostingDraftSchema.parse(channel.parse(p.payload)).companyName).toBe("Example Labs");
  });

  it("keeps everything of a watched company and obeys the toggle and the extra terms", async () => {
    const answer = () => response(200, fixtureJson("greenhouse-board.json"));
    const run = async (watched: string[], edit: (b: Record<string, unknown>) => void) => {
      const { fetch } = routedFetch([[GH_URL, answer()]]);
      const { ctx, query } = atsContext("greenhouse", fetch, { channels: atsChannelsWith("greenhouse", edit) });
      return (await greenhouse({ watched }).channel.collect(query, ctx)).map((p) => p.externalId);
    };
    expect(await run(["example labs"], () => {})).toHaveLength(6);
    expect(await run([], (b) => { b.title_prefilter = { enabled: false, include_terms: [], exclude_terms: ["Intern"] }; })).toHaveLength(6);
    expect(await run([], (b) => { b.title_prefilter = { enabled: true, include_terms: [], exclude_terms: ["Intern"] }; })).toEqual(GH_KEPT.slice(0, 3));
    expect(await run([], (b) => { b.title_prefilter = { enabled: true, include_terms: ["Account Executive"], exclude_terms: [] }; })).toHaveLength(5);
  });

  it.each([2, 1, 0])("caps the postings kept per board at max_results with %i over-cap ids already stored", async (storedCount) => {
    const { fetch } = routedFetch([[GH_URL, response(200, fixtureJson("greenhouse-board.json"))]]);
    const channels = atsChannelsWith("greenhouse", (b) => { b.max_results = 2; });
    const { ctx, query, logs } = atsContext("greenhouse", fetch, { channels });
    const { channel, store } = greenhouse();
    const overCap = GH_KEPT.slice(2);
    const present = overCap.slice(0, storedCount);
    for (const id of present) store.stored.add(id);

    const postings = await channel.collect(query, ctx);

    expect(postings.map((p) => p.externalId)).toEqual(GH_KEPT.slice(0, 2));
    expect(store.touched).toEqual([overCap]);
    expect(store.checks.at(-1)?.update).toMatchObject({ status: "ok", externalIds: [...GH_KEPT.slice(0, 2), ...present], total: 6, kept: 2 });
    expect(lastLog(logs, "ats board capped at max_results")).toEqual([{ channel: "greenhouse", board: "examplelabs", dropped: 2, cap: 2, touched: storedCount }]);
    expect(lastLog(logs, "ats board")).toEqual([
      { channel: "greenhouse", company: "Example Labs", board: "examplelabs", outcome: "changed", fetched: 6, kept: 2, ...(storedCount > 0 ? { touched: storedCount } : {}) },
    ]);
  });

  it("does not count an already-stored posting rejected by the title prefilter as seen", async () => {
    const { channel, store } = greenhouse();
    const rejected = "6186419004";
    store.stored.add(rejected);
    for (const id of GH_KEPT.slice(2)) store.stored.add(id);
    const channels = atsChannelsWith("greenhouse", (b) => { b.max_results = 2; });
    const { ctx, query } = atsContext("greenhouse", routedFetch([[GH_URL, response(200, fixtureJson("greenhouse-board.json"))]]).fetch, { channels });

    await channel.collect(query, ctx);

    expect(store.touched).toEqual([GH_KEPT.slice(2)]);
    expect(store.touched.flat()).not.toContain(rejected);
    expect(store.states.get("greenhouse:examplelabs")?.externalIds).toEqual(GH_KEPT);
    expect(store.states.get("greenhouse:examplelabs")?.externalIds).not.toContain(rejected);
  });

  it("hands over a repeated id once and keeps its first occurrence", async () => {
    const body = { jobs: [{ id: 7, title: "AI Engineer" }, { id: 7, title: "Machine Learning Engineer" }, { id: 8, title: "AI Engineer" }] };
    const { ctx, query, logs } = atsContext("greenhouse", routedFetch([[GH_URL, response(200, body)]]).fetch);
    const { channel, store } = greenhouse();

    const postings = await channel.collect(query, ctx);

    expect(postings.map((p) => p.externalId)).toEqual(["7", "8"]);
    expect(postings[0]?.payload).toMatchObject({ posting: { title: "AI Engineer" } });
    expect(store.checks.at(-1)?.update).toMatchObject({ total: 2, kept: 2, externalIds: ["7", "8"] });
    expect(lastLog(logs, "ats board")[0]).toMatchObject({ fetched: 3, kept: 2 });
    expect(logs.filter((l) => l.message === "ats board listed duplicate ids")).toMatchObject([
      { level: "warn", fields: { channel: "greenhouse", board: "examplelabs", count: 1 } },
    ]);
  });

  it("deduplicates before filtering and capping, while still counting postings without ids", async () => {
    const body = { jobs: [
      { id: 7, title: "Account Executive" },
      { id: 7, title: "AI Engineer" },
      { id: 8, title: "AI Engineer" },
      { id: 9, title: "AI Engineer" },
      { id: 9, title: "AI Engineer" },
      { title: "AI Engineer" },
    ] };
    const channels = atsChannelsWith("greenhouse", (b) => { b.max_results = 1; });
    const { ctx, query, logs } = atsContext("greenhouse", routedFetch([[GH_URL, response(200, body)]]).fetch, { channels });
    const { channel, store } = greenhouse();
    store.stored.add("7");
    store.stored.add("9");

    const postings = await channel.collect(query, ctx);

    expect(postings.map((p) => p.externalId)).toEqual(["8"]);
    expect(store.touched).toEqual([["9"]]);
    expect(store.checks.at(-1)?.update).toMatchObject({ total: 4, kept: 1, externalIds: ["8", "9"] });
    expect(lastLog(logs, "ats board listed duplicate ids")).toEqual([{ channel: "greenhouse", board: "examplelabs", count: 2 }]);
    expect(lastLog(logs, "ats board capped at max_results")).toEqual([{ channel: "greenhouse", board: "examplelabs", dropped: 1, cap: 1, touched: 1 }]);
  });

  it("only visits enabled boards of its own ATS, pausing between boards", async () => {
    const companies = [
      gh,
      company({ name: "Off", ats: "greenhouse", token: "off", enabled: false }),
      company({ name: "Second", ats: "greenhouse", token: "second" }),
      lv,
    ];
    const { fetch, requests } = routedFetch([["/v1/boards/", response(200, { jobs: [] })]]);
    const { ctx, query, sleeps } = atsContext("greenhouse", fetch);
    const postings = await greenhouse({ companies }).channel.collect(query, ctx);
    expect(postings).toEqual([]);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/boards/examplelabs/jobs", "/v1/boards/second/jobs"]);
    expect(sleeps).toHaveLength(1); // one throttle pause between two boards
  });

  it("returns nothing, without a request, when no board is configured", async () => {
    const { fetch, requests } = routedFetch([]);
    const { ctx, query } = atsContext("greenhouse", fetch);
    expect(await greenhouse({ companies: [lv] }).channel.collect(query, ctx)).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("skips postings without an id and keeps the rest of the board", async () => {
    const body = { jobs: [{ title: "AI Engineer" }, { id: 7, title: "AI Engineer" }, { id: 8 }] };
    const { fetch } = routedFetch([[GH_URL, response(200, body)]]);
    const { ctx, query, logs } = atsContext("greenhouse", fetch);
    const postings = await greenhouse().channel.collect(query, ctx);
    // id 8 has no title: it cannot be judged, so it is kept and flagged by parse later (C1)
    expect(postings.map((p) => p.externalId)).toEqual(["7", "8"]);
    expect(() => greenhouse().channel.parse(postings[1]?.payload)).toThrow(ChannelError);
    expect(lastLog(logs, "ats board postings without an id skipped")).toEqual([{ channel: "greenhouse", board: "examplelabs", count: 1 }]);
  });
});

describe("conditional requests (ETag)", () => {
  const ok = () => response(200, fixtureJson("greenhouse-board.json"), { ETag: 'W/"v1"' });

  it("stores the ETag with the kept ids and sends it as If-None-Match next time", async () => {
    const first = routedFetch([[GH_URL, ok()]]);
    const a = atsContext("greenhouse", first.fetch);
    const { channel, store } = greenhouse();
    await channel.collect(a.query, a.ctx);
    expect(store.states.get("greenhouse:examplelabs")).toMatchObject({ etag: 'W/"v1"', externalIds: GH_KEPT });
    expect(store.checks[0]?.update).toMatchObject({ status: "ok", total: 6, kept: 4 });

    const second = routedFetch([[GH_URL, response(304, null, { ETag: 'W/"v1"' })]]);
    const b = atsContext("greenhouse", second.fetch);
    const postings = await channel.collect(b.query, b.ctx);
    expect(second.requests[0]?.headers["If-None-Match"]).toBe('W/"v1"');
    expect(postings).toEqual([]);
  });

  it("304 is 'unchanged': the board succeeds with fetched=0, its postings are touched, nothing fails", async () => {
    const { channel, store } = greenhouse();
    const first = atsContext("greenhouse", routedFetch([[GH_URL, ok()]]).fetch);
    await channel.collect(first.query, first.ctx);

    const calls = routedFetch([[GH_URL, response(304)]]);
    const second = atsContext("greenhouse", calls.fetch);
    const postings = await channel.collect(second.query, second.ctx); // does not throw
    expect(postings).toEqual([]);
    expect(calls.requests).toHaveLength(1);
    expect(store.touched.at(-1)).toEqual(GH_KEPT); // still seen, so the lifecycle must not age them out
    expect(store.checks.at(-1)).toMatchObject({ update: { status: "not_modified" } });
    expect(store.states.get("greenhouse:examplelabs")?.etag).toBe('W/"v1"'); // validator kept
    expect(lastLog(second.logs, "ats board")).toEqual([
      { channel: "greenhouse", company: "Example Labs", board: "examplelabs", outcome: "not_modified", fetched: 0, kept: 0 },
    ]);
    expect(lastLog(second.logs, "ats sweep done")[0]).toMatchObject({ boards: 1, failedBoards: 0 });
  });

  it.each([2, 1, 0])("keeps %i stored over-cap ids seen on a later 304 without refetching", async (storedCount) => {
    const { channel, store } = greenhouse();
    const present = GH_KEPT.slice(2, 2 + storedCount);
    for (const id of present) store.stored.add(id);
    const channels = atsChannelsWith("greenhouse", (b) => { b.max_results = 2; });
    const calls = routedFetch([[GH_URL, (req) => req.headers["If-None-Match"] ? response(304) : ok()]]);
    const first = atsContext("greenhouse", calls.fetch, { channels });
    await channel.collect(first.query, first.ctx);

    const second = atsContext("greenhouse", calls.fetch, { channels });
    expect(await channel.collect(second.query, second.ctx)).toEqual([]);

    expect(calls.requests).toHaveLength(2);
    expect(calls.requests[1]?.headers["If-None-Match"]).toBe('W/"v1"');
    expect(store.touched.at(-1)).toEqual([...GH_KEPT.slice(0, 2), ...present]);
    expect(store.checks.at(-1)?.update).toEqual({ status: "not_modified" });
  });

  it("a 304 in a sweep with other boards does not stop them", async () => {
    const companies = [gh, company({ name: "Second", ats: "greenhouse", token: "second" })];
    const { channel, store } = greenhouse({ companies });
    store.states.set("greenhouse:examplelabs", { etag: 'W/"v1"', filterFingerprint: null, externalIds: [] });
    const seed = atsContext("greenhouse", routedFetch([["/v1/boards/", ok()]]).fetch);
    await channel.collect(seed.query, seed.ctx);

    const { fetch } = routedFetch([
      ["/examplelabs/", response(304)],
      ["/second/", response(200, { jobs: [{ id: 99, title: "LLM Engineer" }] })],
    ]);
    const { ctx, query } = atsContext("greenhouse", fetch);
    const postings = await channel.collect(query, ctx);
    expect(postings.map((p) => p.externalId)).toEqual(["99"]);
  });

  it("ignores an ETag earned under other filter rules (config changed since)", async () => {
    const { channel, store } = greenhouse();
    const first = atsContext("greenhouse", routedFetch([[GH_URL, ok()]]).fetch);
    await channel.collect(first.query, first.ctx);

    const changed = atsChannelsWith("greenhouse", (b) => { b.title_prefilter = { enabled: true, include_terms: ["Account Executive"], exclude_terms: [] }; });
    const second = routedFetch([[GH_URL, ok()]]);
    const ctx2 = atsContext("greenhouse", second.fetch, { channels: changed });
    const postings = await channel.collect(ctx2.query, ctx2.ctx);
    expect(second.requests[0]?.headers).not.toHaveProperty("If-None-Match");
    expect(postings).toHaveLength(5);
    expect(store.checks).toHaveLength(2);
  });

  it("refetches unconditionally when a 304 would hide postings that never reached raw_postings", async () => {
    const { channel, store } = greenhouse();
    const first = atsContext("greenhouse", routedFetch([[GH_URL, ok()]]).fetch);
    await channel.collect(first.query, first.ctx);
    store.stored.delete("6186419002"); // the earlier cycle died before storing it

    const calls = routedFetch([
      [GH_URL, (req) => (req.headers["If-None-Match"] ? response(304) : response(200, fixtureJson("greenhouse-board.json"), { ETag: 'W/"v1"' }))],
    ]);
    const second = atsContext("greenhouse", calls.fetch);
    const postings = await channel.collect(second.query, second.ctx);
    expect(calls.requests.map((r) => "If-None-Match" in r.headers)).toEqual([true, false]);
    expect(postings.map((p) => p.externalId)).toEqual(GH_KEPT);
    expect(lastLog(second.logs, "ats board unchanged but stored postings are missing; refetching")).toHaveLength(1);
  });

  it("discards validators remembered under the old fingerprint format", async () => {
    const { channel, store } = greenhouse();
    const first = atsContext("greenhouse", routedFetch([[GH_URL, ok()]]).fetch);
    await channel.collect(first.query, first.ctx);
    const state = store.states.get("greenhouse:examplelabs");
    expect(state?.filterFingerprint).toMatch(/^2:/);
    if (!state?.filterFingerprint) throw new Error("missing board fingerprint");
    store.states.set("greenhouse:examplelabs", { ...state, filterFingerprint: state.filterFingerprint.slice(2) });

    const calls = routedFetch([[GH_URL, ok()]]);
    const second = atsContext("greenhouse", calls.fetch);
    expect((await channel.collect(second.query, second.ctx)).map((p) => p.externalId)).toEqual(GH_KEPT);
    expect(calls.requests).toHaveLength(1);
    expect(calls.requests[0]?.headers).not.toHaveProperty("If-None-Match");
  });

  it("does not keep a validator from a partial (206) response", async () => {
    const { fetch } = routedFetch([[GH_URL, response(206, fixtureJson("greenhouse-board.json"), { ETag: 'W/"partial"' })]]);
    const { ctx, query, logs } = atsContext("greenhouse", fetch);
    const { channel, store } = greenhouse();
    const postings = await channel.collect(query, ctx);
    expect(postings).toHaveLength(4);
    expect(store.states.get("greenhouse:examplelabs")?.etag).toBeNull();
    expect(lastLog(logs, "ats board answered with a partial response")).toHaveLength(1);
  });

  it("a response without an ETag header stores no validator", async () => {
    const { fetch } = routedFetch([[GH_URL, response(200, fixtureJson("greenhouse-board.json"))]]);
    const { ctx, query } = atsContext("greenhouse", fetch);
    const { channel, store } = greenhouse();
    await channel.collect(query, ctx);
    expect(store.states.get("greenhouse:examplelabs")?.etag).toBeNull();
  });

  it("a 304 to an unconditional request is an error, not 'no change'", async () => {
    const { fetch } = routedFetch([[GH_URL, response(304)]]);
    const { ctx, query } = atsContext("greenhouse", fetch);
    await expect(greenhouse().channel.collect(query, ctx)).rejects.toMatchObject({ code: "unknown" });
  });

  it("dry runs neither read nor write board state and always fetch the whole board", async () => {
    const store = createMemoryAtsBoardStore();
    store.states.set("greenhouse:examplelabs", { etag: 'W/"v1"', filterFingerprint: "x", externalIds: ["1"] });
    const { fetch, requests } = routedFetch([[GH_URL, ok()]]);
    const { ctx, query } = atsContext("greenhouse", fetch, { cycleId: null });
    const postings = await greenhouse({ store }).channel.collect(query, ctx);
    expect(postings).toHaveLength(4);
    expect(requests[0]?.headers).not.toHaveProperty("If-None-Match");
    expect(store.checks).toHaveLength(0);
    expect(store.touched).toHaveLength(0);
  });
});

describe("board failures (C2)", () => {
  const two = [gh, company({ name: "Second", ats: "greenhouse", token: "second" })];

  it("a missing board (404) does not stop the other boards and is remembered as an error", async () => {
    const { fetch } = routedFetch([
      ["/examplelabs/", response(404, { status: 404, error: "Job not found" })],
      ["/second/", response(200, { jobs: [{ id: 5, title: "AI Engineer" }] })],
    ]);
    const { ctx, query, logs } = atsContext("greenhouse", fetch);
    const { channel, store } = greenhouse({ companies: two });
    const postings = await channel.collect(query, ctx);
    expect(postings.map((p) => p.externalId)).toEqual(["5"]);
    expect(store.checks[0]).toMatchObject({ key: { ats: "greenhouse", token: "examplelabs" }, update: { status: "error", errorCode: "not_found" } });
    expect(lastLog(logs, "ats sweep done")[0]).toMatchObject({ boards: 2, failedBoards: 1, postings: 1 });
  });

  it("a server error or a bad shape on one board does not stop the others, and keeps its old ETag", async () => {
    const { channel, store } = greenhouse({ companies: two });
    store.states.set("greenhouse:examplelabs", { etag: 'W/"old"', filterFingerprint: "old", externalIds: ["1"] });
    const { fetch } = routedFetch([
      ["/examplelabs/", response(503, "unavailable")],
      ["/second/", response(200, { jobs: [{ id: 5, title: "AI Engineer" }] })],
    ]);
    const { ctx, query } = atsContext("greenhouse", fetch);
    expect((await channel.collect(query, ctx)).map((p) => p.externalId)).toEqual(["5"]);
    expect(store.states.get("greenhouse:examplelabs")?.etag).toBe('W/"old"');
    expect(store.checks[0]?.update).toMatchObject({ status: "error", errorCode: "network" });

    const bad = routedFetch([
      ["/examplelabs/", response(200, { unexpected: true })],
      ["/second/", response(200, { jobs: [] })],
    ]);
    const b = atsContext("greenhouse", bad.fetch);
    await expect(channel.collect(b.query, b.ctx)).resolves.toEqual([]);
    expect(store.checks.at(-2)?.update).toMatchObject({ status: "error", errorCode: "parse" });
  });

  it("fails the sweep with the first board's error only when every board failed", async () => {
    const { fetch } = routedFetch([
      ["/examplelabs/", response(429, "slow down")],
      ["/second/", response(503, "down")],
    ]);
    const { ctx, query } = atsContext("greenhouse", fetch);
    const error: unknown = await greenhouse({ companies: two }).channel.collect(query, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "rate_limited" });
  });

  it("a single board answering 404 fails the sweep (nothing was collected)", async () => {
    const { fetch } = routedFetch([[GH_URL, response(404, "{}")]]);
    const { ctx, query } = atsContext("greenhouse", fetch);
    await expect(greenhouse().channel.collect(query, ctx)).rejects.toMatchObject({ status: 404 });
  });

  it("stops at once when the cycle is cancelled", async () => {
    const abort = new AbortController();
    const { fetch, requests } = routedFetch([["/v1/boards/", () => { abort.abort(); return response(200, { jobs: [] }); }]]);
    const { ctx, query } = atsContext("greenhouse", fetch, { signal: abort.signal });
    await expect(greenhouse({ companies: two }).channel.collect(query, ctx)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("does not let a failing state store break the collection", async () => {
    const store = createMemoryAtsBoardStore();
    store.record = async () => { throw new Error("db down"); };
    const { fetch } = routedFetch([[GH_URL, response(200, fixtureJson("greenhouse-board.json"))]]);
    const { ctx, query, logs } = atsContext("greenhouse", fetch);
    expect(await greenhouse({ store }).channel.collect(query, ctx)).toHaveLength(4);
    expect(lastLog(logs, "could not record ats board state").length).toBeGreaterThan(0);
  });
});

describe("lever sweep", () => {
  const LEVER = "api.lever.co/v0/postings/examplecorp?mode=json";

  function lever(companies = [lv]) {
    const deps = depsWith(inputs(companies));
    return { channel: createLeverChannel(deps), store: deps.memory };
  }

  it("fetches the postings array and applies the same prefilter", async () => {
    const { fetch, requests } = routedFetch([[LEVER, response(200, fixtureJson("lever-postings.json"), { ETag: 'W/"l1"' })]]);
    const { ctx, query, logs } = atsContext("lever", fetch);
    const { channel, store } = lever();
    const postings = await channel.collect(query, ctx);
    expect(postings.map((p) => p.externalId)).toEqual(["a1b2c3d4-0000-4000-8000-000000000002", "a1b2c3d4-0000-4000-8000-000000000004"]);
    expect(requests[0]?.url).toBe(`https://${LEVER}`);
    expect(lastLog(logs, "ats board")[0]).toMatchObject({ outcome: "changed", fetched: 4, kept: 2 });
    expect(store.states.get("lever:examplecorp")?.etag).toBe('W/"l1"');
    expect(postings[0]?.url).toBe("https://jobs.eu.lever.co/examplecorp/a1b2c3d4-0000-4000-8000-000000000002");
    for (const p of postings) expect(normalizedPostingDraftSchema.safeParse(channel.parse(p.payload)).success).toBe(true);
  });

  it("uses the EU host for boards marked region: eu", async () => {
    const eu = company({ name: "Eu Corp", ats: "lever", token: "eucorp", region: "eu" });
    const { fetch, requests } = routedFetch([["api.eu.lever.co/v0/postings/eucorp", response(200, [])], ["api.lever.co/v0/postings/examplecorp", response(200, [])]]);
    const { ctx, query } = atsContext("lever", fetch);
    await lever([eu, lv]).channel.collect(query, ctx);
    expect(requests.map((r) => r.url)).toEqual([
      "https://api.eu.lever.co/v0/postings/eucorp?mode=json",
      "https://api.lever.co/v0/postings/examplecorp?mode=json",
    ]);
    // the region travels with the stored posting
    const kept = routedFetch([["api.eu.lever.co", response(200, [{ id: "z", text: "AI Engineer" }])]]);
    const k = atsContext("lever", kept.fetch);
    const [posting] = await lever([eu]).channel.collect(k.query, k.ctx);
    expect(posting?.payload).toMatchObject({ source: { ats: "lever", token: "eucorp", region: "eu" } });
  });

  it("hosts come from sources.yaml", async () => {
    const channels = atsChannelsWith("lever", (b) => { b.api_base_url = "https://lever.example.test/"; });
    const { fetch, requests } = routedFetch([["lever.example.test", response(200, [])]]);
    const { ctx, query } = atsContext("lever", fetch, { channels });
    await lever().channel.collect(query, ctx);
    expect(requests[0]?.url).toBe("https://lever.example.test/v0/postings/examplecorp?mode=json");
  });

  it("rejects a response that is not an array and handles 304", async () => {
    const bad = routedFetch([[LEVER, response(200, { ok: false })]]);
    const a = atsContext("lever", bad.fetch);
    await expect(lever().channel.collect(a.query, a.ctx)).rejects.toMatchObject({ code: "parse" });

    const { channel, store } = lever();
    const first = atsContext("lever", routedFetch([[LEVER, response(200, fixtureJson("lever-postings.json"), { ETag: 'W/"l1"' })]]).fetch);
    await channel.collect(first.query, first.ctx);
    const second = routedFetch([[LEVER, response(304)]]);
    const b = atsContext("lever", second.fetch);
    expect(await channel.collect(b.query, b.ctx)).toEqual([]);
    expect(second.requests[0]?.headers["If-None-Match"]).toBe('W/"l1"');
    expect(store.checks.at(-1)?.update.status).toBe("not_modified");
  });
});
