// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { arbeitsagenturChannel, interleave } from "@/lib/channels/arbeitsagentur";
import { detailUrl, publishedDays, searchUrl } from "@/lib/channels/arbeitsagentur/client";
import { redactContacts } from "@/lib/channels/arbeitsagentur/redact";
import { parseArbeitsagenturPayload } from "@/lib/channels/arbeitsagentur/parse";
import { createChannelContext } from "@/lib/channels/context";
import { ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { MIN_DETAILS_FOR_LAYOUT_CHECK } from "@/lib/channels/details";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { queryId } from "@/lib/channels/query";
import { ChannelRegistry, settingsFromConfig } from "@/lib/channels/registry";
import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { normalizedPostingDraftSchema, type ChannelContext, type HttpResponse, type KnownPostings, type SearchQuery } from "@/lib/channels/types";
import { arbeitsagenturSettingsSchema, type ArbeitsagenturSettings } from "@/lib/config";

import { channelsWith, failingHttp, interruption, INTERRUPTIONS, shippedChannels } from "./helpers";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/arbeitsagentur");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

const SEARCH_PAGE = fixture("search-page.json");
const SEARCH_EMPTY = fixture("search-empty.json");
const SEARCH_REMOTE = fixture("search-remote-page.json");
const DETAIL_MULTI = fixture("detail-multi-location.json");
const DETAIL_SALARY = fixture("detail-salary.json");
const REF_MULTI = "10001-0000000012-S";
const REF_SALARY = "10000-0000000015-S";
const ITEMS = SEARCH_PAGE.ergebnisliste as Array<Record<string, unknown>>;

const settings = (): ArbeitsagenturSettings => shippedChannels().sources.arbeitsagentur;

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

interface Call {
  url: URL;
  headers: Record<string, string>;
}

type Handler = (call: Call, n: number) => HttpResponse | Error;

function makeContext(handler: Handler, overrides: Partial<ArbeitsagenturSettings> = {}, options: { maxRetries?: number; records?: LogRecord[]; known?: KnownPostings } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const merged = { ...settings(), ...overrides };
  const ctx: ChannelContext = createChannelContext({
    channelId: "arbeitsagentur",
    settings: {
      enabled: true,
      maxResults: merged.max_results,
      monthlyBudgetUsd: 0,
      freeRecordsPerMonth: 0,
      throttle: { minDelayMs: 1, maxDelayMs: 1 },
      extra: merged,
    },
    http: { timeoutMs: 1000, maxRetries: options.maxRetries ?? 0, backoffBaseMs: 10, backoffMaxMs: 5000 },
    budget: {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }),
    },
    signal: new AbortController().signal,
    cycle: { id: null, kind: "manual" },
    logger: createLogger({ sink: (r) => options.records?.push(r), minLevel: "debug" }),
    ...(options.known ? { known: options.known } : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    fetch: async (url, init) => {
      const call: Call = { url: new URL(url), headers: init.headers ?? {} };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { ctx, calls, sleeps };
}

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  const keywords = overrides.keywords ?? ["KI Engineer"];
  return {
    id: queryId({ keywords, keywordGroup: "engineering", location: "Berlin", remote: false, remoteScope: null }),
    keywords,
    keywordGroup: "engineering",
    location: "Berlin",
    remote: false,
    remoteScope: null,
    windowHours: 24,
    maxResults: 25,
    ...overrides,
  };
}

/** Routes search requests to `pages` and detail requests to `details` (by refnr); anything else is a 404. */
function api(options: { pages?: Array<Record<string, unknown>>; details?: Record<string, Record<string, unknown>> } = {}): Handler {
  const pages = options.pages ?? [SEARCH_PAGE];
  const details = options.details ?? { [REF_MULTI]: DETAIL_MULTI, [REF_SALARY]: DETAIL_SALARY };
  return ({ url }) => {
    if (url.pathname.endsWith("/pc/v6/jobs")) {
      const page = Number(url.searchParams.get("page"));
      return response(200, pages[page - 1] ?? SEARCH_EMPTY);
    }
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const refnr = Buffer.from(id, "base64").toString("utf8");
    const detail = details[refnr];
    return detail ? response(200, detail) : response(404, { messages: [{ code: "STELLENANGEBOT_NICHT_GEFUNDEN" }] });
  };
}

const isSearch = (c: Call) => c.url.pathname.endsWith("/pc/v6/jobs");

describe("request building", () => {
  it("builds the search url from config and the query, with the public key header", async () => {
    const { ctx, calls } = makeContext(api(), { fetch_details: false });
    await arbeitsagenturChannel.collect(query({ windowHours: 10 }), ctx);
    const [first] = calls;
    expect(first).toBeDefined();
    expect(first?.url.origin + first?.url.pathname).toBe("https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs");
    expect(Object.fromEntries(first?.url.searchParams ?? [])).toEqual({
      was: "KI Engineer",
      wo: "Berlin",
      umkreis: "30",
      veroeffentlichtseit: "1",
      page: "1",
      size: "25",
    });
    expect(first?.headers["X-API-Key"]).toBe(settings().api_key);
  });

  it("converts the look-back window to whole days within the API range", () => {
    expect(publishedDays(10)).toBe(1);
    expect(publishedDays(24)).toBe(1);
    expect(publishedDays(25)).toBe(2);
    expect(publishedDays(0)).toBe(1);
    expect(publishedDays(24 * 365)).toBe(100);
  });

  it("uses radius, page size and base url from the settings", () => {
    const s = { ...settings(), radius_km: 12, base_url: "https://example.test/svc/" };
    const url = new URL(searchUrl(s, { term: "a&b", location: "München", windowHours: 48, page: 3, size: 7 }));
    expect(url.href.startsWith("https://example.test/svc/pc/v6/jobs?")).toBe(true);
    expect(url.searchParams.get("was")).toBe("a&b");
    expect(url.searchParams.get("umkreis")).toBe("12");
    expect(url.searchParams.get("veroeffentlichtseit")).toBe("2");
    expect(detailUrl(s, REF_MULTI)).toBe(`https://example.test/svc/pc/v4/jobdetails/${Buffer.from(REF_MULTI).toString("base64")}`);
  });
});

describe("collect: list and details", () => {
  it("returns every posting verbatim with its detail", async () => {
    const { ctx, calls } = makeContext(api());
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result.map((r) => r.externalId)).toEqual(ITEMS.map((i) => i.referenznummer));
    expect(result[0]?.url).toBe(`https://www.arbeitsagentur.de/jobsuche/jobdetail/${REF_MULTI}`);
    expect(result[0]?.postedAt).toEqual(new Date("2026-10-05T00:00:00Z"));
    // list item untouched (C1), detail attached
    expect(result[0]?.payload).toEqual({ list: ITEMS[0], detail: DETAIL_MULTI });
    // postings without a fetchable detail (404) keep list data only
    expect(result[2]?.payload).toEqual({ list: ITEMS[2], detail: null });
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(ITEMS.length);
  });

  it("does not fetch details when fetch_details is off", async () => {
    const { ctx, calls } = makeContext(api(), { fetch_details: false });
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result).toHaveLength(ITEMS.length);
    expect(calls.every(isSearch)).toBe(true);
    expect(result.every((r) => (r.payload as { detail: unknown }).detail === null)).toBe(true);
  });

  it("reuses the stored detail of known postings instead of fetching it", async () => {
    const stored = { list: { ...ITEMS[0], titel: "older list data" }, detail: DETAIL_MULTI };
    const known: KnownPostings = { payloads: async () => new Map([[REF_MULTI, stored]]) };
    const { ctx, calls } = makeContext(api(), {}, { known });
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    // fresh list data, stored detail; no request for the known posting
    expect(result[0]?.payload).toEqual({ list: ITEMS[0], detail: DETAIL_MULTI });
    const detailCalls = calls.filter((c) => !isSearch(c));
    expect(detailCalls).toHaveLength(ITEMS.length - 1);
    expect(detailCalls.some((c) => c.url.pathname.endsWith(Buffer.from(REF_MULTI).toString("base64")))).toBe(false);
  });

  it("fetches the detail of a known posting stored without one", async () => {
    const known: KnownPostings = { payloads: async () => new Map([[REF_MULTI, { list: ITEMS[0], detail: null }]]) };
    const { ctx, calls } = makeContext(api(), {}, { known });
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result[0]?.payload).toEqual({ list: ITEMS[0], detail: DETAIL_MULTI });
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(ITEMS.length);
  });

  it("fetches every detail when reuse_known_details is off", async () => {
    const known: KnownPostings = { payloads: async () => new Map([[REF_MULTI, { list: ITEMS[0], detail: DETAIL_MULTI }]]) };
    const { ctx, calls } = makeContext(api(), { reuse_known_details: false }, { known });
    await arbeitsagenturChannel.collect(query(), ctx);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(ITEMS.length);
  });

  it("falls back to fetching when the known-postings lookup fails", async () => {
    const records: LogRecord[] = [];
    const known: KnownPostings = {
      payloads: async () => {
        throw new Error("db down");
      },
    };
    const { ctx, calls } = makeContext(api(), {}, { known, records });
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result[0]?.payload).toEqual({ list: ITEMS[0], detail: DETAIL_MULTI });
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(ITEMS.length);
    expect(records.some((r) => r.message.includes("known postings lookup failed"))).toBe(true);
  });

  it("spends the detail limit on unknown postings only", async () => {
    const known: KnownPostings = { payloads: async () => new Map([[REF_MULTI, { list: ITEMS[0], detail: DETAIL_MULTI }]]) };
    const { ctx, calls } = makeContext(api(), { max_details_per_query: 1 }, { known });
    await arbeitsagenturChannel.collect(query(), ctx);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(1);
  });

  it("limits detail requests per query", async () => {
    const { ctx, calls } = makeContext(api(), { max_details_per_query: 2 });
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result).toHaveLength(ITEMS.length);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(2);
  });

  it("keeps list data and stops fetching details after a server error on a detail", async () => {
    const records: LogRecord[] = [];
    const handler = api();
    const { ctx, calls } = makeContext(
      (call, n) => (isSearch(call) ? handler(call, n) : response(503, "unavailable")),
      {},
      { records },
    );
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result).toHaveLength(ITEMS.length);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(1);
    expect(records.some((r) => r.level === "warn")).toBe(true);
  });

  it("redacts contact data from the stored description", async () => {
    const detail = { ...DETAIL_MULTI, stellenangebotsBeschreibung: "Fragen? Ansprechpartner: Erika Muster\nMail erika@example.test oder +49 30 1234 5678." };
    const { ctx } = makeContext(api({ details: { [REF_MULTI]: detail } }));
    const [first] = await arbeitsagenturChannel.collect(query(), ctx);
    const stored = JSON.stringify(first?.payload);
    expect(stored).not.toMatch(/Erika|example\.test|1234/);
  });

  it("records the postings against the budget", async () => {
    const consume = vi.fn(async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }));
    const { ctx } = makeContext(api(), { fetch_details: false });
    const result = await arbeitsagenturChannel.collect(query(), { ...ctx, budget: { ...ctx.budget, consume } });
    expect(consume).toHaveBeenCalledWith(result.length);
  });
});

describe("collect: a detail request fails", () => {
  const REFS = ITEMS.map((i) => i.referenznummer);
  const UNREADABLE = { stellenangebotsTitel: 42 };
  /** api(), except that the `nth` detail request (1-based) gets `answer`. */
  const nthDetail = (nth: number, answer: () => HttpResponse): Handler => {
    const base = api();
    let details = 0;
    return (call, n) => {
      if (isSearch(call)) return base(call, n);
      details += 1;
      return details === nth ? answer() : base(call, n);
    };
  };
  const detailOf = (payload: unknown): unknown => (payload as { detail: unknown }).detail;

  const STOPS = [
    { status: 429, code: "rate_limited" },
    { status: 403, code: "blocked" },
    { status: 401, code: "auth_expired" },
  ] as const;
  for (const { status, code } of STOPS) {
    it(`hands over every search result when the 2nd detail answers ${status}, asks for no more details and keeps ${code}`, async () => {
      const { ctx, calls } = makeContext(nthDetail(2, () => response(status, "")));
      const error = await arbeitsagenturChannel.collect(query(), ctx).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PartialCollectError);
      const partial = error as PartialCollectError;
      expect(partial.cause).toBeInstanceOf(ChannelError);
      expect(partial.cause).toMatchObject({ code, status });
      expect(partial.postings.map((p) => p.externalId)).toEqual(REFS);
      expect(partial.postings[0]?.payload).toEqual({ list: ITEMS[0], detail: DETAIL_MULTI });
      expect(partial.postings.slice(1).every((p) => detailOf(p.payload) === null)).toBe(true);
      expect(calls.filter((c) => !isSearch(c))).toHaveLength(2);
    });
  }

  it("keeps the stored detail of a known posting when the details stop, with reuse_known_details off", async () => {
    const known: KnownPostings = { payloads: async () => new Map([[REF_SALARY, { list: ITEMS[3], detail: DETAIL_SALARY }]]) };
    const { ctx, calls } = makeContext(nthDetail(2, () => response(429, "")), { reuse_known_details: false }, { known });
    const error = await arbeitsagenturChannel.collect(query(), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialCollectError);
    const partial = error as PartialCollectError;
    expect(partial.cause.code).toBe("rate_limited");
    expect(partial.postings.map((p) => detailOf(p.payload))).toEqual([DETAIL_MULTI, null, null, DETAIL_SALARY, null]);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(2);
  });

  it("counts an unreadable detail and reads on: every search result is kept", async () => {
    const records: LogRecord[] = [];
    const { ctx, calls } = makeContext(nthDetail(2, () => response(200, UNREADABLE)), {}, { records });
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result.map((p) => p.externalId)).toEqual(REFS);
    expect(result[0]?.payload).toEqual({ list: ITEMS[0], detail: DETAIL_MULTI });
    expect(result[1]?.payload).toEqual({ list: ITEMS[1], detail: null });
    expect(result[3]?.payload).toEqual({ list: ITEMS[3], detail: DETAIL_SALARY });
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(ITEMS.length);
    expect(records.some((r) => r.level === "warn" && r.fields.code === "parse")).toBe(true);
  });

  const unreadable = (): Handler => {
    const list = api();
    return (call, n) => (isSearch(call) ? list(call, n) : response(200, UNREADABLE));
  };
  const layoutChange = async (ctx: ChannelContext, details: number) => {
    const error = await arbeitsagenturChannel.collect(query(), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialCollectError);
    const partial = error as PartialCollectError;
    expect(partial.cause).toBeInstanceOf(ChannelError);
    expect(partial.cause.code).toBe("parse");
    expect(partial.postings.map((p) => p.externalId)).toEqual(REFS);
    expect(partial.postings.every((p) => detailOf(p.payload) === null)).toBe(true);
    expect(partial.cause.message).toContain(`none of the ${details} detail pages`);
  };

  it("hands the list results on with a parse failure when no detail of a large enough sample can be read (the API changed)", async () => {
    const { ctx, calls } = makeContext(unreadable(), { max_details_per_query: MIN_DETAILS_FOR_LAYOUT_CHECK });
    await layoutChange(ctx, MIN_DETAILS_FOR_LAYOUT_CHECK);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(MIN_DETAILS_FOR_LAYOUT_CHECK);
  });

  it("takes a max_details_per_query below the minimum as the sample when every detail it allows is unreadable", async () => {
    const { ctx, calls } = makeContext(unreadable(), { max_details_per_query: MIN_DETAILS_FOR_LAYOUT_CHECK - 1 });
    await layoutChange(ctx, MIN_DETAILS_FOR_LAYOUT_CHECK - 1);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(MIN_DETAILS_FOR_LAYOUT_CHECK - 1);
  });

  it("keeps the list data and warns when too few details were tried to tell a changed API", async () => {
    const records: LogRecord[] = [];
    // every posting but the last is stored with its detail: one detail request is left
    const stored = new Map(ITEMS.slice(0, -1).map((item) => [String(item.referenznummer), { list: item, detail: DETAIL_MULTI }]));
    const known: KnownPostings = { payloads: async () => stored };
    const { ctx, calls } = makeContext(unreadable(), {}, { records, known });
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(1);
    expect(result.map((p) => p.externalId)).toEqual(REFS);
    expect(detailOf(result.at(-1)?.payload)).toBeNull();
    expect(records.some((r) => r.level === "warn" && /too few/.test(r.message))).toBe(true);
  });

  it("accepts a detail that sends null for optional fields, stores it as sent and reads null as not stated", async () => {
    const detail = {
      ...DETAIL_MULTI,
      firma: null,
      homeofficemoeglich: null,
      verguetungsangabe: null,
      externeURL: null,
      stellenlokationen: [{ adresse: { ort: "Hannover", plz: null, land: null }, breite: null, laenge: 9.75 }],
      veroeffentlichungszeitraum: { von: null },
    };
    const { ctx } = makeContext(api({ details: { [REF_MULTI]: detail } }));
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result[0]?.payload).toEqual({ list: ITEMS[0], detail });
    const withoutNulls = JSON.parse(JSON.stringify(detail, (_key, value: unknown) => (value === null ? undefined : value))) as unknown;
    const draft = parseArbeitsagenturPayload(result[0]?.payload);
    expect(draft).toEqual(parseArbeitsagenturPayload({ list: ITEMS[0], detail: withoutNulls }));
    expect(draft.companyName).toBe("Praxissoft Nord GmbH");
    expect(draft.workplace).toBe("hybrid");
    expect(draft.locations).toEqual([{ label: "Hannover", city: "Hannover", countryCode: null }]);
  });
});

describe("collect: pagination", () => {
  const page = (n: number, count: number, total: number) => ({
    maxErgebnisse: total,
    page: n,
    size: 2,
    ergebnisliste: Array.from({ length: count }, (_, i) => ({ ...ITEMS[0], referenznummer: `P${n}-${i}` })),
  });
  const noDetails = { fetch_details: false, page_size: 2 } as const;

  it("walks pages until the reported total is reached", async () => {
    const pages = [page(1, 2, 5), page(2, 2, 5), page(3, 1, 5)];
    const { ctx, calls } = makeContext(api({ pages }), noDetails);
    const result = await arbeitsagenturChannel.collect(query({ maxResults: 100 }), ctx);
    expect(result).toHaveLength(5);
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("stops at maxResults", async () => {
    const pages = [page(1, 2, 50), page(2, 2, 50), page(3, 2, 50)];
    const { ctx, calls } = makeContext(api({ pages }), noDetails);
    const result = await arbeitsagenturChannel.collect(query({ maxResults: 3 }), ctx);
    expect(result).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("stops at an empty page even when the total says there is more", async () => {
    const pages = [page(1, 2, 50), { maxErgebnisse: 50, page: 2, size: 2 }];
    const { ctx, calls } = makeContext(api({ pages }), noDetails);
    const result = await arbeitsagenturChannel.collect(query({ maxResults: 100 }), ctx);
    expect(result).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("never asks for a page larger than maxResults", async () => {
    const { ctx, calls } = makeContext(api(), { fetch_details: false, page_size: 50 });
    await arbeitsagenturChannel.collect(query({ maxResults: 4 }), ctx);
    expect(calls[0]?.url.searchParams.get("size")).toBe("4");
  });

  it("waits between requests (throttle) but not before the first", async () => {
    const pages = [page(1, 2, 4), page(2, 2, 4)];
    const { ctx, sleeps } = makeContext(api({ pages }), noDetails);
    await arbeitsagenturChannel.collect(query({ maxResults: 100 }), ctx);
    expect(sleeps).toEqual([1]);
  });
});

describe("collect: empty results and keywords", () => {
  it("returns nothing for an empty result", async () => {
    const { ctx, calls } = makeContext(api({ pages: [SEARCH_EMPTY] }));
    expect(await arbeitsagenturChannel.collect(query(), ctx)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("searches every keyword and merges the results without duplicates, one from each in turn", async () => {
    const mk = (refs: string[]) => ({ maxErgebnisse: refs.length, ergebnisliste: refs.map((r) => ({ ...ITEMS[0], referenznummer: r })) });
    const byTerm: Record<string, Record<string, unknown>> = {
      a: mk(["A1", "A2", "SHARED", "A4"]),
      b: mk(["B1", "SHARED", "B3"]),
    };
    const { ctx, calls } = makeContext((call) => response(200, byTerm[call.url.searchParams.get("was") ?? ""] ?? SEARCH_EMPTY), { fetch_details: false });
    const result = await arbeitsagenturChannel.collect(query({ keywords: ["a", "b"], maxResults: 5 }), ctx);
    expect(result.map((r) => r.externalId)).toEqual(["A1", "B1", "A2", "SHARED", "B3"]);
    expect(calls.map((c) => c.url.searchParams.get("was"))).toEqual(["a", "b"]);
  });

  it("interleave dedupes and respects the limit", () => {
    const items = (...refs: string[]) => refs.map((referenznummer) => ({ referenznummer }));
    expect(interleave([items("1", "2"), items("2", "3")], 10).map((i) => i.referenznummer)).toEqual(["1", "2", "3"]);
    expect(interleave([items("1", "2", "3")], 2)).toHaveLength(2);
    expect(interleave([], 5)).toEqual([]);
  });
});

describe("collect: remote queries", () => {
  const remoteQuery = (overrides: Partial<SearchQuery> = {}) =>
    query({ location: null, remote: true, remoteScope: "home_country", ...overrides });
  const REMOTE_ITEMS = SEARCH_REMOTE.ergebnisliste as Array<Record<string, unknown>>;
  const flagged = REMOTE_ITEMS.filter((i) => i.homeofficemoeglich === true).map((i) => i.referenznummer);

  it("searches all of Germany: no city, no radius, same keyword and window", async () => {
    const { ctx, calls } = makeContext(api({ pages: [SEARCH_REMOTE] }), { fetch_details: false });
    await arbeitsagenturChannel.collect(remoteQuery({ windowHours: 48 }), ctx);
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      was: "KI Engineer",
      veroeffentlichtseit: "2",
      page: "1",
      size: String(settings().page_size),
    });
  });

  it("keeps only postings that offer home office", async () => {
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.length).toBeLessThan(REMOTE_ITEMS.length);
    const { ctx } = makeContext(api({ pages: [SEARCH_REMOTE], details: {} }), { fetch_details: false });
    const result = await arbeitsagenturChannel.collect(remoteQuery(), ctx);
    expect(result.map((r) => r.externalId)).toEqual(flagged);
    for (const r of result) {
      expect(arbeitsagenturChannel.parse(r.payload).workplace).toMatch(/^(remote|hybrid)$/);
    }
  });

  it("can keep every posting of the Germany-wide search when the switch is off", async () => {
    const { ctx } = makeContext(api({ pages: [SEARCH_REMOTE] }), { fetch_details: false, remote_requires_home_office: false });
    const result = await arbeitsagenturChannel.collect(remoteQuery(), ctx);
    expect(result).toHaveLength(REMOTE_ITEMS.length);
  });

  const pageOf = (n: number, flaggedCount: number, total: number) => ({
    maxErgebnisse: total,
    page: n,
    size: 4,
    ergebnisliste: Array.from({ length: 4 }, (_, i) => ({ ...REMOTE_ITEMS[0], referenznummer: `R${n}-${i}`, homeofficemoeglich: i < flaggedCount })),
  });

  it("scans further pages until enough home-office postings are found", async () => {
    const pages = [pageOf(1, 1, 40), pageOf(2, 1, 40), pageOf(3, 1, 40), pageOf(4, 1, 40)];
    const { ctx, calls } = makeContext(api({ pages }), { fetch_details: false, page_size: 4, remote_max_pages: 10 });
    const result = await arbeitsagenturChannel.collect(remoteQuery({ maxResults: 3 }), ctx);
    expect(result.map((r) => r.externalId)).toEqual(["R1-0", "R2-0", "R3-0"]);
    expect(calls).toHaveLength(3);
  });

  it("stops scanning at remote_max_pages", async () => {
    const pages = [pageOf(1, 0, 400), pageOf(2, 0, 400), pageOf(3, 1, 400)];
    const { ctx, calls } = makeContext(api({ pages }), { fetch_details: false, page_size: 4, remote_max_pages: 2 });
    expect(await arbeitsagenturChannel.collect(remoteQuery({ maxResults: 5 }), ctx)).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("fetches details only for the postings it kept", async () => {
    const { ctx, calls } = makeContext(api({ pages: [SEARCH_REMOTE], details: {} }));
    const result = await arbeitsagenturChannel.collect(remoteQuery(), ctx);
    expect(calls.filter((c) => !isSearch(c))).toHaveLength(result.length);
  });
});

describe("collect: a later page or keyword fails", () => {
  /** Search pages of two postings per keyword (`<term>-<page>-<i>`), `pages` of them; no details. */
  const byTerm =
    (pages: number): Handler =>
    ({ url }) => {
      if (!isSearch({ url, headers: {} })) return response(404, {});
      const term = url.searchParams.get("was") ?? "";
      const n = Number(url.searchParams.get("page"));
      return response(200, { maxErgebnisse: pages * 2, ergebnisliste: [0, 1].map((i) => ({ ...ITEMS[0], referenznummer: `${term}-${n}-${i}` })) });
    };
  const searchCall = (term: string, page: number) => (url: URL) => isSearch({ url, headers: {} }) && url.searchParams.get("was") === term && url.searchParams.get("page") === String(page);
  const outcome = (ctx: ChannelContext, q: SearchQuery) => arbeitsagenturChannel.collect(q, ctx).then((value) => ({ value }), (error: unknown) => ({ error }));

  for (const kind of INTERRUPTIONS) {
    it(`keeps the postings of earlier pages when page 2 fails (${kind}) and passes the failure on unchanged`, async () => {
      const made = makeContext(byTerm(3), { fetch_details: false, page_size: 2 });
      const ctx = failingHttp(made.ctx, searchCall("a", 2), kind);
      const result = await outcome(ctx, query({ keywords: ["a"], maxResults: 100 }));
      expect(result).toMatchObject({ error: { name: "PartialCollectError", cause: { code: kind, retryable: interruption(kind).retryable } } });
      const error = (result as { error: PartialCollectError }).error;
      expect(error).toBeInstanceOf(PartialCollectError);
      expect(error.cause).toBeInstanceOf(ChannelError);
      expect(error.postings.map((p) => p.externalId)).toEqual(["a-1-0", "a-1-1"]);
      // nothing is asked after the failure
      expect(made.calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1"]);
    });

    it(`keeps earlier keywords and the fetched pages of the unfinished one when a later keyword fails (${kind})`, async () => {
      const made = makeContext(byTerm(2), { fetch_details: false, page_size: 2 });
      const ctx = failingHttp(made.ctx, searchCall("b", 2), kind);
      const result = await outcome(ctx, query({ keywords: ["a", "b", "c"], maxResults: 100 }));
      const error = (result as { error: PartialCollectError }).error;
      expect(error).toBeInstanceOf(PartialCollectError);
      expect(error.cause.code).toBe(kind);
      expect(error.postings.map((p) => p.externalId).sort()).toEqual(["a-1-0", "a-1-1", "a-2-0", "a-2-1", "b-1-0", "b-1-1"]);
      // keyword "c" is never searched
      expect(made.calls.map((c) => c.url.searchParams.get("was"))).toEqual(["a", "a", "b"]);
    });

    it(`fails as before when the first page fails (${kind}): nothing was fetched`, async () => {
      const made = makeContext(byTerm(3), { fetch_details: false, page_size: 2 });
      const ctx = failingHttp(made.ctx, searchCall("a", 1), kind);
      const result = await outcome(ctx, query({ keywords: ["a", "b"], maxResults: 100 }));
      expect((result as { error: unknown }).error).toBeInstanceOf(ChannelError);
      expect((result as { error: ChannelError }).error.code).toBe(kind);
      expect(made.calls).toHaveLength(0);
    });
  }

  it("asks for no details after the failure, but keeps the stored detail of known postings", async () => {
    const stored = { list: ITEMS[0], detail: DETAIL_MULTI };
    const known: KnownPostings = { payloads: async () => new Map([["a-1-0", stored]]) };
    const made = makeContext(byTerm(3), { page_size: 2 }, { known });
    const ctx = failingHttp(made.ctx, searchCall("a", 2), "network");
    const error = (await outcome(ctx, query({ keywords: ["a"], maxResults: 100 })) as { error: PartialCollectError }).error;
    expect(error).toBeInstanceOf(PartialCollectError);
    expect(error.postings.map((p) => (p.payload as { detail: unknown }).detail)).toEqual([DETAIL_MULTI, null]);
    expect(made.calls.filter((c) => !isSearch(c))).toHaveLength(0);
  });

  it("counts the kept postings against the budget", async () => {
    const consume = vi.fn(async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }));
    const made = makeContext(byTerm(3), { fetch_details: false, page_size: 2 });
    const ctx = failingHttp({ ...made.ctx, budget: { ...made.ctx.budget, consume } }, searchCall("a", 2), "network");
    await outcome(ctx, query({ keywords: ["a"], maxResults: 100 }));
    expect(consume).toHaveBeenCalledWith(2);
  });

  it("keeps the stored detail of a known posting with reuse_known_details off", async () => {
    const stored = { list: ITEMS[0], detail: DETAIL_MULTI };
    const known: KnownPostings = { payloads: async () => new Map([["a-1-0", stored]]) };
    const made = makeContext(byTerm(3), { page_size: 2, reuse_known_details: false }, { known });
    const ctx = failingHttp(made.ctx, searchCall("a", 2), "network");
    const error = (await outcome(ctx, query({ keywords: ["a"], maxResults: 100 })) as { error: PartialCollectError }).error;
    expect(error).toBeInstanceOf(PartialCollectError);
    expect(error.postings.map((p) => (p.payload as { detail: unknown }).detail)).toEqual([DETAIL_MULTI, null]);
    expect(made.calls.filter((c) => !isSearch(c))).toHaveLength(0);
  });

  it("keeps the postings and the original cause when the budget refuses them after the failure", async () => {
    const consume = vi.fn(async () => {
      throw interruption("budget_exceeded");
    });
    const made = makeContext(byTerm(3), { fetch_details: false, page_size: 2 });
    const ctx = failingHttp({ ...made.ctx, budget: { ...made.ctx.budget, consume } }, searchCall("a", 2), "network");
    const error = (await outcome(ctx, query({ keywords: ["a"], maxResults: 100 })) as { error: PartialCollectError }).error;
    expect(error).toBeInstanceOf(PartialCollectError);
    expect(error.cause.code).toBe("network");
    expect(error.postings).toHaveLength(2);
  });
});

describe("error classification and retries", () => {
  const search = (handler: Handler, maxRetries = 0) => makeContext(handler, { fetch_details: false }, { maxRetries });
  const code = async (ctx: ChannelContext): Promise<ChannelError> => {
    const error = await arbeitsagenturChannel.collect(query(), ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChannelError);
    return error as ChannelError;
  };

  it("retries 429 with Retry-After and then succeeds", async () => {
    const { ctx, calls, sleeps } = search((_c, n) => (n === 0 ? response(429, "", { "Retry-After": "2" }) : response(200, SEARCH_PAGE)), 3);
    const result = await arbeitsagenturChannel.collect(query(), ctx);
    expect(result).toHaveLength(ITEMS.length);
    expect(calls.filter(isSearch)).toHaveLength(2);
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(2000);
  });

  it("gives up on persistent 429 as rate_limited after the configured retries", async () => {
    const { ctx, calls } = search(() => response(429, ""), 2);
    const error = await code(ctx);
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("retries 5xx and reports network when it persists", async () => {
    const { ctx, calls } = search(() => response(502, ""), 2);
    const error = await code(ctx);
    expect(error.code).toBe("network");
    expect(calls).toHaveLength(3);
  });

  it("recovers from a 5xx", async () => {
    const { ctx } = search((_c, n) => (n < 2 ? response(503, "") : response(200, SEARCH_EMPTY)), 3);
    expect(await arbeitsagenturChannel.collect(query(), ctx)).toEqual([]);
  });

  it("classifies 403 as blocked and does not retry", async () => {
    const { ctx, calls } = search(() => response(403, ""), 3);
    expect((await code(ctx)).code).toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("classifies a 400 (bad parameter) as a non-retryable unknown error", async () => {
    const { ctx, calls } = search(() => response(400, { messages: [{ code: "EINGABEN_UNVOLLSTAENDIG_ODER_FEHLERHAFT" }] }), 3);
    const error = await code(ctx);
    expect(error.code).toBe("unknown");
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("classifies a response of the wrong shape as parse", async () => {
    const { ctx } = search(() => response(200, { ergebnisliste: [{ no: "refnr" }] }));
    expect((await code(ctx)).code).toBe("parse");
  });

  it("classifies non-JSON as parse", async () => {
    const { ctx } = search(() => response(200, "<html>nope</html>"));
    expect((await code(ctx)).code).toBe("parse");
  });

  it("passes throttling on a detail request on instead of swallowing it, with the list results", async () => {
    const list = api();
    const { ctx } = makeContext((call, n) => (isSearch(call) ? list(call, n) : response(429, "")));
    const error = await arbeitsagenturChannel.collect(query(), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialCollectError);
    expect((error as PartialCollectError).cause.code).toBe("rate_limited");
    expect((error as PartialCollectError).postings).toHaveLength(ITEMS.length);
  });

  it("rejects unusable channel settings with a clear error", async () => {
    const { ctx } = makeContext(api());
    const broken = { ...ctx, settings: { ...ctx.settings, extra: { enabled: true } } };
    const error = await arbeitsagenturChannel.collect(query(), broken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).message).toMatch(/sources\.arbeitsagentur/);
  });
});

describe("parse", () => {
  const payload = (list: unknown, detail: unknown) => ({ list, detail });

  it("maps a posting with details to the normalized draft", () => {
    const draft = normalizedPostingDraftSchema.parse(arbeitsagenturChannel.parse(payload(ITEMS[0], DETAIL_MULTI)));
    expect(draft.title).toBe("BI Engineer (m/w/d) – Data Engineering & KI-Infrastruktur");
    expect(draft.companyName).toBe("Praxissoft Nord GmbH");
    expect(draft.locations).toHaveLength(10);
    expect(draft.locations[0]).toEqual({ label: "Hannover", city: "Hannover", countryCode: "DE" });
    expect(draft.workplace).toBe("hybrid");
    expect(draft.contractHint).toBe("permanent, full-time");
    expect(draft.postedAt).toEqual(new Date("2026-10-05T00:00:00Z"));
    expect(draft.sourceUrl).toBe(`https://www.arbeitsagentur.de/jobsuche/jobdetail/${REF_MULTI}`);
    expect(draft.applyUrl).toBe(draft.sourceUrl);
    expect(draft.description).toContain("Data Warehouse");
    expect(draft.description).not.toMatch(/@/);
    expect(draft.salary ?? null).toBeNull();
    expect(draft.salaryText ?? null).toBeNull();
    expect(draft.isAgency).toBeUndefined(); // the posting does not say
  });

  it("maps salary, onsite work and the address-free location of a second posting", () => {
    const draft = normalizedPostingDraftSchema.parse(arbeitsagenturChannel.parse(payload(ITEMS[3], DETAIL_SALARY)));
    expect(draft.title).toBe("Software Engineer (Founding Team)");
    expect(draft.companyName).toBe("Sehwerk GmbH");
    expect(draft.workplace).toBe("onsite");
    expect(draft.salary).toEqual({ min: 55000, max: 70000, currency: "EUR", period: "year", raw: "55000-70000 EUR/year" });
    expect(draft.salaryText).toBe("55000-70000 EUR/year");
    expect(draft.locations).toEqual([{ label: "Berlin", city: "Berlin", countryCode: "DE" }]);
    expect(draft.description).toContain("Fahrradabo");
  });

  it("parses a list-only posting (no detail): empty description, unknown what is not stated", () => {
    const draft = normalizedPostingDraftSchema.parse(arbeitsagenturChannel.parse(payload(ITEMS[1], null)));
    expect(draft.description).toBe("");
    expect(draft.title).toMatch(/AI Engineer/);
    expect(draft.applyUrl).toMatch(/^https:\/\/jobs\.example\.test\//);
    expect(draft.sourceUrl).toBe(`https://www.arbeitsagentur.de/jobsuche/jobdetail/${ITEMS[1]?.referenznummer}`);
    expect(draft.workplace).toBe("onsite");
    expect(draft.extra).toMatchObject({ hasDescription: false, hasExternalApplyUrl: true });
  });

  it("states unknown when the posting does not say anything about home office", () => {
    const { homeofficemoeglich: _drop, ...rest } = ITEMS[1] as Record<string, unknown>;
    void _drop;
    expect(arbeitsagenturChannel.parse(payload(rest, null)).workplace).toBe("unknown");
  });

  it("maps 100 % home office to remote and agency postings to isAgency", () => {
    const base = { ...ITEMS[0], homeofficemoeglich: true, homeofficetyp: "ANGABE_IN_PROZENT", homeofficeprozent: 100, istArbeitnehmerUeberlassung: true };
    const draft = arbeitsagenturChannel.parse(payload(base, null));
    expect(draft.workplace).toBe("remote");
    expect(draft.isAgency).toBe(true);
  });

  it("maps a fixed salary, and keeps only the text for pay kinds it cannot place", () => {
    const fixed = arbeitsagenturChannel.parse(payload({ ...ITEMS[0], verguetungsangabe: "JAHRESGEHALT", artDerVerguetung: "FESTGEHALT", festgehalt: 65478.81 }, null));
    expect(fixed.salary).toMatchObject({ min: 65478.81, max: 65478.81, period: "year" });
    const odd = arbeitsagenturChannel.parse(payload({ ...ITEMS[0], verguetungsangabe: "SONSTIGES", gehaltsspanneVon: 10, gehaltsspanneBis: 20 }, null));
    expect(odd.salary ?? null).toBeNull();
    expect(odd.salaryText).toBe("10-20 EUR");
    const inverted = arbeitsagenturChannel.parse(payload({ ...ITEMS[0], verguetungsangabe: "JAHRESGEHALT", gehaltsspanneVon: 90, gehaltsspanneBis: 20 }, null));
    expect(inverted.salary ?? null).toBeNull();
  });

  it("prefers a valid external apply url and ignores a broken one", () => {
    expect(arbeitsagenturChannel.parse(payload({ ...ITEMS[0], externeURL: "https://jobs.example.test/apply?id=1" }, null)).applyUrl).toBe("https://jobs.example.test/apply?id=1");
    expect(arbeitsagenturChannel.parse(payload({ ...ITEMS[0], externeURL: "javascript:alert(1)" }, null)).applyUrl).toMatch(/arbeitsagentur\.de/);
  });

  it("hints part-time, fixed-term and non-job offer types", () => {
    const hint = arbeitsagenturChannel.parse(
      payload({ ...ITEMS[0], stellenangebotsart: "PRAKTIKUM_TRAINEE", vertragsdauer: "BEFRISTET", arbeitszeitVollzeit: false, arbeitszeitTeilzeitFlexibel: true }, null),
    ).contractHint;
    expect(hint).toBe("internship/trainee, fixed-term, part-time");
  });

  it("falls back to the region for a location without a city and maps other countries", () => {
    const draft = arbeitsagenturChannel.parse(
      payload(
        { ...ITEMS[0], stellenlokationen: [{ adresse: { region: "BADEN_WUERTTEMBERG", land: "DEUTSCHLAND" } }, { adresse: { ort: "Wien", land: "ÖSTERREICH" } }, { adresse: { ort: "Wien", land: "ÖSTERREICH" } }, {}] },
        null,
      ),
    );
    expect(draft.locations).toEqual([
      { label: "Baden Wuerttemberg", city: null, countryCode: "DE" },
      { label: "Wien", city: "Wien", countryCode: "AT" },
    ]);
  });

  it("throws a classified parse error for payloads it cannot use", () => {
    const failing = (p: unknown) => {
      try {
        arbeitsagenturChannel.parse(p);
      } catch (error) {
        return error;
      }
      return null;
    };
    for (const bad of [null, "x", {}, { list: {}, detail: null }, payload({ ...ITEMS[0], stellenangebotsTitel: " " }, null), payload({ ...ITEMS[0], firma: undefined }, null)]) {
      const error = failing(bad);
      expect(error).toBeInstanceOf(ChannelError);
      expect((error as ChannelError).code).toBe("parse");
    }
  });

  it("does not carry contact fields into the draft", () => {
    const withContacts = {
      ...DETAIL_SALARY,
      ansprechpartner: { name: "Erika Muster", telefon: "030 123 456 78", email: "erika@example.test" },
      stellenangebotsBeschreibung: "Text. Ansprechpartner: Erika Muster\nKontakt erika@example.test, Tel. 030 123 456 78",
    };
    const serialized = JSON.stringify(parseArbeitsagenturPayload(payload(ITEMS[3], withContacts)));
    expect(serialized).not.toMatch(/Erika|erika@|123 456/);
  });
});

describe("redactContacts", () => {
  it("removes e-mail addresses, phone numbers and contact-person lines", () => {
    const text = "Ansprechpartner: Max Mustermann\nMail: max.mustermann@firma.example, Tel. +49 7034 656-15058 oder 089 954 287 111.\nDein Kontakt für diese Stelle ist: Lina Rackl\nBewerbung online.";
    const out = redactContacts(text);
    expect(out).not.toMatch(/Mustermann|@|7034|954|Rackl/);
    expect(out).toContain("Bewerbung online.");
  });

  it("leaves prices, dates, ranges and numbered text alone", () => {
    const text = "55.000 bis 70.000 Euro, 30 Urlaubstage, ab 01.11.2026, 2026-10-05, 3-4 Jahre Erfahrung, Gehalt 65000 - 75000, 40 Stunden pro Woche, Entgeltgruppe 13.";
    expect(redactContacts(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = redactContacts("Mail a@b.example +49 30 123 456 78");
    expect(redactContacts(once)).toBe(once);
  });
});

describe("registration and configuration", () => {
  it("is registered as a builtin channel with the config block as its settings", () => {
    const registry = new ChannelRegistry();
    registerBuiltinChannels(registry);
    const config = shippedChannels();
    const channel = registry.get("arbeitsagentur");
    expect(channel).toMatchObject({ family: "arbeitsagentur", kind: "api", usesQueries: true });
    expect(registry.isEnabled("arbeitsagentur", config)).toBe(true);
    const runtime = settingsFromConfig("arbeitsagentur", config);
    expect(arbeitsagenturSettingsSchema.parse(runtime.extra)).toMatchObject({ radius_km: 30, fetch_details: true });
  });

  it("ships the documented defaults", () => {
    expect(settings()).toMatchObject({
      base_url: "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service",
      api_key: "jobboerse-jobsuche",
      radius_km: 30,
      fetch_details: true,
      remote_requires_home_office: true,
    });
    expect(settings().page_size).toBeGreaterThan(0);
    expect(settings().max_details_per_query).toBeGreaterThan(0);
  });

  it("rejects invalid arbeitsagentur settings", () => {
    const bad = (edit: (block: Record<string, unknown>) => void) =>
      expect(() =>
        channelsWith((raw) => {
          const sources = raw.sources as Record<string, Record<string, unknown>>;
          edit(sources.arbeitsagentur as Record<string, unknown>);
        }),
      ).toThrow();
    bad((b) => (b.radius_km = 0));
    bad((b) => (b.page_size = -1));
    bad((b) => (b.base_url = "not a url"));
    bad((b) => (b.api_key = ""));
    bad((b) => (b.fetch_details = "yes"));
    bad((b) => (b.remote_requires_home_office = "yes"));
    bad((b) => (b.remote_max_pages = 0));
    bad((b) => delete b.remote_requires_home_office);
    bad((b) => delete b.max_details_per_query);
    bad((b) => (b.unknown_key = 1));
  });
});
