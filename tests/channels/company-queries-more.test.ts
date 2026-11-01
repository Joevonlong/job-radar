// @vitest-environment node
import { describe, expect, it } from "vitest";

import { employerMatcher } from "@/lib/channels/company-match";
import { createChannelContext } from "@/lib/channels/context";
import { buildRequests } from "@/lib/channels/jsearch/query";
import { buildActorInputs, locationFor } from "@/lib/channels/linkedin/apify";
import { buildDiscoveryInputs, timeRangeFor } from "@/lib/channels/linkedin/brightdata";
import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { ChannelRegistry, channelSupportsCompanyQueries, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { createStepstoneChannel } from "@/lib/channels/stepstone";
import { searchUrl as stepstoneSearchUrl } from "@/lib/channels/stepstone/client";
import type { ChannelContext, SearchQuery } from "@/lib/channels/types";
import { createXingChannel } from "@/lib/channels/xing";
import { searchUrl as xingSearchUrl } from "@/lib/channels/xing/client";
import { loadPipeline } from "@/lib/market";

import { channelsWith, shippedChannels } from "./helpers";
import { api as jsearchApi, harness as jsearchHarness, ID_BROKEN, ID_NO_DESCRIPTION, query as jsearchQuery } from "./jsearch/helpers";
import { berlinQuery as apifyQuery } from "./linkedin/apify/helpers";
import { berlinQuery as brightQuery } from "./linkedin/brightdata/helpers";
import { fixtureHtml, htmlResponse, makeContext, searchQuery, type Handler } from "./web/helpers";
import { fixtureMarket } from "../pipeline/helpers";

const market = fixtureMarket();
/** A company query as `buildCompanyQueries` makes it: no city, no remote, the name as the only keyword. */
const asCompany = <T extends SearchQuery>(base: T, name = "Acme"): T => {
  const key = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
  return { ...base, keywords: [name], keywordGroup: `company:${key}`, location: null, remote: false, remoteScope: null, company: { name, key } };
};

describe("the five remaining channels declare company queries", () => {
  const ids = ["linkedin-apify", "linkedin-brightdata", "jsearch", "stepstone", "xing"] as const satisfies readonly ConfiguredChannelId[];

  it("in the config table, so the registry shows the switch", () => {
    for (const id of ids) expect(channelSupportsCompanyQueries(id)).toBe(true);
  });

  it("with the shipped opt-in on, and off when the block opts out", () => {
    const config = shippedChannels();
    for (const id of ids) expect(settingsFromConfig(id, config).companyQueries).toBe(true);
    const optedOut = channelsWith((raw) => {
      (raw.linkedin as Record<string, Record<string, unknown>>).apify!.company_queries = false;
      (raw.sources as Record<string, Record<string, unknown>>).xing!.company_queries = false;
    });
    expect(settingsFromConfig("linkedin-apify", optedOut).companyQueries).toBe(false);
    expect(settingsFromConfig("xing", optedOut).companyQueries).toBe(false);
    expect(settingsFromConfig("linkedin-brightdata", optedOut).companyQueries).toBe(true);
  });

  it("on the registered instances too: the table and the channel agree for every built-in channel", () => {
    const registry = new ChannelRegistry();
    registerBuiltinChannels(registry);
    for (const channel of registry.list()) expect(channel.supportsCompanyQueries === true, channel.id).toBe(channelSupportsCompanyQueries(channel.id));
    for (const id of ids) expect(registry.get(id)?.supportsCompanyQueries).toBe(true);
  });
});

describe("linkedin-apify request", () => {
  const settings = () => {
    const block = shippedChannels().linkedin.apify;
    return { ...block, country_name: block.country_name };
  };

  it("searches the company name in the home country, never the remote input", () => {
    const query = asCompany(apifyQuery());
    expect(locationFor(query, settings(), market)).toBe(market.countryName);
    const [input] = buildActorInputs(query, { ...settings(), remote_input: { workplaceType: "remote" } }, 25, market);
    expect(input).toMatchObject({ keywords: '"Acme"', location: market.countryName, limit: 25 });
    expect(input).not.toHaveProperty("workplaceType");
  });

  it("uses the configured country name when one is set, like a located query", () => {
    expect(locationFor(asCompany(apifyQuery()), { ...settings(), country_name: "Deutschland" }, market)).toBe("Deutschland");
  });

  it("leaves the keyword request unchanged", () => {
    expect(buildActorInputs(apifyQuery(), settings(), 25, market)).toEqual([
      { keywords: '"AI Engineer" OR "LLM Engineer"', location: "Berlin, Germany", datePosted: "r86400", limit: 25 },
    ]);
  });
});

describe("linkedin-brightdata request", () => {
  const settings = () => shippedChannels().linkedin.brightdata;

  it("searches keyword, home country name and country code, without a remote filter", () => {
    const [input, ...rest] = buildDiscoveryInputs(asCompany(brightQuery()), settings(), market);
    expect(rest).toEqual([]);
    expect(input).toEqual({ keyword: '"Acme"', location: market.countryName, country: market.country, time_range: timeRangeFor(24).label });
    expect(input).not.toHaveProperty("remote");
  });

  it("keeps the configured country code", () => {
    const [input] = buildDiscoveryInputs(asCompany(brightQuery()), { ...settings(), country: "AT" }, market);
    expect(input?.country).toBe("AT");
  });

  it("leaves keyword and remote requests unchanged", () => {
    expect(buildDiscoveryInputs(brightQuery(), settings(), market)).toEqual([
      { keyword: '"AI Engineer" OR "LLM Engineer"', location: "Berlin", country: market.country, time_range: timeRangeFor(24).label },
    ]);
    const remote = brightQuery({ location: null, remote: true, remoteScope: "home_country" });
    expect(buildDiscoveryInputs(remote, settings(), market)[0]).toMatchObject({ remote: "Remote" });
  });
});

describe("jsearch request", () => {
  it("is one request, `<company> in <country>`, without the home-office filter", () => {
    expect(buildRequests(asCompany(jsearchQuery()), { keywords_per_query: 5 }, "Germany")).toEqual([{ query: "Acme in Germany", datePosted: "today", remote: false }]);
  });

  it("refuses a company query without a country name", () => {
    expect(() => buildRequests(asCompany(jsearchQuery()), { keywords_per_query: 1 })).toThrow(/country/);
  });

  it("leaves keyword requests unchanged", () => {
    expect(buildRequests(jsearchQuery(), { keywords_per_query: 5 }).map((r) => r.query)).toEqual(["AI Engineer in Berlin", "LLM Engineer in Berlin"]);
  });

  it("sends the company search with the market's country, and no work_from_home", async () => {
    const h = await jsearchHarness(jsearchApi(), { settings: { fetch_details: false } });
    await h.channel.collect(asCompany(jsearchQuery()), h.ctx);
    const search = h.calls.filter((c) => c.url.pathname === "/search");
    expect(search).toHaveLength(1);
    expect(search[0]?.url.searchParams.get("query")).toBe(`Acme in ${market.countryName}`);
    expect(search[0]?.url.searchParams.has("work_from_home")).toBe(false);
  });

  it("books no billed detail request for another employer's posting", async () => {
    const h = await jsearchHarness(jsearchApi(), { settings: { fetch_details: true } });
    const ctx: ChannelContext = { ...h.ctx, employerMatches: (name) => name === "Tafel AI" };
    await h.channel.collect(asCompany(jsearchQuery()), ctx);
    const detail = h.calls.filter((c) => c.url.pathname === "/job-details");
    expect(detail).toHaveLength(1);
    // the posting of the matching employer is asked for, the other one without a description is not
    expect(detail[0]?.url.searchParams.get("job_id")).toBe(ID_NO_DESCRIPTION);
    expect(detail[0]?.url.searchParams.get("job_id")).not.toContain(ID_BROKEN);
  });

  it("asks for both details when no employer check is given (keyword queries)", async () => {
    const h = await jsearchHarness(jsearchApi(), { settings: { fetch_details: true } });
    await h.channel.collect(jsearchQuery(), h.ctx);
    expect(h.calls.find((c) => c.url.pathname === "/job-details")?.url.searchParams.get("job_id")).toBe(`${ID_NO_DESCRIPTION},${ID_BROKEN}`);
  });
});

describe("stepstone", () => {
  const settings = () => shippedChannels().sources.stepstone;
  const NOW = new Date("2026-10-07T12:00:00Z");
  const extra = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...settings(), enabled: true, max_pages: 1, ...over });
  const DETAILS: Record<string, string> = { "90000001": "detail-berlin.html", "90000003": "detail-multicity.html", "90000004": "detail-no-jsonld.html" };
  const site = (log: URL[]): Handler => ({ url }) => {
    if (url.pathname.startsWith("/jobs/")) {
      log.push(url);
      return htmlResponse(200, fixtureHtml("stepstone", Number(url.searchParams.get("page") ?? "1") > 1 ? "search-empty.html" : "search-berlin.html"));
    }
    const file = DETAILS[/-(\d+)-inline\.html$/.exec(url.pathname)?.[1] ?? ""];
    return file ? htmlResponse(200, fixtureHtml("stepstone", file)) : htmlResponse(404, "not found");
  };

  it("builds a nationwide company URL: no city, radius or home-office filter", () => {
    const url = new URL(stepstoneSearchUrl(settings(), { keyword: "Nordlicht Bank", location: null, kind: "company", windowHours: 24, page: 2 }) ?? "");
    expect(url.pathname).toBe("/jobs/nordlicht-bank");
    expect(Object.fromEntries(url.searchParams)).toEqual({ sort: "2", ag: "age_1", page: "2" });
    // a city or the radius cannot slip in through `location` either
    const stray = new URL(stepstoneSearchUrl(settings(), { keyword: "Nordlicht Bank", location: "Berlin", kind: "company", windowHours: 24, page: 1 }) ?? "");
    expect(stray.pathname).toBe("/jobs/nordlicht-bank");
    expect(stray.searchParams.has("radius")).toBe(false);
  });

  it("builds the same URLs as before for city and remote searches", () => {
    const located = new URL(stepstoneSearchUrl(settings(), { keyword: "KI", location: "Berlin", kind: "city", windowHours: 24, page: 1 }) ?? "");
    expect(located.pathname).toBe("/jobs/ki/in-berlin");
    expect(located.searchParams.get("radius")).toBe("30");
    const remote = new URL(stepstoneSearchUrl(settings(), { keyword: "KI", location: null, kind: "remote", windowHours: 24, page: 1 }) ?? "");
    expect(remote.searchParams.get("wfh")).toBe("1");
    expect(stepstoneSearchUrl(settings(), { keyword: "KI", location: "Berlin", windowHours: 24, page: 1 })).toBe(stepstoneSearchUrl(settings(), { keyword: "KI", location: "Berlin", kind: "city", windowHours: 24, page: 1 }));
  });

  const companyQuery = () => asCompany(searchQuery({ windowHours: 24 * 60, maxResults: 10 }), "Nordlicht Bank");

  it("searches nationwide and keeps results whose titles share nothing with the company name", async () => {
    const urls: URL[] = [];
    const { ctx } = makeContext(site(urls), extra({ fetch_details: false }));
    const postings = await createStepstoneChannel({ now: () => NOW }).collect(companyQuery(), ctx);
    expect(urls[0]?.pathname).toBe("/jobs/nordlicht-bank");
    expect(urls[0]?.searchParams.has("radius")).toBe(false);
    expect(urls[0]?.searchParams.has("wfh")).toBe(false);
    expect(postings.length).toBeGreaterThan(3);
  });

  it("opens only the posting pages of the matching employer", async () => {
    const urls: URL[] = [];
    const made = makeContext(site(urls), extra());
    const ctx: ChannelContext = { ...made.ctx, employerMatches: (name) => name === "Nordlicht Bank AG" };
    const postings = await createStepstoneChannel({ now: () => NOW }).collect(companyQuery(), ctx);
    expect(made.calls.filter((c) => !c.url.pathname.startsWith("/jobs/"))).toHaveLength(1);
    expect(made.calls.find((c) => !c.url.pathname.startsWith("/jobs/"))?.url.pathname).toContain("90000001");
    // the others stay list data; the cycle's employer check drops them afterwards
    const byId = new Map(postings.map((p) => [p.externalId, p.payload as { detail: unknown }]));
    expect(byId.get("90000001")?.detail).not.toBeNull();
    expect(byId.get("90000003")?.detail).toBeNull();
  });

  it("does not let other employers use up max_details_per_query", async () => {
    const urls: URL[] = [];
    const made = makeContext(site(urls), extra({ max_details_per_query: 1 }));
    const ctx: ChannelContext = { ...made.ctx, employerMatches: (name) => name === "Muster Analytics Germany GmbH" };
    const postings = await createStepstoneChannel({ now: () => NOW }).collect(companyQuery(), ctx);
    const byId = new Map(postings.map((p) => [p.externalId, p.payload as { detail: unknown }]));
    expect(byId.get("90000003")?.detail).not.toBeNull();
  });

  it("works with the cycle's key matcher, which compares normalized employer names", async () => {
    const urls: URL[] = [];
    const made = makeContext(site(urls), extra({ max_details_per_query: 50 }));
    const matcher = employerMatcher(new Set(["nordlicht-bank"]), loadPipeline());
    const ctx: ChannelContext = { ...made.ctx, employerMatches: matcher };
    await createStepstoneChannel({ now: () => NOW }).collect(companyQuery(), ctx);
    expect(made.calls.filter((c) => !c.url.pathname.startsWith("/jobs/"))).toHaveLength(1);
  });

  it("keyword queries open every page, as before", async () => {
    const urls: URL[] = [];
    const made = makeContext(site(urls), extra());
    await createStepstoneChannel({ now: () => NOW }).collect(searchQuery(), made.ctx);
    expect(made.calls.filter((c) => !c.url.pathname.startsWith("/jobs/")).length).toBeGreaterThan(1);
  });
});

describe("xing", () => {
  const settings = () => shippedChannels().sources.xing;
  const NOW = new Date("2026-10-07T12:00:00Z");
  const extra = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...settings(), enabled: true, max_pages: 1, ...over });
  const DETAILS: Record<string, string> = { "90100001": "detail-third-party.html", "90100002": "detail-remote-nosalary.html", "90100004": "detail-salary-range.html", "90100006": "detail-estimate-remote.html" };
  const site = (log: URL[]): Handler => ({ url }) => {
    if (url.pathname.startsWith("/jobs/search")) {
      log.push(url);
      return htmlResponse(200, fixtureHtml("xing", "search-berlin.html"));
    }
    const file = DETAILS[/-(\d+)$/.exec(url.pathname)?.[1] ?? ""];
    return file ? htmlResponse(200, fixtureHtml("xing", file)) : htmlResponse(404, "not found");
  };

  it("builds a nationwide company URL: no city, radius or remote option", () => {
    const url = new URL(xingSearchUrl(settings(), { keyword: "Prüfwerk Partner", location: null, kind: "company", page: 1 }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ keywords: "Prüfwerk Partner" });
    const stray = new URL(xingSearchUrl(settings(), { keyword: "Prüfwerk Partner", location: "Berlin", kind: "company", page: 2 }));
    expect(Object.fromEntries(stray.searchParams)).toEqual({ keywords: "Prüfwerk Partner", page: "2" });
  });

  it("builds the same URLs as before for city and remote searches", () => {
    const located = new URL(xingSearchUrl(settings(), { keyword: "KI", location: "Berlin", page: 1 }));
    expect(Object.fromEntries(located.searchParams)).toEqual({ keywords: "KI", location: "Berlin", radius: "30" });
    const remote = new URL(xingSearchUrl(settings(), { keyword: "KI", location: null, kind: "remote", page: 1 }));
    expect(remote.searchParams.get("remoteOption")).toBe(settings().remote_option_id);
    expect(xingSearchUrl(settings(), { keyword: "KI", location: "Berlin", page: 1 })).toBe(xingSearchUrl(settings(), { keyword: "KI", location: "Berlin", kind: "city", page: 1 }));
  });

  const companyQuery = () => asCompany(searchQuery({ windowHours: 24 * 365, maxResults: 10 }), "Prüfwerk Partner");

  it("searches nationwide with no title filter", async () => {
    const urls: URL[] = [];
    const { ctx } = makeContext(site(urls), extra({ fetch_details: false }));
    const postings = await createXingChannel({ now: () => NOW }).collect(companyQuery(), ctx);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ keywords: "Prüfwerk Partner" });
    expect(postings.length).toBe(6);
  });

  it("opens only the posting pages of the matching employer", async () => {
    const urls: URL[] = [];
    const made = makeContext(site(urls), extra());
    const ctx: ChannelContext = { ...made.ctx, employerMatches: (name) => name === "Prüfwerk Partner" };
    await createXingChannel({ now: () => NOW }).collect(companyQuery(), ctx);
    const pages = made.calls.filter((c) => !c.url.pathname.startsWith("/jobs/search"));
    expect(pages.map((c) => /-(\d+)$/.exec(c.url.pathname)?.[1])).toEqual(["90100001"]);
  });

  it("keyword queries open every page, as before", async () => {
    const urls: URL[] = [];
    const made = makeContext(site(urls), extra());
    await createXingChannel({ now: () => NOW }).collect(searchQuery({ windowHours: 24 * 365 }), made.ctx);
    expect(made.calls.filter((c) => !c.url.pathname.startsWith("/jobs/search")).length).toBeGreaterThan(1);
  });
});

describe("employerMatcher", () => {
  const pipeline = loadPipeline();
  const matches = employerMatcher(new Set(["acme", "other"]), pipeline);

  it("compares the normalized key, ignoring legal suffixes and spacing", () => {
    expect(matches("Acme GmbH")).toBe(true);
    expect(matches("  OTHER  ")).toBe(true);
    expect(matches("Agency")).toBe(false);
    expect(matches("Acme Products")).toBe(false);
  });

  it("cannot rule out an entry that names no employer", () => {
    expect(matches(null)).toBe(true);
    expect(matches(undefined)).toBe(true);
    expect(matches("   ")).toBe(true);
  });
});

describe("the context carries the employer check only when given", () => {
  it("is absent by default and passed through when set", () => {
    const base = { channelId: "x", settings: { enabled: true, companyQueries: true, maxResults: 1, monthlyBudgetUsd: 0, freeRecordsPerMonth: 0, throttle: { minDelayMs: 0, maxDelayMs: 0 }, extra: {} }, http: { timeoutMs: 1, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, budget: { snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }), canAfford: () => true, consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }) }, signal: new AbortController().signal, cycle: { id: null, kind: "manual" as const } };
    expect(createChannelContext(base).employerMatches).toBeUndefined();
    const check = (): boolean => false;
    expect(createChannelContext({ ...base, employerMatches: check }).employerMatches).toBe(check);
  });
});
