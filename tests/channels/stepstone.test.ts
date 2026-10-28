// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MIN_DETAILS_FOR_LAYOUT_CHECK } from "@/lib/channels/details";
import { ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { ChannelRegistry, settingsFromConfig } from "@/lib/channels/registry";
import { ageFacet, fetchDetail, fetchSearchPage, MAX_SLUG_LENGTH, postingUrl, searchUrl } from "@/lib/channels/stepstone/client";
import { createStepstoneChannel } from "@/lib/channels/stepstone";
import { parseLocations, parseStepstonePayload } from "@/lib/channels/stepstone/parse";
import { payloadSchema, type StepstonePayload } from "@/lib/channels/stepstone/schema";
import { normalizedPostingDraftSchema, type ChannelContext, type HttpResponse, type RawPostingInput } from "@/lib/channels/types";
import { stepstoneSettingsSchema } from "@/lib/config";

import { channelsWith, failingHttp, interruption, INTERRUPTIONS, shippedChannels, type Interruption } from "./helpers";
import { fixtureHtml, htmlResponse, makeContext, searchQuery, type Handler } from "./web/helpers";

const NOW = new Date("2026-10-07T12:00:00Z");
const settings = () => shippedChannels().sources.stepstone;
/** One result page per keyword unless a test asks for more: the fixture site has a second page that is empty. */
const extra = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...settings(), enabled: true, max_pages: 1, ...over });

const DETAIL_FIXTURES: Record<string, string> = {
  "90000001": "detail-berlin.html",
  "90000003": "detail-multicity.html",
  "90000004": "detail-no-jsonld.html",
};

/** Search URLs get the recorded result page (page 2 and later are empty), posting URLs the recorded posting page. */
function site(options: { search?: string; details?: Record<string, string>; onSearch?: (url: URL) => void } = {}): Handler {
  const search = options.search ?? "search-berlin.html";
  const details = options.details ?? DETAIL_FIXTURES;
  return ({ url }) => {
    if (url.pathname.startsWith("/jobs/")) {
      options.onSearch?.(url);
      const page = Number(url.searchParams.get("page") ?? "1");
      return htmlResponse(200, fixtureHtml("stepstone", page > 1 ? "search-empty.html" : search));
    }
    const id = /-(\d+)-inline\.html$/.exec(url.pathname)?.[1] ?? "";
    const file = details[id];
    return file ? htmlResponse(200, fixtureHtml("stepstone", file)) : htmlResponse(404, "not found");
  };
}

describe("configuration", () => {
  it("ships a valid, enabled block", () => {
    const block = shippedChannels().sources.stepstone;
    expect(block.enabled).toBe(true);
    expect(stepstoneSettingsSchema.safeParse(block).success).toBe(true);
    expect(block.throttle.min_delay_ms).toBeGreaterThanOrEqual(3000);
  });

  it("rejects unknown keys and a missing user agent", () => {
    expect(() => channelsWith((raw) => ((raw.sources as Record<string, Record<string, unknown>>).stepstone!.extra_key = 1))).toThrow();
    expect(() => channelsWith((raw) => ((raw.sources as Record<string, Record<string, unknown>>).stepstone!.user_agent = " "))).toThrow();
    expect(() => channelsWith((raw) => ((raw.sources as Record<string, Record<string, unknown>>).stepstone!.max_pages = 0))).toThrow();
  });

  it("is registered with the built-in channels and backed by its config block", () => {
    const registry = new ChannelRegistry();
    registerBuiltinChannels(registry);
    const channel = registry.get("stepstone");
    expect(channel).toMatchObject({ id: "stepstone", family: "stepstone", usesQueries: true });
    expect(settingsFromConfig("stepstone", shippedChannels())).toMatchObject({ enabled: true, maxResults: 50, monthlyBudgetUsd: 0 });
  });
});

describe("search URLs", () => {
  const base = { base_url: "https://www.stepstone.de/", user_agent: "ua", radius_km: 30 };

  it("builds a located search: keyword slug, city, newest first, window filter, radius", () => {
    const url = new URL(searchUrl(base, { keyword: "Machine Learning Engineer", location: "München", windowHours: 24, page: 1 }) ?? "");
    expect(url.origin + url.pathname).toBe("https://www.stepstone.de/jobs/machine-learning-engineer/in-m%C3%BCnchen");
    expect(Object.fromEntries(url.searchParams)).toEqual({ sort: "2", ag: "age_1", radius: "30" });
  });

  it("builds the remote search: nationwide, home office only, no radius; later pages carry page=", () => {
    const url = new URL(searchUrl(base, { keyword: "KI-Entwickler", location: null, windowHours: 100, page: 3 }) ?? "");
    expect(url.pathname).toBe("/jobs/ki-entwickler");
    expect(Object.fromEntries(url.searchParams)).toEqual({ sort: "2", ag: "age_7", wfh: "1", page: "3" });
  });

  it("maps the look-back window to the widest filter that covers it, none beyond a week", () => {
    expect(ageFacet(10)).toBe("age_1");
    expect(ageFacet(24)).toBe("age_1");
    expect(ageFacet(25)).toBe("age_7");
    expect(ageFacet(168)).toBe("age_7");
    expect(ageFacet(169)).toBeNull();
    const url = new URL(searchUrl(base, { keyword: "x", location: "Berlin", windowHours: 500, page: 1 }) ?? "");
    expect(url.searchParams.has("ag")).toBe(false);
  });

  it("has no URL for a keyword without a usable slug or one that is too long for the site", () => {
    expect(searchUrl(base, { keyword: "!!!", location: "Berlin", windowHours: 24, page: 1 })).toBeNull();
    expect(searchUrl(base, { keyword: "x".repeat(MAX_SLUG_LENGTH + 1), location: "Berlin", windowHours: 24, page: 1 })).toBeNull();
    expect(searchUrl(base, { keyword: "x".repeat(MAX_SLUG_LENGTH), location: "Berlin", windowHours: 24, page: 1 })).not.toBeNull();
  });

  it("keeps posting URLs on the configured site and drops the tracking query", () => {
    const item = { id: 1, title: "t", url: "/stellenangebote--Job-1-inline.html?rltr=1_1_25" };
    expect(postingUrl(base, item)).toBe("https://www.stepstone.de/stellenangebote--Job-1-inline.html");
    expect(postingUrl(base, { ...item, url: "https://evil.example/stellenangebote--Job-1-inline.html" })).toBeNull();
  });
});

describe("search page", () => {
  it("reads the embedded results with their sections and the page count", async () => {
    const { ctx } = makeContext(site(), extra());
    const page = await fetchSearchPage(ctx, settings(), "https://www.stepstone.de/jobs/ai-engineer/in-berlin");
    expect(page.items).toHaveLength(8);
    expect(page.items.map((i) => i.section)).toEqual(["main", "main", "main", "main", "main", "main", "semantic", "semantic"]);
    expect(page.items[0]).toMatchObject({ id: 90000001, title: "Senior Applied AI Engineer (m/w/d)", workFromHome: "2" });
    expect(page.pageCount).toBeGreaterThan(1);
    expect(page.rejected).toBe(0);
  });

  it("reads the recommended filler of a thin search", async () => {
    const { ctx } = makeContext(site({ search: "search-remote.html" }), extra());
    const page = await fetchSearchPage(ctx, settings(), "https://www.stepstone.de/jobs/ai-engineer?wfh=1");
    expect(page.items.some((i) => i.section === "recommended")).toBe(true);
  });

  it("reads an empty result", async () => {
    const { ctx } = makeContext(site({ search: "search-empty.html" }), extra());
    await expect(fetchSearchPage(ctx, settings(), "https://www.stepstone.de/jobs/x")).resolves.toMatchObject({ items: [], pageCount: 0 });
  });

  it("counts results of an unexpected shape instead of failing the page, but fails when none is usable", async () => {
    const html = fixtureHtml("stepstone", "search-berlin.html");
    const withJunk = html.replace('"items":[', '"items":[{"id":"not-a-number"},');
    const mixed = await fetchSearchPage(makeContext(() => htmlResponse(200, withJunk), extra()).ctx, settings(), "https://www.stepstone.de/jobs/x");
    expect(mixed.rejected).toBe(1);
    expect(mixed.items).toHaveLength(8);
    const allJunk = html.replace(/"items":\[.*?\],"resultFilterInfo"/s, '"items":[{"id":"a"},{"title":2}],"resultFilterInfo"');
    await expect(fetchSearchPage(makeContext(() => htmlResponse(200, allJunk), extra()).ctx, settings(), "https://www.stepstone.de/jobs/x")).rejects.toMatchObject({ code: "parse" });
  });

  it("classifies a 403 as blocked", async () => {
    const { ctx } = makeContext(() => htmlResponse(403, fixtureHtml("stepstone", "blocked-403.html")), extra());
    await expect(fetchSearchPage(ctx, settings(), "https://www.stepstone.de/jobs/x")).rejects.toMatchObject({ code: "blocked", status: 403 });
  });

  it("classifies a 200 page without search data: verification page → blocked, other → parse", async () => {
    const challenge = makeContext(() => htmlResponse(200, "<html><body><h1>Please verify you are a human</h1></body></html>"), extra());
    await expect(fetchSearchPage(challenge.ctx, settings(), "https://www.stepstone.de/jobs/x")).rejects.toMatchObject({ code: "blocked" });
    const changed = makeContext(() => htmlResponse(200, "<html><body>Jobs</body></html>"), extra());
    await expect(fetchSearchPage(changed.ctx, settings(), "https://www.stepstone.de/jobs/x")).rejects.toMatchObject({ code: "parse" });
  });

  it("does not mistake a healthy page for a block because its scripts mention captcha", async () => {
    expect(fixtureHtml("stepstone", "search-berlin.html")).toMatch(/captcha/i);
    const { ctx } = makeContext(site(), extra());
    await expect(fetchSearchPage(ctx, settings(), "https://www.stepstone.de/jobs/x")).resolves.toBeDefined();
  });
});

describe("posting page", () => {
  const url = "https://www.stepstone.de/stellenangebote--Job-90000001-inline.html";

  it("keeps the JSON-LD posting and the page's own facts, with contact data removed from the text", async () => {
    const { ctx } = makeContext(site(), extra());
    const detail = await fetchDetail(ctx, settings(), url);
    expect(detail?.jsonLd).toMatchObject({ "@type": "JobPosting", title: "Senior Applied AI Engineer (m/w/d)" });
    expect(typeof detail?.jsonLd?.description).toBe("string");
    expect(detail?.jsonLd?.description).not.toMatch(/<[a-z]+[ >]/i);
    expect(detail?.jsonLd?.description).not.toMatch(/@example\.test/);
    expect(detail?.jobAd?.metaData).toMatchObject({ contractType: "Feste Anstellung", workType: "Homeoffice möglich, Vollzeit" });
    expect(detail?.jobAd?.sections).toBeNull();
  });

  it("falls back to the page sections when there is no JSON-LD description", async () => {
    const { ctx } = makeContext(site(), extra());
    const detail = await fetchDetail(ctx, settings(), "https://www.stepstone.de/stellenangebote--Job-90000004-inline.html");
    expect(detail?.jsonLd).toBeNull();
    expect(detail?.jobAd?.sections?.length).toBeGreaterThan(2);
    expect(detail?.jobAd?.sections?.every((s) => s.text.length > 0 && !/<[a-z]+[ >]/i.test(s.text))).toBe(true);
  });

  it("returns null for a posting that is gone", async () => {
    const { ctx } = makeContext(() => htmlResponse(404, "gone"), extra());
    await expect(fetchDetail(ctx, settings(), url)).resolves.toBeNull();
  });

  it("raises blocked / parse for pages without posting data", async () => {
    const blocked = makeContext(() => htmlResponse(403, fixtureHtml("stepstone", "blocked-403.html")), extra());
    await expect(fetchDetail(blocked.ctx, settings(), url)).rejects.toMatchObject({ code: "blocked" });
    const changed = makeContext(() => htmlResponse(200, "<html><body>nothing</body></html>"), extra());
    await expect(fetchDetail(changed.ctx, settings(), url)).rejects.toMatchObject({ code: "parse" });
  });
});

async function collectAll(over: Record<string, unknown> = {}, query = searchQuery(), handler: Handler = site()) {
  const channel = createStepstoneChannel({ now: () => NOW });
  const made = makeContext(handler, extra(over));
  const postings = await channel.collect(query, made.ctx);
  return { channel, postings, ...made };
}

describe("collect: known postings", () => {
  async function again(known: Map<string, unknown>, over: Record<string, unknown> = {}) {
    const channel = createStepstoneChannel({ now: () => NOW });
    const made = makeContext(site(), extra(over), { known: { payloads: async () => known } });
    const postings = await channel.collect(searchQuery(), made.ctx);
    return { postings, ...made };
  }

  it("re-delivers stored details; only postings stored without one are fetched again", async () => {
    const first = await collectAll();
    const stored = new Map(first.postings.map((p) => [p.externalId, p.payload]));
    const withoutDetail = first.postings.filter((p) => (p.payload as { detail: unknown }).detail === null).length;
    const second = await again(stored);
    expect(second.calls).toHaveLength(1 + withoutDetail);
    expect(second.calls.length).toBeLessThan(first.calls.length);
    expect(second.postings.map((p) => p.payload)).toEqual(first.postings.map((p) => p.payload));
  });

  it("fetches again when reuse_known_details is off", async () => {
    const first = await collectAll();
    const stored = new Map(first.postings.map((p) => [p.externalId, p.payload]));
    const second = await again(stored, { reuse_known_details: false });
    expect(second.calls).toHaveLength(first.calls.length);
  });

  it("fetches again when the lookup fails", async () => {
    const first = await collectAll();
    const channel = createStepstoneChannel({ now: () => NOW });
    const made = makeContext(site(), extra(), {
      known: {
        payloads: async () => {
          throw new Error("db down");
        },
      },
    });
    await channel.collect(searchQuery(), made.ctx);
    expect(made.calls).toHaveLength(first.calls.length);
  });
});

describe("collect", () => {
  it("returns the postings of the window whose titles match, with their pages, newest first within a section", async () => {
    const { postings, calls, sleeps } = await collectAll();
    expect(postings.map((p) => p.externalId)).toEqual(["90000001", "90000002", "90000003", "90000004", "90000008"]);
    // the VP (3 Oct) and Agentic AI (2 Oct) postings are outside the 24 h window, the Kotlin backend title does not match
    const search = calls[0]!.url;
    expect(search.pathname).toBe("/jobs/ai-engineer/in-berlin");
    expect(Object.fromEntries(search.searchParams)).toMatchObject({ sort: "2", ag: "age_1", radius: "30" });
    expect(calls[0]!.headers["User-Agent"]).toBe(settings().user_agent);
    // one search + one page per posting, paced by the throttle between requests
    expect(calls).toHaveLength(1 + 5);
    expect(sleeps).toHaveLength(calls.length - 1);
    const urls = postings.map((p) => p.url);
    expect(urls.every((u) => u?.startsWith("https://www.stepstone.de/stellenangebote--") && !u.includes("?"))).toBe(true);
  });

  it("stores the page data with the posting and nothing for pages that are gone", async () => {
    const { postings } = await collectAll();
    const byId = new Map(postings.map((p) => [p.externalId, p]));
    const parsed = (id: string): StepstonePayload => payloadSchema.parse(byId.get(id)?.payload);
    expect(parsed("90000001").detail?.jsonLd?.["@type"]).toBe("JobPosting");
    expect(parsed("90000004").detail?.jobAd?.sections?.length).toBeGreaterThan(0);
    expect(parsed("90000002").detail).toBeNull(); // 404
    expect(byId.get("90000001")?.postedAt).toBeInstanceOf(Date);
  });

  it("every stored payload parses into a valid draft", async () => {
    const { postings, channel } = await collectAll();
    for (const posting of postings) {
      const draft = normalizedPostingDraftSchema.parse(channel.parse(posting.payload));
      expect(draft.sourceUrl).toBe(posting.url);
    }
  });

  it("uses the remote search (nationwide, home office only) for remote queries and keeps only the answering sections", async () => {
    const urls: URL[] = [];
    const remote = searchQuery({ location: null, remote: true, remoteScope: "home_country", windowHours: 168, keywords: ["AI Engineer"] });
    const { postings, calls } = await collectAll({ fetch_details: false }, remote, site({ search: "search-remote.html", onSearch: (u) => urls.push(u) }));
    expect(urls[0]?.pathname).toBe("/jobs/ai-engineer");
    expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({ wfh: "1", ag: "age_7" });
    expect(urls[0]?.searchParams.has("radius")).toBe(false);
    // the recommended filler is not an answer; fetch_details: false means no posting requests
    expect(calls).toHaveLength(1);
    const ids = postings.map((p) => p.externalId);
    expect(ids).toEqual(["90000009"]);
  });

  it("searches once per keyword and merges the answers without duplicates", async () => {
    const seen: string[] = [];
    const { postings } = await collectAll(
      { fetch_details: false },
      searchQuery({ keywords: ["AI Engineer", "Applied AI Engineer"] }),
      site({ onSearch: (u) => seen.push(u.pathname) }),
    );
    expect(seen).toEqual(["/jobs/ai-engineer/in-berlin", "/jobs/applied-ai-engineer/in-berlin"]);
    expect(new Set(postings.map((p) => p.externalId)).size).toBe(postings.length);
  });

  it("caps the result at the query's maxResults and the detail requests at max_details_per_query", async () => {
    const { postings, calls } = await collectAll({ max_details_per_query: 2 }, searchQuery({ maxResults: 3 }));
    expect(postings).toHaveLength(3);
    expect(calls).toHaveLength(1 + 2);
    expect(postings.map((p) => payloadSchema.parse(p.payload).detail !== null)).toEqual([true, false, false]);
  });

  it("reads further pages up to max_pages and stops at the last page", async () => {
    const pages: string[] = [];
    await collectAll({ max_pages: 3, fetch_details: false }, searchQuery({ maxResults: 100 }), site({ onSearch: (u) => pages.push(u.searchParams.get("page") ?? "1") }));
    // page 2 is empty in this fixture site: the series ends there, not at max_pages
    expect(pages).toEqual(["1", "2"]);
    const single: string[] = [];
    await collectAll({ max_pages: 1, fetch_details: false }, searchQuery({ maxResults: 100 }), site({ onSearch: (u) => single.push(u.searchParams.get("page") ?? "1") }));
    expect(single).toEqual(["1"]);
  });

  it("keeps everything of the window when the title prefilter is off", async () => {
    const { postings } = await collectAll({ fetch_details: false, title_prefilter: { enabled: false, include_terms: [], exclude_terms: [] } });
    expect(postings.map((p) => p.externalId)).toContain("90000007"); // the Kotlin backend title
    expect(postings.map((p) => p.externalId)).not.toContain("90000005"); // still outside the window
  });

  it("skips a keyword that cannot be searched and says so", async () => {
    const { postings, calls, records } = await collectAll({}, searchQuery({ keywords: ["x".repeat(MAX_SLUG_LENGTH + 5)] }));
    expect(postings).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(records.some((r) => r.level === "warn" && /skipped/.test(r.message))).toBe(true);
  });

  it("returns nothing for an empty search without requesting any page", async () => {
    const { postings, calls } = await collectAll({}, searchQuery(), site({ search: "search-empty.html" }));
    expect(postings).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("fetches a posting page once per cycle even when several queries find it", async () => {
    const channel = createStepstoneChannel({ now: () => NOW });
    const first = makeContext(site(), extra());
    await channel.collect(searchQuery(), first.ctx);
    const requests: string[] = [];
    const second = makeContext(
      (call, n) => {
        requests.push(call.url.pathname);
        return site()(call, n);
      },
      extra(),
      { signal: first.ctx.signal },
    );
    await channel.collect(searchQuery({ location: "München" }), second.ctx);
    // the search runs again; every posting page comes from the cycle's memo (including the gone ones)
    expect(requests).toEqual(["/jobs/ai-engineer/in-m%C3%BCnchen"]);
    const other = makeContext(site(), extra());
    await channel.collect(searchQuery(), other.ctx);
    expect(other.calls.length).toBeGreaterThan(1);
  });

  describe("failures", () => {
    it("ends the query on a blocked search and does not ask again", async () => {
      const handler: Handler = () => htmlResponse(403, fixtureHtml("stepstone", "blocked-403.html"));
      const channel = createStepstoneChannel({ now: () => NOW });
      const made = makeContext(handler, extra(), { maxRetries: 3 });
      await expect(channel.collect(searchQuery({ keywords: ["AI Engineer", "KI Engineer"] }), made.ctx)).rejects.toMatchObject({ code: "blocked" });
      expect(made.calls).toHaveLength(1);
    });

    it("ends the query when a posting page is blocked, handing on the list data with the block", async () => {
      const handler: Handler = (call, n) => (call.url.pathname.startsWith("/stellenangebote") ? htmlResponse(403, "denied") : site()(call, n));
      const channel = createStepstoneChannel({ now: () => NOW });
      const made = makeContext(handler, extra());
      const error = await channel.collect(searchQuery(), made.ctx).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PartialCollectError);
      expect((error as PartialCollectError).cause.code).toBe("blocked");
      expect((error as PartialCollectError).postings).toHaveLength(5);
      expect(made.calls).toHaveLength(2); // the search and the first posting page, then it stops
    });

    it("passes a rate limit on to the framework", async () => {
      const channel = createStepstoneChannel({ now: () => NOW });
      const made = makeContext(() => htmlResponse(429, "slow down", { "Retry-After": "1" }), extra());
      await expect(channel.collect(searchQuery(), made.ctx)).rejects.toMatchObject({ code: "rate_limited" });
    });

    it("keeps the list data when posting pages are temporarily unavailable", async () => {
      const handler: Handler = (call, n) => (call.url.pathname.startsWith("/stellenangebote") ? htmlResponse(503, "busy") : site()(call, n));
      const { postings, calls } = await collectAll({}, searchQuery(), handler);
      expect(postings).toHaveLength(5);
      expect(postings.every((p) => payloadSchema.parse(p.payload).detail === null)).toBe(true);
      expect(calls).toHaveLength(2); // a failing site ends the detail round
    });

    it("keeps the list data when one posting page cannot be read, but fails when none can (layout change)", async () => {
      const brokenOne: Handler = (call, n) =>
        call.url.pathname.includes("90000001") ? htmlResponse(200, "<html>nothing</html>") : site()(call, n);
      const { postings } = await collectAll({}, searchQuery(), brokenOne);
      expect(payloadSchema.parse(postings[0]?.payload).detail).toBeNull();
      expect(payloadSchema.parse(postings[2]?.payload).detail).not.toBeNull();

      const brokenAll: Handler = (call, n) => (call.url.pathname.startsWith("/stellenangebote") ? htmlResponse(200, "<html>nothing</html>") : site()(call, n));
      const channel = createStepstoneChannel({ now: () => NOW });
      await expect(channel.collect(searchQuery(), makeContext(brokenAll, extra()).ctx)).rejects.toMatchObject({ code: "parse" });
    });

    describe("a posting page fails", () => {
      const UNREADABLE = "<html>nothing</html>";
      const isPostingPage = (call: { url: URL }) => call.url.pathname.startsWith("/stellenangebote");
      /** site(), except that the `nth` posting page request (1-based) gets `answer`. */
      const nthPage = (nth: number, answer: () => HttpResponse): Handler => {
        let pages = 0;
        return (call, n) => {
          if (!isPostingPage(call)) return site()(call, n);
          pages += 1;
          return pages === nth ? answer() : site()(call, n);
        };
      };
      const unreadable: Handler = (call, n) => (isPostingPage(call) ? htmlResponse(200, UNREADABLE) : site()(call, n));
      const detailOf = (posting: RawPostingInput) => payloadSchema.parse(posting.payload).detail;
      const STOPS = [
        { status: 429, code: "rate_limited" },
        { status: 403, code: "blocked" },
        { status: 401, code: "auth_expired" },
      ] as const;

      for (const { status, code } of STOPS) {
        it(`hands over every search result when the 2nd posting page answers ${status}, opens no further page and keeps ${code}`, async () => {
          const full = await collectAll();
          const made = makeContext(nthPage(2, () => htmlResponse(status, "denied")), extra());
          const error = await createStepstoneChannel({ now: () => NOW }).collect(searchQuery(), made.ctx).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(PartialCollectError);
          const partial = error as PartialCollectError;
          expect(partial.cause).toBeInstanceOf(ChannelError);
          expect(partial.cause).toMatchObject({ code, status });
          expect(partial.postings.map((p) => p.externalId)).toEqual(full.postings.map((p) => p.externalId));
          expect(partial.postings[0]?.payload).toEqual(full.postings[0]?.payload);
          expect(partial.postings.slice(1).every((p) => detailOf(p) === null)).toBe(true);
          expect(made.calls).toHaveLength(1 + 2);
        });
      }

      it("keeps the stored detail of a known posting when the pages stop, with reuse_known_details off", async () => {
        const full = await collectAll();
        const stored = new Map(full.postings.filter((p) => p.externalId === "90000003").map((p) => [p.externalId, p.payload]));
        const made = makeContext(nthPage(2, () => htmlResponse(429, "slow down")), extra({ reuse_known_details: false }), { known: { payloads: async () => stored } });
        const error = await createStepstoneChannel({ now: () => NOW }).collect(searchQuery(), made.ctx).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PartialCollectError);
        const partial = error as PartialCollectError;
        expect(partial.cause.code).toBe("rate_limited");
        expect(partial.postings.find((p) => p.externalId === "90000003")?.payload).toEqual(stored.get("90000003"));
        expect(made.calls).toHaveLength(1 + 2);
      });

      it("reads on past an unreadable 2nd posting page and keeps every search result", async () => {
        const full = await collectAll();
        const { postings, calls } = await collectAll({}, searchQuery(), nthPage(2, () => htmlResponse(200, UNREADABLE)));
        expect(postings.map((p) => p.externalId)).toEqual(full.postings.map((p) => p.externalId));
        expect(detailOf(postings[1]!)).toBeNull();
        expect(postings.map((p) => p.payload)).toEqual(full.postings.map((p) => p.payload));
        expect(calls).toHaveLength(full.calls.length);
      });

      it("keeps the list data and warns when the only posting page to read cannot be read", async () => {
        const { postings, calls, records } = await collectAll({ max_details_per_query: 1 }, searchQuery(), unreadable);
        expect(postings).toHaveLength(5);
        expect(postings.every((p) => detailOf(p) === null)).toBe(true);
        expect(calls).toHaveLength(1 + 1);
        expect(records.some((r) => r.level === "warn" && /too few/.test(r.message))).toBe(true);
      });

      it("fails with parse once enough posting pages were tried and none could be read (layout change)", async () => {
        const made = makeContext(unreadable, extra({ max_details_per_query: MIN_DETAILS_FOR_LAYOUT_CHECK }));
        await expect(createStepstoneChannel({ now: () => NOW }).collect(searchQuery(), made.ctx)).rejects.toMatchObject({ code: "parse" });
        expect(made.calls).toHaveLength(1 + MIN_DETAILS_FOR_LAYOUT_CHECK);
      });
    });

    describe("a later page or keyword fails", () => {
      const request = (slug: string, page: number) => (url: URL) =>
        url.pathname.startsWith(`/jobs/${slug}/`) && (url.searchParams.get("page") ?? "1") === String(page);
      const settle = (promise: Promise<unknown>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
      const run = (fails: (url: URL) => boolean, kind: Interruption, keywords = ["AI Engineer"], over: Record<string, unknown> = {}) => {
        const made = makeContext(site(), extra({ max_pages: 3, fetch_details: false, ...over }));
        return { made, result: settle(createStepstoneChannel({ now: () => NOW }).collect(searchQuery({ keywords }), failingHttp(made.ctx, fails, kind))) };
      };
      const pageOne = async () => (await collectAll({ fetch_details: false })).postings.map((p) => p.externalId);

      for (const kind of INTERRUPTIONS) {
        it(`keeps page 1 when page 2 fails (${kind}) and passes the failure on unchanged`, async () => {
          const { made, result } = run(request("ai-engineer", 2), kind);
          const error = ((await result) as { error: PartialCollectError }).error;
          expect(error).toBeInstanceOf(PartialCollectError);
          expect(error.cause).toMatchObject({ code: kind, retryable: interruption(kind).retryable, tripsCircuit: interruption(kind).tripsCircuit });
          expect(error.postings.map((p) => p.externalId)).toEqual(await pageOne());
          expect(made.calls).toHaveLength(1);
        });

        it(`keeps the earlier keyword when a later keyword fails (${kind})`, async () => {
          const { made, result } = run(request("ki-engineer", 1), kind, ["AI Engineer", "KI Engineer"], { max_pages: 1 });
          const error = ((await result) as { error: PartialCollectError }).error;
          expect(error).toBeInstanceOf(PartialCollectError);
          expect(error.cause.code).toBe(kind);
          expect(error.postings.map((p) => p.externalId)).toEqual(await pageOne());
          expect(made.calls).toHaveLength(1);
        });

        it(`fails as before when page 1 fails (${kind})`, async () => {
          const { made, result } = run(request("ai-engineer", 1), kind, ["AI Engineer", "KI Engineer"]);
          const { error } = (await result) as { error: ChannelError };
          expect(error).toBeInstanceOf(ChannelError);
          expect(error).not.toBeInstanceOf(PartialCollectError);
          expect(error.code).toBe(kind);
          expect(made.calls).toHaveLength(0);
        });
      }

      it("opens no posting page after the failure", async () => {
        const { made, result } = run(request("ai-engineer", 2), "network", ["AI Engineer"], { fetch_details: true });
        expect(((await result) as { error: unknown }).error).toBeInstanceOf(PartialCollectError);
        expect(made.calls.every((c) => c.url.pathname.startsWith("/jobs/"))).toBe(true);
      });

      it("keeps the stored details with reuse_known_details off", async () => {
        const first = await collectAll();
        expect(first.postings.some((p) => (p.payload as { detail: unknown }).detail !== null)).toBe(true);
        const stored = new Map(first.postings.map((p) => [p.externalId, p.payload]));
        const made = makeContext(site(), extra({ max_pages: 3, reuse_known_details: false }), { known: { payloads: async () => stored } });
        const result = await settle(createStepstoneChannel({ now: () => NOW }).collect(searchQuery(), failingHttp(made.ctx, request("ai-engineer", 2), "network")));
        const error = (result as { error: PartialCollectError }).error;
        expect(error).toBeInstanceOf(PartialCollectError);
        expect(error.postings.map((p) => p.payload)).toEqual(first.postings.map((p) => p.payload));
        expect(made.calls).toHaveLength(1);
      });

      it("still uses the details this cycle already fetched, without a new request", async () => {
        const signal = new AbortController().signal;
        const channel = createStepstoneChannel({ now: () => NOW });
        const first = await channel.collect(searchQuery(), makeContext(site(), extra({ max_pages: 3 }), { signal }).ctx);
        expect(first.some((p) => (p.payload as { detail: unknown }).detail !== null)).toBe(true);
        const made = makeContext(site(), extra({ max_pages: 3, reuse_known_details: false }), { signal });
        const result = await settle(channel.collect(searchQuery(), failingHttp(made.ctx, request("ai-engineer", 2), "network")));
        const error = (result as { error: PartialCollectError }).error;
        expect(error).toBeInstanceOf(PartialCollectError);
        expect(error.postings.map((p) => p.payload)).toEqual(first.map((p) => p.payload));
        expect(made.calls).toHaveLength(1);
      });

      it("keeps the postings and the original cause when the budget refuses them after the failure", async () => {
        const made = makeContext(site(), extra({ max_pages: 3, fetch_details: false }));
        const refusing: ChannelContext = {
          ...made.ctx,
          budget: {
            ...made.ctx.budget,
            consume: async () => {
              throw interruption("budget_exceeded");
            },
          },
        };
        const result = await settle(createStepstoneChannel({ now: () => NOW }).collect(searchQuery(), failingHttp(refusing, request("ai-engineer", 2), "network")));
        const error = (result as { error: PartialCollectError }).error;
        expect(error).toBeInstanceOf(PartialCollectError);
        expect(error.cause.code).toBe("network");
        expect(error.postings.map((p) => p.externalId)).toEqual(await pageOne());
      });
    });

    it("rejects an unusable sources.yaml block without any request", async () => {
      const channel = createStepstoneChannel({ now: () => NOW });
      const made = makeContext(site(), { ...extra(), max_pages: 0 });
      await expect(channel.collect(searchQuery(), made.ctx)).rejects.toBeInstanceOf(ChannelError);
      expect(made.calls).toHaveLength(0);
    });
  });
});

describe("parse", () => {
  async function payloadOf(id: string): Promise<{ posting: RawPostingInput; payload: StepstonePayload }> {
    const { postings } = await collectAll();
    const posting = postings.find((p) => p.externalId === id);
    if (!posting) throw new Error(`no posting ${id}`);
    return { posting, payload: payloadSchema.parse(posting.payload) };
  }

  it("maps a posting with page data", async () => {
    const { payload } = await payloadOf("90000001");
    const draft = normalizedPostingDraftSchema.parse(parseStepstonePayload(payload));
    expect(draft).toMatchObject({
      title: "Senior Applied AI Engineer (m/w/d)",
      workplace: "hybrid",
      contractHint: "permanent employment, full-time",
      locations: [{ label: "Berlin", city: "Berlin" }],
      descriptionLanguage: "de",
      salary: null,
      salaryText: null,
    });
    expect(draft.companyName.length).toBeGreaterThan(0);
    expect(draft.description.length).toBeGreaterThan(500);
    expect(draft.description).not.toMatch(/@example\.test/);
    expect(draft.postedAt).toBeInstanceOf(Date);
    expect(draft.extra).toMatchObject({ stepstoneId: 90000001, section: "main", hasDescription: true });
  });

  it("maps the long city form and a nationwide posting", async () => {
    const multi = parseStepstonePayload((await payloadOf("90000003")).payload);
    expect(multi.locations.map((l) => [l.city, l.countryCode])).toEqual([
      ["Berlin", "DE"],
      ["Hamburg", "DE"],
      ["München", "DE"],
    ]);
    const nationwide = parseStepstonePayload((await payloadOf("90000004")).payload);
    expect(nationwide.locations.map((l) => l.city)).toEqual(["Berlin", "Frankfurt", "Hamburg", "Köln", "Leipzig", "München"]);
    expect(nationwide.description).toMatch(/\S/); // from the page sections
    expect(nationwide.contractHint).toMatch(/permanent/);
  });

  it("parses a posting that has only list data (details not fetched or gone)", async () => {
    const { payload } = await payloadOf("90000002");
    expect(payload.detail).toBeNull();
    const draft = normalizedPostingDraftSchema.parse(parseStepstonePayload(payload));
    expect(draft.description).toBe("");
    expect(draft.descriptionLanguage).toBe("unknown");
    expect(draft.workplace).toBe("hybrid");
    expect(draft.locations).toHaveLength(8);
    expect(draft.contractHint).toBeNull();
  });

  it("never turns StepStone's own salary estimate into the posting's salary (C3)", async () => {
    const { payload } = await payloadOf("90000001");
    const withPage = (salary: NonNullable<NonNullable<StepstonePayload["detail"]>["jobAd"]>["salary"]): StepstonePayload => ({
      ...payload,
      detail: { jsonLd: payload.detail?.jsonLd ?? null, jobAd: { ...payload.detail?.jobAd, salary } },
    });
    const predicted = parseStepstonePayload(withPage({ isPredicted: true, min: 60000, max: 80000, period: "Jahr", currencyIso: "EUR" }));
    expect(predicted.salary).toBeNull();
    expect(predicted.salaryText).toBeNull();
    expect(predicted.extra).toMatchObject({ predictedSalary: { min: 60000, max: 80000, currency: "EUR", period: "year" } });

    const stated = parseStepstonePayload(withPage({ isPredicted: false, min: 70000, max: 90000, period: "Jahr", currencyIso: "EUR" }));
    expect(stated.salary).toEqual({ min: 70000, max: 90000, currency: "EUR", period: "year", raw: "70000-90000 EUR/year" });
    expect(stated.salaryText).toBe("70000-90000 EUR/year");
    expect(stated.extra).not.toHaveProperty("predictedSalary");

    // a flag that is missing means "not known to be stated"
    expect(parseStepstonePayload(withPage({ min: 70000, max: 90000, period: "Jahr", currencyIso: "EUR" })).salary).toBeNull();
  });

  it("reads the list salary only when it is not a prediction", async () => {
    const { payload } = await payloadOf("90000002");
    const withList = (unifiedSalary: Record<string, unknown>): StepstonePayload => ({ ...payload, list: { ...payload.list, unifiedSalary } });
    expect(parseStepstonePayload(withList({ salaryType: "Predicted", min: 3000, max: 3500, period: "Monthly", currencyIso: "EUR" })).salary).toBeNull();
    expect(parseStepstonePayload(withList({ salaryType: null, min: 3000, max: 3500, period: "Monthly", currencyIso: "EUR" })).salary).toBeNull();
    expect(parseStepstonePayload(withList({ salaryType: "Stated", min: 3000, max: 3500, period: "Monthly", currencyIso: "EUR" })).salary).toMatchObject({
      min: 3000,
      max: 3500,
      period: "month",
    });
    // an amount without a period is kept as text only
    const noPeriod = parseStepstonePayload(withList({ salaryType: "Stated", min: 3000, max: 3500, period: null, currencyIso: "EUR" }));
    expect(noPeriod.salary).toBeNull();
    expect(noPeriod.salaryText).toBe("3000-3500 EUR");
  });

  it("maps the home-office flag and leaves unstated facts unknown", async () => {
    const { payload } = await payloadOf("90000002");
    const withFlag = (flag: string | null): StepstonePayload => ({ ...payload, list: { ...payload.list, workFromHome: flag } });
    expect(parseStepstonePayload(withFlag("1")).workplace).toBe("remote");
    expect(parseStepstonePayload(withFlag("2")).workplace).toBe("hybrid");
    expect(parseStepstonePayload(withFlag("0")).workplace).toBe("unknown");
    expect(parseStepstonePayload(withFlag(null)).workplace).toBe("unknown");
  });

  it("fails with a parse error for payloads of the wrong shape or without a title or employer", async () => {
    const { payload } = await payloadOf("90000002");
    expect(() => parseStepstonePayload({ nope: true })).toThrow(ChannelError);
    expect(() => parseStepstonePayload(null)).toThrow(/expected shape/);
    expect(() => parseStepstonePayload({ ...payload, list: { ...payload.list, companyName: null } })).toThrow(/employer/);
    expect(() => parseStepstonePayload({ ...payload, list: { ...payload.list, title: "   " } })).toThrow(ChannelError);
  });

  it("splits location texts", () => {
    expect(parseLocations("Berlin", null)).toEqual([{ label: "Berlin", city: "Berlin", countryCode: null }]);
    expect(parseLocations("Halle (Saale), bundesweit, Home-Office", "DE")).toEqual([{ label: "Halle (Saale)", city: "Halle (Saale)", countryCode: "DE" }]);
    expect(parseLocations("Deutschlandweit / Homeoffice", null)).toEqual([]);
    expect(parseLocations("Berlin, Berlin, Germany; Wien, Wien, Österreich", null).map((l) => [l.city, l.countryCode])).toEqual([
      ["Berlin", "DE"],
      ["Wien", "AT"],
    ]);
    expect(parseLocations(null, null)).toEqual([]);
    expect(parseLocations("  ", null)).toEqual([]);
  });
});
