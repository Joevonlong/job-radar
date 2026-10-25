// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BudgetExceededError, ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { sessionPayloadSchema } from "@/lib/channels/linkedin/session/payload";
import { createMemorySessionStore } from "@/lib/channels/linkedin/session/store";
import { normalizedPostingDraftSchema, type KnownPostings } from "@/lib/channels/types";

import { DETAIL_PAGES, berlinQuery, fixture, happySite, harness, remoteQuery, setup, sessionConfig } from "./helpers";

async function failure(promise: Promise<unknown>): Promise<ChannelError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChannelError) return error;
    throw error;
  }
  throw new Error("expected a ChannelError");
}

/** Await a collect that must end in a `PartialCollectError`; any other outcome fails the test. */
async function partial(promise: Promise<unknown>): Promise<PartialCollectError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PartialCollectError) return error;
    throw error;
  }
  throw new Error("expected a PartialCollectError");
}

const DAY = "2026-10-07";

/** The raw payloads a normal run delivers, by job id: what an earlier run would have left in the database. */
async function deliveredBefore(): Promise<Map<string, unknown>> {
  const first = setup();
  const out = await first.session.collect(berlinQuery(), (await harness(first.session, first.config)).ctx);
  return new Map(out.map((o) => [o.externalId, o.payload]));
}

const viewedJobs = (s: ReturnType<typeof setup>): string[] => s.browser.log.loads.map((l) => new URL(l.url).pathname).filter((p) => p.startsWith("/jobs/view/"));
const listPages = (s: ReturnType<typeof setup>): number => s.browser.log.loads.filter((l) => new URL(l.url).pathname.startsWith("/jobs/search/")).length;
const detailFails = (id: string, answer: { timeout?: true; html?: string; status?: number } = { timeout: true }) => (url: URL) => (url.pathname.includes(id) ? { html: "", ...answer } : null);
const SECOND_PAGE_FAILS = (url: URL) => (url.searchParams.get("start") === "25" ? { html: "", timeout: true } : null);

describe("linkedin-session: search", () => {
  it("opens the search page, then the page of every new posting, and delivers one raw posting per job", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    const out = await s.session.collect(berlinQuery(), h.ctx);

    // 101 (Hybrid, Easy Apply), 102 (German), 104 (JSON-LD only); 103 is closed, 106 is gone
    expect(out.map((o) => o.externalId)).toEqual(["4385000101", "4385000102", "4385000104"]);
    expect(out[0]).toMatchObject({ url: "https://www.linkedin.com/jobs/view/4385000101/" });
    expect(out[0]?.postedAt?.toISOString()).toBe("2026-10-07T05:41:00.000Z");
    for (const posting of out) {
      expect(sessionPayloadSchema.safeParse(posting.payload).success).toBe(true);
      const draft = normalizedPostingDraftSchema.parse(s.session.parse(posting.payload));
      expect(draft.sourceUrl).toBe(posting.url);
    }

    const urls = s.browser.log.loads.map((l) => new URL(l.url));
    expect(urls.map((u) => u.pathname)).toEqual(["/jobs/search/", "/jobs/search/", "/jobs/view/4385000101/", "/jobs/view/4385000102/", "/jobs/view/4385000103/", "/jobs/view/4385000104/", "/jobs/view/4385000106/"]);
    expect(s.browser.log.loads.map((l) => l.scrollList)).toEqual([true, true, false, false, false, false, false]);
    expect(s.browser.log.opened).toHaveLength(1);
    expect(s.browser.log.closed).toBe(1);
  });

  it("builds the search URL from the query: OR-merged keywords, city + country, the look-back window, newest first", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    await s.session.collect(berlinQuery({ windowHours: 10 }), h.ctx);
    const first = new URL(s.browser.log.loads[0]?.url ?? "");
    expect(first.origin + first.pathname).toBe("https://www.linkedin.com/jobs/search/");
    expect(first.searchParams.get("keywords")).toBe('"AI Engineer" OR "LLM Engineer"');
    expect(first.searchParams.get("location")).toBe("Berlin, Germany");
    expect(first.searchParams.get("f_TPR")).toBe("r36000");
    expect(first.searchParams.get("sortBy")).toBe("DD");
    expect(first.searchParams.has("f_WT")).toBe(false);
    expect(new URL(s.browser.log.loads[1]?.url ?? "").searchParams.get("start")).toBe("25");
  });

  it("asks for remote work and the configured remote location for a remote query", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    await s.session.collect(remoteQuery(), h.ctx);
    const first = new URL(s.browser.log.loads[0]?.url ?? "");
    expect(first.searchParams.get("f_WT")).toBe("2");
    expect(first.searchParams.get("location")).toBe("Germany");
  });

  it("never reads more postings than the query allows", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    const out = await s.session.collect(berlinQuery({ maxResults: 2 }), h.ctx);
    expect(out.map((o) => o.externalId)).toEqual(["4385000101", "4385000102"]);
    expect(s.browser.log.loads.map((l) => new URL(l.url).pathname)).toEqual(["/jobs/search/", "/jobs/view/4385000101/", "/jobs/view/4385000102/"]);
  });

  it("waits between page loads with the channel's throttle (not before the first one)", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    await s.session.collect(berlinQuery(), h.ctx);
    expect(h.throttles).toBe(s.browser.log.loads.length - 1);
  });

  it("does not open the page of a posting it already holds: the stored payload is delivered again as it is", async () => {
    const first = setup();
    const out = await first.session.collect(berlinQuery(), (await harness(first.session, first.config)).ctx);
    const store = createMemorySessionStore({ payloads: { "4385000101": out[0]?.payload, "4385000102": out[1]?.payload } });
    const s = setup({ store });
    const h = await harness(s.session, s.config);
    const again = await s.session.collect(berlinQuery(), h.ctx);

    expect(again.map((o) => o.externalId)).toEqual(["4385000101", "4385000102", "4385000104"]);
    expect(again[0]?.payload).toEqual(out[0]?.payload); // verbatim: the hash does not change
    const opened = s.browser.log.loads.map((l) => new URL(l.url).pathname).filter((p) => p.startsWith("/jobs/view/"));
    expect(opened).toEqual(["/jobs/view/4385000103/", "/jobs/view/4385000104/", "/jobs/view/4385000106/"]);
  });

  it("without detail fetching, delivers the list cards only", async () => {
    const s = setup({ config: sessionConfig((session) => (session.fetch_details = false)) });
    const h = await harness(s.session, s.config);
    const out = await s.session.collect(berlinQuery(), h.ctx);
    expect(out.map((o) => o.externalId)).toEqual(["4385000101", "4385000102", "4385000103", "4385000104"]); // the id-only card has no title
    expect(s.browser.log.loads.every((l) => new URL(l.url).pathname === "/jobs/search/")).toBe(true);
    expect(sessionPayloadSchema.parse(out[0]?.payload).detailFetched).toBe(false);
  });

  it("keeps the list card when a posting page has no readable content", async () => {
    const s = setup({ site: happySite({ detail: (url) => (url.pathname.includes("4385000101") ? { html: fixture("layout-unknown.html") } : null) }) });
    const h = await harness(s.session, s.config);
    const out = await s.session.collect(berlinQuery(), h.ctx);
    expect(out.map((o) => o.externalId)).toEqual(["4385000101", "4385000102", "4385000104"]);
    expect(sessionPayloadSchema.parse(out[0]?.payload)).toMatchObject({ title: "Senior AI Engineer", detailFetched: false });
    expect(h.warnings.map((w) => w.message)).toContain("some posting pages had no readable content; their list card data was kept");
  });

  it("an empty result page is an answer: no postings, no error", async () => {
    const s = setup({ site: happySite({ search: () => ({ html: fixture("search-results-empty.html") }) }) });
    const h = await harness(s.session, s.config);
    expect(await s.session.collect(berlinQuery(), h.ctx)).toEqual([]);
    expect(s.browser.log.loads).toHaveLength(1);
  });

  it("a result page with neither cards nor the empty-results text is a layout change: a parse error, so the cascade moves on", async () => {
    const s = setup({ site: happySite({ search: () => ({ html: fixture("layout-unknown.html") }) }) });
    const h = await harness(s.session, s.config);
    const error = await failure(s.session.collect(berlinQuery(), h.ctx));
    expect(error).toMatchObject({ code: "parse", retryable: false });
  });

  it("when no posting page can be read at all, it is a parse error too (not a silent empty result)", async () => {
    const s = setup({ config: sessionConfig(() => {}), site: happySite({ search: () => ({ html: fixture("search-results.html").replace(/<a [^>]*job-card-list__title--link[^>]*>[\s\S]*?<\/a>/g, "") }), detail: () => ({ html: fixture("layout-unknown.html") }) }) });
    const h = await harness(s.session, s.config);
    expect(await failure(s.session.collect(berlinQuery(), h.ctx))).toMatchObject({ code: "parse" });
  });
});

describe("linkedin-session: the daily page limit", () => {
  const limited = (limit: number) => sessionConfig((session) => (session.daily_request_limit = limit));

  it("counts every page load against the day and persists it", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    await s.session.collect(berlinQuery(), h.ctx);
    expect(s.store.requests.get(DAY)).toBe(s.browser.log.loads.length);
  });

  it("skips (budget) when the day's limit is already used up, without opening a browser", async () => {
    const store = createMemorySessionStore({ requests: { [DAY]: 200 } });
    const s = setup({ store });
    const h = await harness(s.session, s.config);
    const error = await failure(s.session.collect(berlinQuery(), h.ctx));
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(s.browser.log.opened).toHaveLength(0);
  });

  it("the limit hitting while reading postings is a planned budget stop: what was read is handed over with it, not returned as a complete result", async () => {
    const s = setup({ config: limited(4), store: createMemorySessionStore({ requests: { [DAY]: 1 } }) });
    const h = await harness(s.session, s.config);
    const error = await partial(s.session.collect(berlinQuery(), h.ctx));
    // 3 loads left: the search page, the next search page, then one posting page
    expect(s.browser.log.loads).toHaveLength(3);
    expect(error.planned).toBe(true);
    expect(error.cause).toBeInstanceOf(BudgetExceededError);
    expect(error.cause).toMatchObject({ code: "budget_exceeded" });
    expect(error.postings.map((o) => o.externalId)).toEqual(["4385000101"]);
    expect(s.store.requests.get(DAY)).toBe(4);
    expect(h.warnings.find((w) => w.message === "daily page limit reached while reading postings; the rest waits for the next run")?.fields).toEqual({ limit: 4, kept: 1, skippedCards: 4 });
  });

  it("the limit is per calendar day in the schedule's time zone", async () => {
    const store = createMemorySessionStore({ requests: { "2026-10-06": 500 } });
    const s = setup({ store });
    const h = await harness(s.session, s.config);
    expect((await s.session.collect(berlinQuery(), h.ctx)).length).toBeGreaterThan(0);
  });

  it("a dry run reads for real but writes nothing: its counter is not persisted", async () => {
    const s = setup();
    const h = await harness(s.session, s.config, { cycleId: null });
    await s.session.collect(berlinQuery(), h.ctx);
    expect(s.store.requests.size).toBe(0);
    expect(s.store.flag).toBeNull();
  });
});

describe("linkedin-session: the daily page limit part way through a query", () => {
  const limited = (limit: number, edit: (session: Record<string, unknown>) => void = () => {}) =>
    sessionConfig((session) => {
      session.daily_request_limit = limit;
      edit(session);
    });
  const recommendedQuery = () => ({ ...berlinQuery(), keywords: [], keywordGroup: "*", location: null, maxResults: Number.MAX_SAFE_INTEGER });
  const capWarning = (h: Awaited<ReturnType<typeof harness>>, phase: "listing" | "postings") =>
    h.warnings.find((w) => w.message === (phase === "listing" ? "daily page limit reached while listing" : "daily page limit reached while reading postings; the rest waits for the next run"));

  it("while reading postings: the stored postings after the limit are still delivered, the ones that need a page are not opened", async () => {
    const before = await deliveredBefore();
    // 3 pages: both search pages and the posting 101; the limit refuses 102; 103 and 106 need a page too; 104 is stored
    const s = setup({ config: limited(3), store: createMemorySessionStore({ payloads: { "4385000104": before.get("4385000104") } }) });
    const h = await harness(s.session, s.config);
    const error = await partial(s.session.collect(berlinQuery(), h.ctx));
    expect(error.planned).toBe(true);
    expect(error.cause).toBeInstanceOf(BudgetExceededError);
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000104"]);
    expect(error.postings[1]?.payload).toEqual(before.get("4385000104"));
    expect(viewedJobs(s)).toEqual(["/jobs/view/4385000101/"]);
    expect(s.browser.log.loads).toHaveLength(3);
    expect(s.store.requests.get(DAY)).toBe(3);
    expect(capWarning(h, "postings")?.fields).toEqual({ limit: 3, kept: 2, skippedCards: 3 });
    expect(h.logs.find((l) => l.message === "linkedin session read finished")?.fields).toMatchObject({ delivered: 2, reused: 1, fetched: 1, skippedCards: 3 });
  });

  it("while listing, with every card the channel holds stored: the stored postings are delivered with the budget stop and no posting page is opened", async () => {
    const before = await deliveredBefore();
    const store = createMemorySessionStore({ payloads: Object.fromEntries(before) });
    // 1 page: the first search page; the second one is refused (the results fitted on one page, but that is only known after reading the next)
    const s = setup({ config: limited(1), store });
    const h = await harness(s.session, s.config);
    const error = await partial(s.session.collect(berlinQuery(), h.ctx));
    expect(error.planned).toBe(true);
    expect(error.cause).toMatchObject({ code: "budget_exceeded" });
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102", "4385000104"]);
    expect(viewedJobs(s)).toEqual([]);
    expect(listPages(s)).toBe(1);
    // 103 and 106 were never delivered, so they are not stored: they need their page and wait for the next run
    expect(capWarning(h, "listing")?.fields).toEqual({ limit: 1, kept: 3, skippedCards: 2 });
  });

  it("while listing, with every selected card stored: all of them are kept with the budget stop, none is skipped, and no posting page is opened", async () => {
    const before = await deliveredBefore();
    // 103 and 106 are closed or gone today; an earlier run held them while they were still open
    const heldEarlier = (id: string) => ({ ...(before.get("4385000101") as Record<string, unknown>), jobId: id, url: `https://www.linkedin.com/jobs/view/${id}/` });
    const store = createMemorySessionStore({ payloads: { ...Object.fromEntries(before), "4385000103": heldEarlier("4385000103"), "4385000106": heldEarlier("4385000106") } });
    const s = setup({ config: limited(1), store });
    const h = await harness(s.session, s.config);
    const error = await partial(s.session.collect(berlinQuery(), h.ctx));
    expect(error.planned).toBe(true);
    expect(error.cause).toBeInstanceOf(BudgetExceededError);
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102", "4385000103", "4385000104", "4385000106"]);
    expect(viewedJobs(s)).toEqual([]);
    expect(listPages(s)).toBe(1);
    expect(capWarning(h, "listing")?.fields).toEqual({ limit: 1, kept: 5, skippedCards: 0 });
  });

  describe("while listing a query of two keyword pieces", () => {
    // two keywords that do not fit into one search string: two pieces, searched one after another
    const twoPieces = () => berlinQuery({ keywords: ["A".repeat(150), "B".repeat(150)] });
    const piecesRequested = (s: ReturnType<typeof setup>) =>
      s.browser.log.loads.filter((l) => new URL(l.url).pathname === "/jobs/search/").map((l) => (new URL(l.url).searchParams.get("keywords")?.includes("BBBB") ? "B" : "A"));

    it("the limit in the first piece: the later piece's list pages are never requested, and the held cards read so far are delivered with the budget stop", async () => {
      const before = await deliveredBefore();
      // 2 pages: both list pages of the first piece; the limit refuses the first list page of the second piece
      const s = setup({ config: limited(2), store: createMemorySessionStore({ payloads: Object.fromEntries(before) }) });
      const h = await harness(s.session, s.config);
      const error = await partial(s.session.collect(twoPieces(), h.ctx));
      expect(piecesRequested(s)).toEqual(["A", "A"]);
      expect(error.planned).toBe(true);
      expect(error.cause).toBeInstanceOf(BudgetExceededError);
      expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102", "4385000104"]);
      expect(viewedJobs(s)).toEqual([]);
      expect(capWarning(h, "listing")?.fields).toEqual({ limit: 2, kept: 3, skippedCards: 2 });
    });

    it("the limit in the first piece with nothing held: the plain budget error, and neither the later piece nor a posting page is requested", async () => {
      const s = setup({ config: limited(1) });
      const h = await harness(s.session, s.config);
      const error = await failure(s.session.collect(twoPieces(), h.ctx));
      expect(error).not.toBeInstanceOf(PartialCollectError);
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect(piecesRequested(s)).toEqual(["A"]);
      expect(viewedJobs(s)).toEqual([]);
      // the cards read went through the postings phase: all five needed a page and were left for the next run
      expect(capWarning(h, "listing")?.fields).toEqual({ limit: 1, kept: 0, skippedCards: 5 });
    });
  });

  it("while listing, without detail fetching: the cards read so far are delivered with the budget stop", async () => {
    const s = setup({ config: limited(1, (session) => (session.fetch_details = false)) });
    const h = await harness(s.session, s.config);
    const error = await partial(s.session.collect(berlinQuery(), h.ctx));
    expect(error.planned).toBe(true);
    expect(error.cause).toMatchObject({ code: "budget_exceeded" });
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102", "4385000103", "4385000104"]);
    expect(viewedJobs(s)).toEqual([]);
    expect(listPages(s)).toBe(1);
    expect(capWarning(h, "listing")?.fields).toEqual({ limit: 1, kept: 4, skippedCards: 0 });
  });

  it("while listing, with nothing deliverable: the plain budget error (nothing to hand over), and no posting page is opened", async () => {
    const s = setup({ config: limited(1) });
    const h = await harness(s.session, s.config);
    const error = await failure(s.session.collect(berlinQuery(), h.ctx));
    expect(error).not.toBeInstanceOf(PartialCollectError);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(viewedJobs(s)).toEqual([]);
    expect(s.browser.log.loads).toHaveLength(1);
  });

  it("while reading postings, with nothing delivered: the plain budget error", async () => {
    // 2 pages: both search pages; the limit refuses the first posting page
    const s = setup({ config: limited(2) });
    const h = await harness(s.session, s.config);
    const error = await failure(s.session.collect(berlinQuery(), h.ctx));
    expect(error).not.toBeInstanceOf(PartialCollectError);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(viewedJobs(s)).toEqual([]);
  });

  it("a posting page that cannot be read wins over the limit: with nothing delivered it is the parse error, not a budget stop", async () => {
    // cards without a title link (they cannot stand on their own) and a posting page in an unknown layout
    const site = happySite({ search: () => ({ html: fixture("search-results.html").replace(/<a [^>]*job-card-list__title--link[^>]*>[\s\S]*?<\/a>/g, "") }), detail: () => ({ html: fixture("layout-unknown.html") }) });
    // 3 pages: the search page (the next one has the same cards, nothing new), its next page, the unreadable posting 101; the limit refuses 102
    const s = setup({ config: limited(3), site });
    const h = await harness(s.session, s.config);
    const error = await failure(s.session.collect(berlinQuery(), h.ctx));
    expect(error).not.toBeInstanceOf(BudgetExceededError);
    expect(error).toMatchObject({ code: "parse" });
    expect(viewedJobs(s)).toEqual(["/jobs/view/4385000101/"]);
  });

  it("using up the limit exactly, with no further page tried, is a normal complete result", async () => {
    // a full read is 7 pages: 2 search pages, then 101, 102, 103, 104, 106
    const s = setup({ config: limited(7) });
    const h = await harness(s.session, s.config);
    const out = await s.session.collect(berlinQuery(), h.ctx);
    expect(out.map((o) => o.externalId)).toEqual(["4385000101", "4385000102", "4385000104"]);
    expect(s.store.requests.get(DAY)).toBe(7);
    expect(capWarning(h, "listing")).toBeUndefined();
    expect(capWarning(h, "postings")).toBeUndefined();
    // the next query is refused before a browser opens
    expect(await failure(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx))).toBeInstanceOf(BudgetExceededError);
    expect(s.browser.log.opened).toHaveLength(1);
  });

  it("the recommended list: a budget stop with postings marks the list as read (it is not read again that day)", async () => {
    // 3 pages: the recommended page, its next page, the posting 201; the limit refuses 202
    const s = setup({ config: limited(3) });
    const h = await harness(s.recommended, s.config, { id: "linkedin-session:recommended" });
    const error = await partial(s.recommended.collect(recommendedQuery(), h.ctx));
    expect(error.planned).toBe(true);
    expect(error.cause).toMatchObject({ code: "budget_exceeded" });
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000201"]);
    expect(s.store.recommendedAt).not.toBeNull();
  });

  it("the recommended list: a budget stop with nothing delivered does not mark the list as read", async () => {
    const s = setup({ config: limited(2) });
    const h = await harness(s.recommended, s.config, { id: "linkedin-session:recommended" });
    const error = await failure(s.recommended.collect(recommendedQuery(), h.ctx));
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(s.store.recommendedAt).toBeNull();
  });

  it("the recommended list: a dry run stopped by the limit does not mark the list as read", async () => {
    const s = setup({ config: limited(3) });
    const h = await harness(s.recommended, s.config, { id: "linkedin-session:recommended", cycleId: null });
    const error = await partial(s.recommended.collect(recommendedQuery(), h.ctx));
    expect(error.planned).toBe(true);
    expect(s.store.recommendedAt).toBeNull();
    expect(s.store.requests.size).toBe(0);
  });
});

describe("linkedin-session: login wall, verification and denial stop the run", () => {
  it("is 'not configured' without a login file, and refuses to browse if called anyway", async () => {
    const s = setup({ login: false });
    expect(s.session.isConfigured?.()).toBe(false);
    expect(s.recommended.isConfigured?.()).toBe(false);
    const h = await harness(s.session, s.config);
    expect(await failure(s.session.collect(berlinQuery(), h.ctx))).toMatchObject({ code: "auth_expired", retryable: false });
    expect(s.browser.log.opened).toHaveLength(0);
  });

  it("is configured with a login file", () => {
    expect(setup().session.isConfigured?.()).toBe(true);
  });

  it("a redirect to the sign-in page: auth_expired, circuit-tripping, login marked expired, and not one more page is loaded", async () => {
    const s = setup({ site: happySite({ search: () => ({ html: fixture("login-wall.html"), url: "https://www.linkedin.com/login?session_redirect=x" }) }) });
    const h = await harness(s.session, s.config);
    const error = await failure(s.session.collect(berlinQuery(), h.ctx));
    expect(error).toMatchObject({ code: "auth_expired", retryable: false, tripsCircuit: true });
    expect(error.message).toContain("pnpm auth:linkedin");
    expect(s.browser.log.loads).toHaveLength(1);
    expect(s.browser.log.closed).toBe(1);
    expect(s.store.flag).toMatchObject({ status: "expired", reason: "login_required" });
  });

  it("a verification page: blocked, circuit-tripping, login marked expired; nothing is touched and no further page is loaded", async () => {
    const s = setup({ site: happySite({ search: () => ({ html: fixture("checkpoint.html"), url: "https://www.linkedin.com/checkpoint/challenge/AgE" }) }) });
    const h = await harness(s.session, s.config);
    const error = await failure(s.session.collect(berlinQuery(), h.ctx));
    expect(error).toMatchObject({ code: "blocked", retryable: false, tripsCircuit: true });
    expect(s.browser.log.loads).toHaveLength(1);
    expect(s.store.flag).toMatchObject({ status: "expired", reason: "checkpoint" });
  });

  it("a verification page in the middle of reading postings stops at once and hands over the postings already read", async () => {
    const s = setup({ site: happySite({ detail: (url) => (url.pathname.includes("4385000102") ? { html: fixture("checkpoint.html") } : null) }) });
    const h = await harness(s.session, s.config);
    const error = await partial(s.session.collect(berlinQuery(), h.ctx));
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101"]);
    expect(error.cause).toMatchObject({ code: "blocked", retryable: false, tripsCircuit: true });
    // not one more page is loaded, the verification page itself is not touched again
    expect(viewedJobs(s)).toEqual(["/jobs/view/4385000101/", "/jobs/view/4385000102/"]);
    expect(s.store.flag).toMatchObject({ status: "expired", reason: "checkpoint" });
  });

  it("an auth wall page is a lost login as well", async () => {
    const s = setup({ site: happySite({ detail: () => ({ html: fixture("authwall.html") }) }) });
    const h = await harness(s.session, s.config);
    expect(await failure(s.session.collect(berlinQuery(), h.ctx))).toMatchObject({ code: "auth_expired", tripsCircuit: true });
  });

  it("HTTP 999 is a denial (blocked, circuit-tripping); 429 is rate limiting (retryable, not tripping)", async () => {
    const denied = setup({ site: happySite({ search: () => ({ html: "", status: 999 }) }) });
    expect(await failure(denied.session.collect(berlinQuery(), (await harness(denied.session, denied.config)).ctx))).toMatchObject({ code: "blocked", tripsCircuit: true, status: 999 });

    const limited = setup({ site: happySite({ search: () => ({ html: "", status: 429 }) }) });
    expect(await failure(limited.session.collect(berlinQuery(), (await harness(limited.session, limited.config)).ctx))).toMatchObject({ code: "rate_limited", retryable: true, tripsCircuit: false });
  });

  it("refuses to browse with a login a channel already found expired (no browser is opened), until the login file is newer", async () => {
    const store = createMemorySessionStore({ flag: { status: "expired", reason: "checkpoint", at: "2999-01-01T00:00:00.000Z" } });
    const s = setup({ store });
    const h = await harness(s.session, s.config);
    const error = await failure(s.session.collect(berlinQuery(), h.ctx));
    expect(error).toMatchObject({ code: "auth_expired", tripsCircuit: false });
    expect(s.browser.log.opened).toHaveLength(0);

    const redone = setup({ store: createMemorySessionStore({ flag: { status: "expired", reason: "checkpoint", at: "2000-01-01T00:00:00.000Z" } }) });
    expect((await redone.session.collect(berlinQuery(), (await harness(redone.session, redone.config)).ctx)).length).toBeGreaterThan(0);
  });

  it("refuses to browse when the session cookie has expired", async () => {
    const s = setup({ expires: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000) });
    const h = await harness(s.session, s.config);
    expect(await failure(s.session.collect(berlinQuery(), h.ctx))).toMatchObject({ code: "auth_expired" });
    expect(s.browser.log.opened).toHaveLength(0);
  });

  it("marks the login valid after the first normal page", async () => {
    const s = setup();
    await s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx);
    expect(s.store.flag?.status).toBe("valid");
  });

  it("a page that does not load is a network error (not mistaken for a cancelled cycle) and the browser is closed", async () => {
    const s = setup();
    const open = s.browser.open;
    const broken = {
      ...s,
      browser: {
        ...s.browser,
        open: async (options: Parameters<typeof open>[0]) => {
          const real = await open(options);
          return {
            ...real,
            load: async () => {
              const timeout = new Error("page.goto: net::ERR_TIMED_OUT at https://www.linkedin.com/jobs/search/?keywords=secret-term&location=Berlin\nCall log: ...");
              timeout.name = "TimeoutError";
              throw timeout;
            },
          };
        },
      },
    };
    // build a channel on the broken browser
    const { createSessionChannels } = await import("@/lib/channels/linkedin/session/channel");
    const { Mutex } = await import("@/lib/channels/linkedin/session/browser");
    const channels = createSessionChannels({ settings: () => s.config.linkedin.session, timeZone: () => "Europe/Berlin", recommendedSchedule: () => ({ enabled: true, cron: "0 7 * * *", timezone: "Europe/Berlin" }), store: () => s.store, openBrowser: broken.browser.open, now: () => new Date("2026-10-07T08:00:00Z"), authFile: () => s.authFile, mutex: new Mutex() });
    const error = await failure(channels.session.collect(berlinQuery(), (await harness(channels.session, s.config)).ctx));
    expect(error).toMatchObject({ code: "network", message: expect.stringContaining("net::ERR_TIMED_OUT at https://www.linkedin.com") });
    expect(error.message).not.toContain("Call log");
    expect(error.message).not.toContain("keywords=");
    expect(s.browser.log.closed).toBe(1);
  });
});

describe("linkedin-session:recommended", () => {
  it("reads the recommended list (one page, no query), tags the postings as recommended, and notes the run", async () => {
    const s = setup();
    const h = await harness(s.recommended, s.config, { id: "linkedin-session:recommended" });
    const out = await s.recommended.collect({ ...berlinQuery(), keywords: [], keywordGroup: "*", location: null, maxResults: Number.MAX_SAFE_INTEGER }, h.ctx);
    // 4385000103 is on the list too, but its page says it no longer takes applications
    expect(out.map((o) => o.externalId)).toEqual(["4385000201", "4385000202"]);
    expect(sessionPayloadSchema.parse(out[0]?.payload).source).toBe("recommended");
    expect(new URL(s.browser.log.loads[0]?.url ?? "").pathname).toBe("/jobs/collections/recommended/");
    expect(s.store.recommendedAt).not.toBeNull();
  });

  it("reads at most `recommended_max_results` postings", async () => {
    const s = setup({ config: sessionConfig((session) => (session.recommended_max_results = 1)) });
    const h = await harness(s.recommended, s.config, { id: "linkedin-session:recommended" });
    const out = await s.recommended.collect(berlinQuery({ maxResults: 99 }), h.ctx);
    expect(out).toHaveLength(1);
  });

  it("is not due without a login, or when disabled in schedule.yaml", async () => {
    expect(await setup({ login: false }).recommended.isDue?.({ kind: "weekday_morning", now: new Date("2026-10-07T07:00:30Z"), dryRun: false })).toBe(false);
    expect(await setup({ schedule: { enabled: false, cron: "0 7 * * *" } }).recommended.isDue?.({ kind: "weekday_morning", now: new Date("2026-10-07T07:00:30Z"), dryRun: false })).toBe(false);
  });

  it("is due in the first cycle after the day's slot that has not read it yet, then not again that day", async () => {
    const s = setup(); // slot: 07:00 Europe/Berlin = 05:00Z
    const due = (kind: "weekday_morning" | "weekday_evening" | "manual", now: string, dryRun = false) => s.recommended.isDue?.({ kind, now: new Date(now), dryRun });
    expect(await due("weekday_morning", "2026-10-07T05:00:20Z")).toBe(true); // never read
    s.store.recommendedAt = new Date("2026-10-07T05:01:00Z");
    expect(await due("weekday_evening", "2026-10-07T15:00:20Z")).toBe(false); // read today
    expect(await due("weekday_morning", "2026-10-08T05:00:20Z")).toBe(true); // next day's slot has passed
    expect(await due("weekday_morning", "2026-10-08T04:30:00Z")).toBe(false); // before the next slot
  });

  it("a manual cycle and a dry run always read it (when logged in)", async () => {
    const s = setup();
    s.store.recommendedAt = new Date("2026-10-07T05:01:00Z");
    expect(await s.recommended.isDue?.({ kind: "manual", now: new Date("2026-10-07T15:00:00Z"), dryRun: false })).toBe(true);
    expect(await s.recommended.isDue?.({ kind: "weekday_evening", now: new Date("2026-10-07T15:00:00Z"), dryRun: true })).toBe(true);
  });

  it("shares the daily page counter and the login state with the search channel", async () => {
    const s = setup();
    await s.session.collect(berlinQuery({ maxResults: 1 }), (await harness(s.session, s.config)).ctx);
    const after = s.store.requests.get(DAY) ?? 0;
    await s.recommended.collect(berlinQuery({ maxResults: 1 }), (await harness(s.recommended, s.config, { id: "linkedin-session:recommended" })).ctx);
    expect(s.store.requests.get(DAY)).toBeGreaterThan(after);
  });
});

it("all fixture detail pages used by the helpers exist", () => {
  expect(Object.keys(DETAIL_PAGES).length).toBeGreaterThan(5);
});

describe("linkedin-session: a failure part-way keeps what was read", () => {
  it("a posting page that does not load: the postings read and the stored ones after the failure are delivered, nothing more is loaded", async () => {
    const before = await deliveredBefore();
    const s = setup({ site: happySite({ detail: detailFails("4385000103") }), store: createMemorySessionStore({ payloads: { "4385000104": before.get("4385000104") } }) });
    const h = await harness(s.session, s.config);
    const error = await partial(s.session.collect(berlinQuery(), h.ctx));
    expect(error.cause).toBeInstanceOf(ChannelError);
    expect(error.cause).toMatchObject({ code: "network", retryable: true, tripsCircuit: false });
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102", "4385000104"]);
    expect(error.postings[2]?.payload).toEqual(before.get("4385000104"));
    // the failing page is the last one loaded (the posting after it is not opened), and it is counted for the day
    expect(viewedJobs(s)).toEqual(["/jobs/view/4385000101/", "/jobs/view/4385000102/", "/jobs/view/4385000103/"]);
    expect(s.store.requests.get(DAY)).toBe(s.browser.log.loads.length);
    expect(s.browser.log.closed).toBe(1);
    expect(h.logs.find((l) => l.message === "linkedin session read finished")?.fields).toMatchObject({ delivered: 3, interrupted: "network" });
  });

  it("a login wall in the middle of reading postings: auth_expired and circuit-tripping, the postings read are kept", async () => {
    const s = setup({ site: happySite({ detail: (url) => (url.pathname.includes("4385000102") ? { html: fixture("authwall.html") } : null) }) });
    const error = await partial(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
    expect(error.cause).toMatchObject({ code: "auth_expired", retryable: false, tripsCircuit: true });
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101"]);
    expect(viewedJobs(s)).toEqual(["/jobs/view/4385000101/", "/jobs/view/4385000102/"]);
    expect(s.store.flag).toMatchObject({ status: "expired" });
  });

  it("HTTP 429 in the middle of reading postings: rate_limited, retryable and not circuit-tripping, the postings read are kept", async () => {
    const s = setup({ site: happySite({ detail: detailFails("4385000102", { status: 429 }) }) });
    const error = await partial(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
    expect(error.cause).toMatchObject({ code: "rate_limited", retryable: true, tripsCircuit: false, status: 429 });
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101"]);
    expect(viewedJobs(s)).toEqual(["/jobs/view/4385000101/", "/jobs/view/4385000102/"]);
  });

  it("a failing posting page is not replaced by its list card (the card would be taken for a finished posting next time)", async () => {
    const s = setup({ site: happySite({ detail: detailFails("4385000101") }) });
    const error = await failure(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
    expect(error).not.toBeInstanceOf(PartialCollectError);
    expect(error).toMatchObject({ code: "network" });
  });

  describe("the second result page fails", () => {
    it("with detail fetching, only the postings already held are delivered and no posting page is opened", async () => {
      const before = await deliveredBefore();
      const store = createMemorySessionStore({ payloads: { "4385000101": before.get("4385000101"), "4385000102": before.get("4385000102") } });
      const s = setup({ store, site: happySite({ search: SECOND_PAGE_FAILS }) });
      const error = await partial(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
      expect(error.cause).toMatchObject({ code: "network", retryable: true });
      expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102"]);
      expect(viewedJobs(s)).toEqual([]);
      expect(listPages(s)).toBe(2);
    });

    it("without detail fetching, every card of the first page is delivered", async () => {
      const s = setup({ config: sessionConfig((session) => (session.fetch_details = false)), site: happySite({ search: SECOND_PAGE_FAILS }) });
      const error = await partial(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
      expect(error.cause).toMatchObject({ code: "network" });
      expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102", "4385000103", "4385000104"]);
      expect(viewedJobs(s)).toEqual([]);
    });

    it("with detail fetching and nothing held, the plain failure is thrown (there is nothing to hand over) and no posting page is opened", async () => {
      const s = setup({ site: happySite({ search: SECOND_PAGE_FAILS }) });
      const error = await failure(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
      expect(error).not.toBeInstanceOf(PartialCollectError);
      expect(error).toMatchObject({ code: "network", retryable: true });
      expect(viewedJobs(s)).toEqual([]);
    });

    it("cards that cannot be turned into postings do not hide the failure: it is the network error, not a parse error", async () => {
      const noCompany = fixture("search-results.html").replace(/<div class="artdeco-entity-lockup__subtitle[^>]*>[\s\S]*?<\/div>/g, "");
      const s = setup({
        config: sessionConfig((session) => (session.fetch_details = false)),
        site: happySite({ search: (url) => (url.searchParams.get("start") === "25" ? { html: "", timeout: true } : { html: noCompany }) }),
      });
      const error = await failure(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
      expect(error).not.toBeInstanceOf(PartialCollectError);
      expect(error).toMatchObject({ code: "network", retryable: true });
    });

    it("a result page that is blocked (HTTP 999) after the first one: circuit-tripping, the stored postings are kept", async () => {
      const before = await deliveredBefore();
      const s = setup({ store: createMemorySessionStore({ payloads: { "4385000101": before.get("4385000101") } }), site: happySite({ search: (url) => (url.searchParams.get("start") === "25" ? { html: "", status: 999 } : null) }) });
      const error = await partial(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
      expect(error.cause).toMatchObject({ code: "blocked", tripsCircuit: true, retryable: false });
      expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101"]);
    });
  });

  describe("the first page of the second keyword piece has a changed layout", () => {
    // two keywords that do not fit into one search string: two pieces, searched one after another
    const twoPieces = () => berlinQuery({ keywords: ["A".repeat(150), "B".repeat(150)] });
    const site = () => happySite({ search: (url) => (url.searchParams.get("keywords")?.includes("BBBB") ? { html: fixture("layout-unknown.html") } : null) });

    it("with held postings, they are delivered with the parse failure", async () => {
      const before = await deliveredBefore();
      const store = createMemorySessionStore({ payloads: { "4385000101": before.get("4385000101"), "4385000102": before.get("4385000102") } });
      const s = setup({ store, site: site() });
      const error = await partial(s.session.collect(twoPieces(), (await harness(s.session, s.config)).ctx));
      expect(error.cause).toMatchObject({ code: "parse", retryable: false });
      expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102"]);
      expect(viewedJobs(s)).toEqual([]);
    });

    it("without detail fetching, the cards of the first piece are delivered with the parse failure", async () => {
      const s = setup({ config: sessionConfig((session) => (session.fetch_details = false)), site: site() });
      const error = await partial(s.session.collect(twoPieces(), (await harness(s.session, s.config)).ctx));
      expect(error.cause).toMatchObject({ code: "parse" });
      expect(error.postings).toHaveLength(4);
    });

    it("with detail fetching and nothing held, the plain parse error is thrown", async () => {
      const s = setup({ site: site() });
      const error = await failure(s.session.collect(twoPieces(), (await harness(s.session, s.config)).ctx));
      expect(error).not.toBeInstanceOf(PartialCollectError);
      expect(error).toMatchObject({ code: "parse" });
      expect(viewedJobs(s)).toEqual([]);
    });
  });

  it("the page that uses up the day's limit fails: the failure is the network error, not a budget error, and the next call is refused before a browser opens", async () => {
    // 2 search pages + postings 101, 102 and the failing 103 = the 5th and last page of the day
    const s = setup({ config: sessionConfig((session) => (session.daily_request_limit = 5)), site: happySite({ detail: detailFails("4385000103") }) });
    const error = await partial(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
    expect(error.cause).not.toBeInstanceOf(BudgetExceededError);
    expect(error.cause).toMatchObject({ code: "network" });
    expect(error.planned).toBe(false);
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101", "4385000102"]);
    expect(s.store.requests.get(DAY)).toBe(5);

    expect(await failure(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx))).toBeInstanceOf(BudgetExceededError);
    expect(s.browser.log.opened).toHaveLength(1);
    expect(s.browser.log.loads).toHaveLength(5);
  });

  it("a failure of the very first result page stays a plain failure", async () => {
    const s = setup({ site: happySite({ search: () => ({ html: "", timeout: true }) }) });
    const error = await failure(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx));
    expect(error).not.toBeInstanceOf(PartialCollectError);
    expect(error).toMatchObject({ code: "network" });
    expect(s.browser.log.closed).toBe(1);
  });

  it("a cancelled cycle is not turned into a partial result", async () => {
    const controller = new AbortController();
    const s = setup({
      site: happySite({
        detail: (url) => {
          if (!url.pathname.includes("4385000102")) return null;
          controller.abort();
          return { html: "", timeout: true };
        },
      }),
    });
    const h = await harness(s.session, s.config);
    const error = await s.session.collect(berlinQuery(), { ...h.ctx, signal: controller.signal }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(PartialCollectError);
    expect(error).not.toBeInstanceOf(ChannelError);
    expect(s.browser.log.closed).toBe(1);
  });

  it("a failure of the channel's own bookkeeping (the page counter) is thrown as it is, not wrapped", async () => {
    const boom = new Error("counter write failed");
    const base = createMemorySessionStore();
    const addRequest = base.addRequest.bind(base);
    const store = Object.assign(base, {
      addRequest: async (day: string) => {
        if (base.requests.get(day) === 3) throw boom;
        return addRequest(day);
      },
    });
    const s = setup({ store });
    await expect(s.session.collect(berlinQuery(), (await harness(s.session, s.config)).ctx)).rejects.toBe(boom);
  });

  it("the recommended list: a posting page failing part-way keeps the postings read and does not mark the list as read", async () => {
    const s = setup({ site: happySite({ detail: detailFails("4385000202") }) });
    const h = await harness(s.recommended, s.config, { id: "linkedin-session:recommended" });
    const error = await partial(s.recommended.collect({ ...berlinQuery(), keywords: [], keywordGroup: "*", location: null, maxResults: Number.MAX_SAFE_INTEGER }, h.ctx));
    expect(error.cause).toMatchObject({ code: "network" });
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000201"]);
    expect(s.store.recommendedAt).toBeNull();
  });

  it("a dry run that fails part-way reports what it read and persists nothing", async () => {
    const s = setup({ site: happySite({ detail: detailFails("4385000102") }) });
    const h = await harness(s.session, s.config, { cycleId: null });
    const error = await partial(s.session.collect(berlinQuery(), h.ctx));
    expect(error.postings.map((p) => p.externalId)).toEqual(["4385000101"]);
    expect(s.store.requests.size).toBe(0);
    expect(s.store.flag).toBeNull();
  });
});

it("a dry run reuses a stored session posting without opening its page or changing the session store", async () => {
  const before = new Map([...(await deliveredBefore())].filter(([, payload]) => sessionPayloadSchema.safeParse(payload).success));
  const stored = [...before][0];
  if (!stored) throw new Error("no valid stored session posting");
  const [id, payload] = stored;
  const known: KnownPostings = { payloads: async (ids) => new Map([stored].filter(([jobId]) => ids.includes(jobId))) };
  const s = setup();
  const h = await harness(s.session, s.config, { cycleId: null, known });

  const out = await s.session.collect(berlinQuery(), h.ctx);

  expect(viewedJobs(s)).not.toContain(`/jobs/view/${id}/`);
  expect(viewedJobs(s)).toEqual(["4385000101", "4385000102", "4385000103", "4385000104", "4385000106"].filter((jobId) => jobId !== id).map((jobId) => `/jobs/view/${jobId}/`));
  expect(h.logs.find((log) => log.message === "linkedin session read finished")?.fields).toMatchObject({ reused: 1 });
  expect(out.find((posting) => posting.externalId === id)?.payload).toEqual(payload);
  expect(s.store.requests.size).toBe(0);
  expect(s.store.flag).toBeNull();
  expect(s.store.recommendedAt).toBeNull();
});
