// @vitest-environment node
import { describe, expect, it } from "vitest";

import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { MIN_DETAILS_FOR_LAYOUT_CHECK } from "@/lib/channels/details";
import { ChannelRegistry, settingsFromConfig } from "@/lib/channels/registry";
import { createXingChannel } from "@/lib/channels/xing";
import { fetchDetail, fetchSearchPage, PAGE_SIZE, postingId, postingUrl, searchUrl } from "@/lib/channels/xing/client";
import { parseXingPayload } from "@/lib/channels/xing/parse";
import { payloadSchema, type XingPayload } from "@/lib/channels/xing/schema";
import { normalizedPostingDraftSchema, type ChannelContext, type HttpResponse, type RawPostingInput } from "@/lib/channels/types";
import { xingSettingsSchema } from "@/lib/config";

import { channelsWith, failingHttp, interruption, INTERRUPTIONS, shippedChannels, type Interruption } from "./helpers";
import { fixtureHtml, htmlResponse, makeContext, searchQuery, type Handler } from "./web/helpers";

const NOW = new Date("2026-10-07T12:00:00Z");
const settings = () => shippedChannels().sources.xing;
/** One result page per keyword unless a test asks for more. */
const extra = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...settings(), enabled: true, max_pages: 1, ...over });

const DETAIL_FIXTURES: Record<string, string> = {
  "90100001": "detail-third-party.html",
  "90100002": "detail-remote-nosalary.html",
  "90100004": "detail-salary-range.html",
  "90100006": "detail-estimate-remote.html",
};

/** A search page with `count` generated results (ids `base + n`), for paging tests. */
function generatedSearchPage(count: number, total: number, base = 900000): string {
  const collection: unknown[] = [];
  const state: Record<string, unknown> = {};
  for (let n = 0; n < count; n += 1) {
    const ref = `VisibleJob:${base + n}.abc123`;
    collection.push({ __typename: "JobItemResult", position: n, jobDetail: { __ref: ref } });
    state[ref] = {
      __typename: "VisibleJob",
      id: `${base + n}.abc123`,
      slug: `berlin-ai-engineer-${base + n}`,
      title: `AI Engineer ${base + n}`,
      refreshedAt: "2026-10-07T08:00:00Z",
      companyInfo: { __typename: "JobCompanyInfo", companyNameOverride: "Example GmbH" },
      locations: [{ __typename: "JobLocation", city: "Berlin" }],
    };
  }
  state.ROOT_QUERY = { __typename: "Query", 'jobSearchByQuery({"limit":20})': { __typename: "JobSearchResult", boundedTotal: { total }, collection } };
  return `<html><script id="runtime-config">window.crate={"x":undefined,"serverData":{"APOLLO_STATE":${JSON.stringify(state)}}};</script></html>`;
}

/** Search URLs get the recorded result page, posting URLs the recorded posting page (404 for unrecorded ones). */
function site(options: { search?: string; details?: Record<string, string>; onSearch?: (url: URL) => void } = {}): Handler {
  const search = options.search ?? "search-berlin.html";
  const details = options.details ?? DETAIL_FIXTURES;
  return ({ url }) => {
    if (url.pathname.startsWith("/jobs/search")) {
      options.onSearch?.(url);
      return htmlResponse(200, fixtureHtml("xing", search));
    }
    const id = /-(\d+)$/.exec(url.pathname)?.[1] ?? "";
    const file = details[id];
    return file ? htmlResponse(200, fixtureHtml("xing", file)) : htmlResponse(404, "not found");
  };
}

describe("configuration", () => {
  it("ships a valid, disabled block with a remote option id", () => {
    const block = shippedChannels().sources.xing;
    expect(block.enabled).toBe(false);
    expect(xingSettingsSchema.safeParse(block).success).toBe(true);
    expect(block.remote_option_id).toMatch(/^FULL_REMOTE\./);
    expect(block.throttle.min_delay_ms).toBeGreaterThanOrEqual(3000);
  });

  it("rejects unknown keys and an empty remote option id", () => {
    expect(() => channelsWith((raw) => ((raw.sources as Record<string, Record<string, unknown>>).xing!.extra_key = 1))).toThrow();
    expect(() => channelsWith((raw) => ((raw.sources as Record<string, Record<string, unknown>>).xing!.remote_option_id = ""))).toThrow();
  });

  it("is registered with the built-in channels and backed by its config block", () => {
    const registry = new ChannelRegistry();
    registerBuiltinChannels(registry);
    expect(registry.get("xing")).toMatchObject({ id: "xing", family: "xing", usesQueries: true });
    expect(settingsFromConfig("xing", shippedChannels())).toMatchObject({ enabled: false, maxResults: 50, monthlyBudgetUsd: 0 });
  });
});

describe("search URLs", () => {
  const base = { base_url: "https://www.xing.com/", user_agent: "ua", radius_km: 30, remote_option_id: "FULL_REMOTE.050e26" };

  it("builds a located search with radius", () => {
    const url = new URL(searchUrl(base, { keyword: "Machine Learning Engineer", location: "München", page: 1 }));
    expect(url.origin + url.pathname).toBe("https://www.xing.com/jobs/search/ki");
    expect(Object.fromEntries(url.searchParams)).toEqual({ keywords: "Machine Learning Engineer", location: "München", radius: "30" });
  });

  it("builds the remote search with the configured filter id, and later pages", () => {
    const url = new URL(searchUrl(base, { keyword: "KI-Entwickler", location: null, page: 2 }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ keywords: "KI-Entwickler", remoteOption: "FULL_REMOTE.050e26", page: "2" });
  });

  it("derives the posting id and URL, staying on the configured site", () => {
    expect(postingId({ id: "157369813.d962f0" })).toBe("157369813");
    expect(postingUrl(base, { slug: "berlin-senior-software-engineer-157369813" })).toBe("https://www.xing.com/jobs/berlin-senior-software-engineer-157369813");
    expect(postingUrl(base, { slug: "../../evil" })).toMatch(/^https:\/\/www\.xing\.com\/jobs\//);
  });
});

describe("search page", () => {
  it("reads the results from the embedded state, with references resolved and viewer fields dropped", async () => {
    const { ctx } = makeContext(site(), extra());
    const page = await fetchSearchPage(ctx, settings(), "https://www.xing.com/jobs/search/ki?keywords=ai");
    expect(page.items.map((i) => i.id.split(".")[0])).toEqual(["90100001", "90100002", "90100003", "90100004", "90100005", "90100006"]);
    expect(page.total).toBeGreaterThan(100);
    expect(page.rejected).toBe(0);
    expect(page.items[0]).toMatchObject({ title: "AI- & Data-Engineer (w/m/d)", companyInfo: { companyNameOverride: "Prüfwerk Partner" }, salary: { __typename: "SalaryEstimate" } });
    expect(page.items[0]).not.toHaveProperty("userInteractions");
  });

  it("reads an empty result", async () => {
    const { ctx } = makeContext(site({ search: "search-empty.html" }), extra());
    await expect(fetchSearchPage(ctx, settings(), "https://www.xing.com/jobs/search/ki")).resolves.toMatchObject({ items: [], total: 0 });
  });

  it("counts results of an unexpected shape, but fails when none is usable", async () => {
    const html = fixtureHtml("xing", "search-berlin.html");
    const withJunk = html.replace('"title":"AI- & Data-Engineer (w/m/d)"', '"title":""');
    const mixed = await fetchSearchPage(makeContext(() => htmlResponse(200, withJunk), extra()).ctx, settings(), "https://www.xing.com/jobs/search/ki");
    expect(mixed.rejected).toBe(1);
    expect(mixed.items).toHaveLength(5);
    const allJunk = html.replace(/"title":"[^"]*"/g, '"title":""');
    await expect(fetchSearchPage(makeContext(() => htmlResponse(200, allJunk), extra()).ctx, settings(), "https://www.xing.com/jobs/search/ki")).rejects.toMatchObject({ code: "parse" });
  });

  it("classifies failures: 403 and verification pages are blocked, a changed page is a parse error", async () => {
    const forbidden = makeContext(() => htmlResponse(403, "denied"), extra());
    await expect(fetchSearchPage(forbidden.ctx, settings(), "https://www.xing.com/jobs/search/ki")).rejects.toMatchObject({ code: "blocked", status: 403 });
    const challenge = makeContext(() => htmlResponse(200, fixtureHtml("xing", "blocked-challenge.html")), extra());
    await expect(fetchSearchPage(challenge.ctx, settings(), "https://www.xing.com/jobs/search/ki")).rejects.toMatchObject({ code: "blocked" });
    const changed = makeContext(() => htmlResponse(200, "<html><body>Jobs</body></html>"), extra());
    await expect(fetchSearchPage(changed.ctx, settings(), "https://www.xing.com/jobs/search/ki")).rejects.toMatchObject({ code: "parse" });
  });

  it("explains a page that has page data but no search result (an outdated remote filter id)", async () => {
    const html = fixtureHtml("xing", "search-berlin.html").replace(/jobSearchByQuery\(/g, "somethingElse(");
    const { ctx } = makeContext(() => htmlResponse(200, html), extra());
    await expect(fetchSearchPage(ctx, settings(), "https://www.xing.com/jobs/search/ki?remoteOption=X")).rejects.toThrow(/remote_option_id/);
  });

  it("does not mistake a healthy page for a block because its scripts mention captcha", async () => {
    expect(fixtureHtml("xing", "search-berlin.html")).toMatch(/captcha/i);
    const { ctx } = makeContext(site(), extra());
    await expect(fetchSearchPage(ctx, settings(), "https://www.xing.com/jobs/search/ki")).resolves.toBeDefined();
  });
});

describe("posting page", () => {
  const url = "https://www.xing.com/jobs/berlin-ai-solution-engineer-90100004";

  it("keeps the JSON-LD posting and the posting entity, without the description template and viewer data", async () => {
    const { ctx } = makeContext(site(), extra());
    const detail = await fetchDetail(ctx, settings(), url);
    expect(detail?.jsonLd).toMatchObject({ "@type": "JobPosting", title: "AI Solution Engineer (f/m/d)" });
    expect(typeof detail?.jsonLd?.description).toBe("string");
    expect(detail?.jsonLd?.description).not.toMatch(/<[a-z]+[ >]/i);
    expect(detail?.job).toMatchObject({ remoteOptions: ["NON_REMOTE"], language: "de", careerLevel: { localizationValue: "Berufseinsteiger·in" } });
    expect(detail?.job).not.toHaveProperty("description");
    expect(detail?.job).not.toHaveProperty("userInteractions");
    expect(detail?.sections).toBeNull();
  });

  it("removes the contact data of the description text", async () => {
    const { ctx } = makeContext(site(), extra());
    const detail = await fetchDetail(ctx, settings(), "https://www.xing.com/jobs/berlin-ai-engineer-all-levels-90100006");
    const text = String(detail?.jsonLd?.description);
    expect(text).not.toMatch(/Musterfrau|1234567|@example/);
    expect(text).toContain("[contact removed]");
  });

  it("falls back to the description template when the JSON-LD has no description", async () => {
    const html = fixtureHtml("xing", "detail-salary-range.html").replace(/"description":"[^"]*"/, '"description":""');
    const { ctx } = makeContext(() => htmlResponse(200, html), extra());
    const detail = await fetchDetail(ctx, settings(), url);
    expect(detail?.sections?.length).toBeGreaterThan(0);
    expect(detail?.sections?.every((s) => s.text.length > 0 && !/<[a-z]+[ >]/i.test(s.text))).toBe(true);
  });

  it("returns null for a posting that is gone, and raises blocked / parse for pages without data", async () => {
    await expect(fetchDetail(makeContext(() => htmlResponse(410, "gone"), extra()).ctx, settings(), url)).resolves.toBeNull();
    await expect(fetchDetail(makeContext(() => htmlResponse(403, "denied"), extra()).ctx, settings(), url)).rejects.toMatchObject({ code: "blocked" });
    await expect(fetchDetail(makeContext(() => htmlResponse(200, fixtureHtml("xing", "blocked-challenge.html")), extra()).ctx, settings(), url)).rejects.toMatchObject({ code: "blocked" });
    await expect(fetchDetail(makeContext(() => htmlResponse(200, "<html>nothing</html>"), extra()).ctx, settings(), url)).rejects.toMatchObject({ code: "parse" });
  });
});

async function collectAll(over: Record<string, unknown> = {}, query = searchQuery(), handler: Handler = site()) {
  const channel = createXingChannel({ now: () => NOW });
  const made = makeContext(handler, extra(over));
  const postings = await channel.collect(query, made.ctx);
  return { channel, postings, ...made };
}

describe("collect: known postings", () => {
  async function again(known: Map<string, unknown>, over: Record<string, unknown> = {}) {
    const channel = createXingChannel({ now: () => NOW });
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
    const channel = createXingChannel({ now: () => NOW });
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
  it("keeps the results refreshed within the window, with their pages", async () => {
    const { postings, calls, sleeps } = await collectAll();
    // 24 h window: only the two postings refreshed on 7 Oct qualify
    expect(postings.map((p) => p.externalId)).toEqual(["90100003", "90100004"]);
    const search = calls[0]!.url;
    expect(search.origin + search.pathname).toBe("https://www.xing.com/jobs/search/ki");
    expect(Object.fromEntries(search.searchParams)).toEqual({ keywords: "AI Engineer", location: "Berlin", radius: "30" });
    expect(calls[0]!.headers["User-Agent"]).toBe(settings().user_agent);
    expect(calls).toHaveLength(1 + 2);
    expect(sleeps).toHaveLength(calls.length - 1);
    expect(postings.map((p) => p.url)).toEqual([
      "https://www.xing.com/jobs/berlin-ai-associate-all-genders-90100003",
      "https://www.xing.com/jobs/berlin-ai-solution-engineer-90100004",
    ]);
    expect(postings[0]?.postedAt).toEqual(new Date("2026-10-07T08:15:39Z"));
  });

  it("stores the page data with the posting, nothing for pages that are gone", async () => {
    const { postings } = await collectAll();
    const payloads = postings.map((p) => payloadSchema.parse(p.payload));
    expect(payloads[0]?.detail).toBeNull(); // 404
    expect(payloads[1]?.detail?.jsonLd?.["@type"]).toBe("JobPosting");
    expect(payloads[1]?.list.title).toBe("AI Solution Engineer (f/m/d)");
  });

  it("every stored payload parses into a valid draft", async () => {
    const { postings, channel } = await collectAll({}, searchQuery({ windowHours: 5000 }));
    expect(postings).toHaveLength(5); // all but the November 2025 posting
    for (const posting of postings) {
      const draft = normalizedPostingDraftSchema.parse(channel.parse(posting.payload));
      expect(draft.sourceUrl).toBe(posting.url);
    }
  });

  it("uses the configured remote filter and no location for remote queries", async () => {
    const urls: URL[] = [];
    const remote = searchQuery({ location: null, remote: true, remoteScope: "home_country", windowHours: 5000 });
    await collectAll({ fetch_details: false }, remote, site({ onSearch: (u) => urls.push(u) }));
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ keywords: "AI Engineer", remoteOption: settings().remote_option_id });
  });

  it("applies the title prefilter to every result", async () => {
    const { postings } = await collectAll({ fetch_details: false }, searchQuery({ keywords: ["Forward Deployed Engineer"], windowHours: 5000 }));
    // titles hold AI as a word, which the include terms keep
    expect(postings.length).toBeGreaterThan(0);
    const none = await collectAll(
      { fetch_details: false, title_prefilter: { enabled: true, include_terms: [], exclude_terms: ["Associate"] } },
      searchQuery({ keywords: ["Solution Engineer"], windowHours: 5000 }),
    );
    expect(none.postings.map((p) => p.externalId)).toEqual(["90100004"]);
  });

  it("reads another page only when this one is full, up to max_pages", async () => {
    const requested: string[] = [];
    const handler: Handler = ({ url }) => {
      if (!url.pathname.startsWith("/jobs/search")) return htmlResponse(404, "n/a");
      const page = Number(url.searchParams.get("page") ?? "1");
      requested.push(String(page));
      return htmlResponse(200, generatedSearchPage(PAGE_SIZE, 100, 900000 + page * 100));
    };
    const { postings } = await collectAll({ max_pages: 3, fetch_details: false }, searchQuery({ maxResults: 100 }), handler);
    expect(requested).toEqual(["1", "2", "3"]);
    expect(postings).toHaveLength(60);

    requested.length = 0;
    const short: Handler = ({ url }) => {
      requested.push(url.searchParams.get("page") ?? "1");
      return htmlResponse(200, generatedSearchPage(5, 5));
    };
    await collectAll({ max_pages: 3, fetch_details: false }, searchQuery(), short);
    expect(requested).toEqual(["1"]);

    requested.length = 0;
    const ended: Handler = ({ url }) => {
      requested.push(url.searchParams.get("page") ?? "1");
      return htmlResponse(200, generatedSearchPage(PAGE_SIZE, PAGE_SIZE));
    };
    await collectAll({ max_pages: 3, fetch_details: false }, searchQuery({ maxResults: 100 }), ended);
    expect(requested).toEqual(["1"]); // the search says it has no more results
  });

  it("caps the result at maxResults and the detail requests at max_details_per_query", async () => {
    const { postings, calls } = await collectAll({ max_details_per_query: 1 }, searchQuery({ windowHours: 5000, maxResults: 3 }));
    expect(postings).toHaveLength(3);
    expect(calls).toHaveLength(1 + 1);
  });

  it("searches once per keyword and merges the answers without duplicates", async () => {
    const seen: string[] = [];
    const { postings } = await collectAll(
      { fetch_details: false },
      searchQuery({ keywords: ["AI Engineer", "Applied AI Engineer"], windowHours: 5000 }),
      site({ onSearch: (u) => seen.push(u.searchParams.get("keywords") ?? "") }),
    );
    expect(seen).toEqual(["AI Engineer", "Applied AI Engineer"]);
    expect(new Set(postings.map((p) => p.externalId)).size).toBe(postings.length);
  });

  it("fetches a posting page once per cycle even when several queries find it", async () => {
    const channel = createXingChannel({ now: () => NOW });
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
    expect(requests).toEqual(["/jobs/search/ki"]);
  });

  describe("failures", () => {
    it("ends the query on a blocked search and does not ask again", async () => {
      const channel = createXingChannel({ now: () => NOW });
      const made = makeContext(() => htmlResponse(403, "denied"), extra(), { maxRetries: 3 });
      await expect(channel.collect(searchQuery({ keywords: ["AI Engineer", "KI Engineer"] }), made.ctx)).rejects.toMatchObject({ code: "blocked" });
      expect(made.calls).toHaveLength(1);
    });

    it("ends the query when a posting page is blocked, handing on the list data with the block", async () => {
      const handler: Handler = (call, n) => (call.url.pathname.startsWith("/jobs/search") ? site()(call, n) : htmlResponse(403, "denied"));
      const channel = createXingChannel({ now: () => NOW });
      const made = makeContext(handler, extra());
      const error = await channel.collect(searchQuery(), made.ctx).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PartialCollectError);
      expect((error as PartialCollectError).cause.code).toBe("blocked");
      expect((error as PartialCollectError).postings).toHaveLength(2);
      expect(made.calls).toHaveLength(2);
    });

    it("passes a rate limit on to the framework", async () => {
      const channel = createXingChannel({ now: () => NOW });
      const made = makeContext(() => htmlResponse(429, "slow", { "Retry-After": "1" }), extra());
      await expect(channel.collect(searchQuery(), made.ctx)).rejects.toMatchObject({ code: "rate_limited" });
    });

    it("keeps the list data when posting pages are temporarily unavailable", async () => {
      const handler: Handler = (call, n) => (call.url.pathname.startsWith("/jobs/search") ? site()(call, n) : htmlResponse(503, "busy"));
      const { postings, calls } = await collectAll({}, searchQuery(), handler);
      expect(postings).toHaveLength(2);
      expect(postings.every((p) => payloadSchema.parse(p.payload).detail === null)).toBe(true);
      expect(calls).toHaveLength(2);
    });

    it("keeps the list data when one posting page cannot be read, but fails when none can", async () => {
      const brokenOne: Handler = (call, n) => (call.url.pathname.endsWith("90100004") ? htmlResponse(200, "<html>nothing</html>") : site()(call, n));
      const { postings } = await collectAll({}, searchQuery(), brokenOne);
      expect(postings).toHaveLength(2);
      const brokenAll: Handler = (call, n) => (call.url.pathname.startsWith("/jobs/search") ? site()(call, n) : htmlResponse(200, "<html>nothing</html>"));
      const channel = createXingChannel({ now: () => NOW });
      await expect(channel.collect(searchQuery({ windowHours: 5000 }), makeContext(brokenAll, extra()).ctx)).rejects.toMatchObject({ code: "parse" });
    });

    describe("a posting page fails", () => {
      const UNREADABLE = "<html>nothing</html>";
      /** Every posting of the fixture page but the November 2025 one, so several pages are opened. */
      const wide = () => searchQuery({ windowHours: 5000 });
      const isPostingPage = (call: { url: URL }) => !call.url.pathname.startsWith("/jobs/search");
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
          const full = await collectAll({}, wide());
          expect(full.postings.slice(2).some((p) => detailOf(p) !== null)).toBe(true);
          const made = makeContext(nthPage(2, () => htmlResponse(status, "denied")), extra());
          const error = await createXingChannel({ now: () => NOW }).collect(wide(), made.ctx).catch((e: unknown) => e);
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
        const full = await collectAll({}, wide());
        const last = full.postings.at(-1)!;
        expect(detailOf(last)).not.toBeNull();
        const stored = new Map([[last.externalId, last.payload]]);
        const made = makeContext(nthPage(2, () => htmlResponse(429, "slow")), extra({ reuse_known_details: false }), { known: { payloads: async () => stored } });
        const error = await createXingChannel({ now: () => NOW }).collect(wide(), made.ctx).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PartialCollectError);
        const partial = error as PartialCollectError;
        expect(partial.cause.code).toBe("rate_limited");
        expect(partial.postings.find((p) => p.externalId === last.externalId)?.payload).toEqual(last.payload);
        expect(made.calls).toHaveLength(1 + 2);
      });

      it("reads on past an unreadable 2nd posting page and keeps every search result", async () => {
        const full = await collectAll({}, wide());
        const { postings, calls } = await collectAll({}, wide(), nthPage(2, () => htmlResponse(200, UNREADABLE)));
        expect(postings.map((p) => p.externalId)).toEqual(full.postings.map((p) => p.externalId));
        expect(detailOf(postings[1]!)).toBeNull();
        expect(postings.filter((_, i) => i !== 1).map((p) => p.payload)).toEqual(full.postings.filter((_, i) => i !== 1).map((p) => p.payload));
        expect(calls).toHaveLength(full.calls.length);
      });

      it("keeps the list data and warns when the only posting page to read cannot be read", async () => {
        const { postings, calls, records } = await collectAll({ max_details_per_query: 1 }, searchQuery(), unreadable);
        expect(postings).toHaveLength(2);
        expect(postings.every((p) => detailOf(p) === null)).toBe(true);
        expect(calls).toHaveLength(1 + 1);
        expect(records.some((r) => r.level === "warn" && /too few/.test(r.message))).toBe(true);
      });

      it("fails with parse once enough posting pages were tried and none could be read (layout change)", async () => {
        const made = makeContext(unreadable, extra({ max_details_per_query: MIN_DETAILS_FOR_LAYOUT_CHECK }));
        await expect(createXingChannel({ now: () => NOW }).collect(wide(), made.ctx)).rejects.toMatchObject({ code: "parse" });
        expect(made.calls).toHaveLength(1 + MIN_DETAILS_FOR_LAYOUT_CHECK);
      });
    });

    describe("a later page or keyword fails", () => {
      /** Full search pages per keyword: ids 9<keyword index><page>NN, so every page and keyword is told apart. */
      const pages: Handler = ({ url }) => {
        if (!url.pathname.startsWith("/jobs/search")) return htmlResponse(404, "n/a");
        const keyword = url.searchParams.get("keywords") === "AI Engineer" ? 1 : 2;
        const page = Number(url.searchParams.get("page") ?? "1");
        return htmlResponse(200, generatedSearchPage(PAGE_SIZE, 1000, 900000 + keyword * 1000 + page * 100));
      };
      const request = (keyword: string, page: number) => (url: URL) =>
        url.pathname.startsWith("/jobs/search") && url.searchParams.get("keywords") === keyword && (url.searchParams.get("page") ?? "1") === String(page);
      const ids = (from: number) => Array.from({ length: PAGE_SIZE }, (_, n) => String(from + n));
      const settle = (promise: Promise<unknown>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
      const run = (fails: (url: URL) => boolean, kind: Interruption, keywords = ["AI Engineer"]) => {
        const made = makeContext(pages, extra({ max_pages: 3, fetch_details: false }));
        return { made, result: settle(createXingChannel({ now: () => NOW }).collect(searchQuery({ keywords, maxResults: 200 }), failingHttp(made.ctx, fails, kind))) };
      };

      for (const kind of INTERRUPTIONS) {
        it(`keeps page 1 when page 2 fails (${kind}) and passes the failure on unchanged`, async () => {
          const { made, result } = run(request("AI Engineer", 2), kind);
          const error = ((await result) as { error: PartialCollectError }).error;
          expect(error).toBeInstanceOf(PartialCollectError);
          expect(error.cause).toMatchObject({ code: kind, retryable: interruption(kind).retryable, tripsCircuit: interruption(kind).tripsCircuit });
          expect(error.postings.map((p) => p.externalId)).toEqual(ids(901100));
          expect(made.calls).toHaveLength(1);
        });

        it(`keeps the earlier keyword and the fetched page of the unfinished one when a later keyword fails (${kind})`, async () => {
          const { made, result } = run(request("ML Engineer", 2), kind, ["AI Engineer", "ML Engineer"]);
          const error = ((await result) as { error: PartialCollectError }).error;
          expect(error).toBeInstanceOf(PartialCollectError);
          expect(error.cause.code).toBe(kind);
          expect(error.postings.map((p) => p.externalId).sort()).toEqual([...ids(901100), ...ids(901200), ...ids(901300), ...ids(902100)].sort());
          expect(made.calls).toHaveLength(4);
        });

        it(`fails as before when page 1 fails (${kind})`, async () => {
          const { made, result } = run(request("AI Engineer", 1), kind, ["AI Engineer", "ML Engineer"]);
          const { error } = (await result) as { error: ChannelError };
          expect(error).toBeInstanceOf(ChannelError);
          expect(error.code).toBe(kind);
          expect(made.calls).toHaveLength(0);
        });
      }

      it("opens no posting page after the failure", async () => {
        const made = makeContext(pages, extra({ max_pages: 3 }));
        const result = await settle(createXingChannel({ now: () => NOW }).collect(searchQuery({ maxResults: 200 }), failingHttp(made.ctx, request("AI Engineer", 2), "network")));
        expect((result as { error: unknown }).error).toBeInstanceOf(PartialCollectError);
        expect(made.calls.every((c) => c.url.pathname.startsWith("/jobs/search"))).toBe(true);
      });

      it("keeps the stored details with reuse_known_details off", async () => {
        const withDetails: Handler = (call, n) =>
          call.url.pathname.startsWith("/jobs/search") ? pages(call, n) : htmlResponse(200, fixtureHtml("xing", "detail-salary-range.html"));
        const channel = createXingChannel({ now: () => NOW });
        const first = await channel.collect(searchQuery({ maxResults: 200 }), makeContext(withDetails, extra({ max_pages: 1, max_details_per_query: PAGE_SIZE })).ctx);
        expect(first.every((p) => (p.payload as { detail: unknown }).detail !== null)).toBe(true);
        const stored = new Map(first.map((p) => [p.externalId, p.payload]));
        const made = makeContext(withDetails, extra({ max_pages: 3, reuse_known_details: false }), { known: { payloads: async () => stored } });
        const result = await settle(channel.collect(searchQuery({ maxResults: 200 }), failingHttp(made.ctx, request("AI Engineer", 2), "network")));
        const error = (result as { error: PartialCollectError }).error;
        expect(error).toBeInstanceOf(PartialCollectError);
        expect(error.postings.map((p) => p.payload)).toEqual(first.map((p) => p.payload));
        expect(made.calls).toHaveLength(1);
      });

      it("keeps the postings and the original cause when the budget refuses them after the failure", async () => {
        const made = makeContext(pages, extra({ max_pages: 3, fetch_details: false }));
        const refusing: ChannelContext = {
          ...made.ctx,
          budget: {
            ...made.ctx.budget,
            consume: async () => {
              throw interruption("budget_exceeded");
            },
          },
        };
        const result = await settle(createXingChannel({ now: () => NOW }).collect(searchQuery({ maxResults: 200 }), failingHttp(refusing, request("AI Engineer", 2), "network")));
        const error = (result as { error: PartialCollectError }).error;
        expect(error).toBeInstanceOf(PartialCollectError);
        expect(error.cause.code).toBe("network");
        expect(error.postings.map((p) => p.externalId)).toEqual(ids(901100));
      });
    });

    it("rejects an unusable sources.yaml block without any request", async () => {
      const channel = createXingChannel({ now: () => NOW });
      const made = makeContext(site(), { ...extra(), remote_option_id: "" });
      await expect(channel.collect(searchQuery(), made.ctx)).rejects.toBeInstanceOf(ChannelError);
      expect(made.calls).toHaveLength(0);
    });
  });
});

describe("parse", () => {
  async function payloadOf(id: string, windowHours = 5000): Promise<XingPayload> {
    const { postings } = await collectAll({}, searchQuery({ windowHours }), site());
    const posting = postings.find((p) => p.externalId === id);
    if (!posting) throw new Error(`no posting ${id}`);
    return payloadSchema.parse(posting.payload);
  }

  it("maps a posting with an employer-stated salary", async () => {
    const draft = normalizedPostingDraftSchema.parse(parseXingPayload(await payloadOf("90100004")));
    expect(draft).toMatchObject({
      title: "AI Solution Engineer (f/m/d)",
      companyName: "Belegwerk GmbH",
      workplace: "onsite",
      contractHint: "full-time",
      seniorityHint: "Berufseinsteiger·in",
      descriptionLanguage: "de",
      locations: [{ label: "Berlin", city: "Berlin", countryCode: "DE" }],
      salary: { min: 50000, max: 65000, currency: "EUR", period: "year", raw: "50000-65000 EUR/year" },
      salaryText: "50000-65000 EUR/year",
      sourceUrl: "https://www.xing.com/jobs/berlin-ai-solution-engineer-90100004",
      applyUrl: "https://www.xing.com/jobs/berlin-ai-solution-engineer-90100004",
    });
    expect(draft.postedAt).toEqual(new Date("2026-10-07T05:03:30Z"));
    expect(draft.description.length).toBeGreaterThan(300);
    expect(draft.extra).toMatchObject({ xingId: "90100004", discipline: "IT und Softwareentwicklung", hasDescription: true });
  });

  it("never turns XING's salary estimate into the posting's salary (C3) and uses the employer's apply URL", async () => {
    const draft = parseXingPayload(await payloadOf("90100001"));
    expect(draft.salary).toBeNull();
    expect(draft.salaryText).toBeNull();
    expect(draft.extra).toMatchObject({ estimatedSalary: { min: 69000, max: 102000, currency: "EUR" }, thirdPartyApply: true });
    expect(draft.applyUrl).toMatch(/^https:\/\/click\.appcast\.io\//);
    expect(draft.sourceUrl).toBe("https://www.xing.com/jobs/berlin-ai-data-engineer-90100001");
    expect(draft.workplace).toBe("hybrid");
  });

  it("maps a remote posting without a salary, in English", async () => {
    const draft = parseXingPayload(await payloadOf("90100002"));
    expect(draft).toMatchObject({ workplace: "remote", descriptionLanguage: "en", salary: null, salaryText: null });
    expect(draft.extra).not.toHaveProperty("estimatedSalary");
    expect(draft.applyUrl).toBe(draft.sourceUrl);
  });

  it("keeps contact data out of the description", async () => {
    const draft = parseXingPayload(await payloadOf("90100006"));
    expect(draft.description).not.toMatch(/Musterfrau|1234567|@example/);
    expect(draft.description).toContain("[contact removed]");
  });

  it("parses a posting that has only list data", async () => {
    const payload = await payloadOf("90100003");
    expect(payload.detail).toBeNull();
    const draft = normalizedPostingDraftSchema.parse(parseXingPayload(payload));
    expect(draft).toMatchObject({ title: "AI Associate (all genders)", companyName: "Strategiewerk Digital", workplace: "unknown", description: "", descriptionLanguage: "unknown", postedAt: null });
    expect(draft.contractHint).toBe("full-time");
    expect(draft.locations).toEqual([{ label: "Berlin", city: "Berlin", countryCode: null }]);
  });

  it("reads a stated salary without a period as text only", async () => {
    const payload = await payloadOf("90100004");
    const listOnly: XingPayload = { ...payload, detail: null, list: { ...payload.list, salary: { __typename: "SalaryRange", currency: "EUR", minimum: 50000, maximum: 65000 } } };
    const draft = parseXingPayload(listOnly);
    expect(draft.salary).toBeNull();
    expect(draft.salaryText).toBe("50000-65000 EUR");
  });

  it("maps remote options: only a full remote is remote, a mix is hybrid, none is unknown", async () => {
    const payload = await payloadOf("90100004");
    const withOptions = (remoteOptions: string[] | null): XingPayload => ({
      ...payload,
      detail: payload.detail ? { ...payload.detail, job: payload.detail.job ? { ...payload.detail.job, remoteOptions } : null } : null,
    });
    expect(parseXingPayload(withOptions(["FULL_REMOTE"])).workplace).toBe("remote");
    expect(parseXingPayload(withOptions(["PARTLY_REMOTE"])).workplace).toBe("hybrid");
    expect(parseXingPayload(withOptions(["FULL_REMOTE", "NON_REMOTE"])).workplace).toBe("hybrid");
    expect(parseXingPayload(withOptions(["NON_REMOTE"])).workplace).toBe("onsite");
    expect(parseXingPayload(withOptions([])).workplace).toBe("unknown");
    expect(parseXingPayload(withOptions(null)).workplace).toBe("unknown");
  });

  it("fails with a parse error for payloads of the wrong shape or without a title or employer", async () => {
    const payload = await payloadOf("90100003");
    expect(() => parseXingPayload({ nope: true })).toThrow(ChannelError);
    expect(() => parseXingPayload(undefined)).toThrow(/expected shape/);
    expect(() => parseXingPayload({ ...payload, list: { ...payload.list, companyInfo: { companyNameOverride: null } } })).toThrow(/employer/);
    expect(() => parseXingPayload({ ...payload, list: { ...payload.list, title: " " } })).toThrow(ChannelError);
  });
});
