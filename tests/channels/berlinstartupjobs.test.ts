// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createBerlinStartupJobsChannel, berlinStartupJobsDescriptionHtml, parseBerlinStartupJobsPayload, postsUrl, type BerlinStartupJobsInputs } from "@/lib/channels/berlinstartupjobs";
import { fromGmt, splitTitle, trimPost, unpublishDay } from "@/lib/channels/berlinstartupjobs/parse";
import { POST_FIELDS } from "@/lib/channels/berlinstartupjobs/schema";
import { createChannelContext } from "@/lib/channels/context";
import { ChannelError, PartialCollectError } from "@/lib/channels/errors";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { buildSweepQuery } from "@/lib/channels/query";
import { normalizedPostingDraftSchema, type ChannelContext, type HttpResponse, type SearchQuery } from "@/lib/channels/types";
import { configRegistry, type BerlinStartupJobsSettings } from "@/lib/config";
import { scanHtml } from "@/lib/traps/html";

import { shippedYaml } from "../config/helpers";
import { trapSettings } from "../traps/helpers";
import { shippedChannels, shippedSearch } from "./helpers";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/berlinstartupjobs");
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as unknown;
type Json = Record<string, unknown>;

const PAGES = [readJson("posts-page-1.json"), readJson("posts-page-2.json"), readJson("posts-page-3.json")] as Json[][];
const COMPANIES = readJson("job_company.json") as Array<{ id: number }>;
const LOCATIONS = readJson("job_location.json") as Array<{ id: number }>;
const ALL_POSTS = PAGES.flat();

/** The fixtures' clock. */
const NOW = new Date("2026-10-24T09:00:00Z");

const settings = (overrides: Partial<BerlinStartupJobsSettings> = {}): BerlinStartupJobsSettings => ({
  ...shippedChannels().sources.berlinstartupjobs,
  enabled: true,
  per_page: 4,
  title_prefilter: { enabled: true, include_terms: ["Engineer", "Scientist"], exclude_terms: ["Werkstudent", "Working Student", "Intern"] },
  ...overrides,
});

function inputs(options: { keywords?: string[]; watched?: string[] } = {}): BerlinStartupJobsInputs {
  return {
    search: { ...shippedSearch(), keyword_groups: { roles: options.keywords ?? ["AI Engineer"] } },
    interests: { ...configRegistry.interests.schema.parse(shippedYaml("interests.yaml")), watched_companies: options.watched ?? [] },
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (name) => lower[name.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text) as unknown };
}

interface Call {
  url: URL;
  headers: Record<string, string>;
}
type Handler = (call: Call, n: number) => HttpResponse | Error;

function makeContext(handler: Handler, overrides: Partial<BerlinStartupJobsSettings> = {}, options: { maxRetries?: number; maxResults?: number; records?: LogRecord[]; signal?: AbortSignal } = {}) {
  const calls: Call[] = [];
  const merged = settings(overrides);
  const ctx: ChannelContext = createChannelContext({
    channelId: "berlinstartupjobs",
    settings: { enabled: true, maxResults: options.maxResults ?? merged.max_results, monthlyBudgetUsd: 0, companyQueries: false, freeRecordsPerMonth: 0, throttle: { minDelayMs: 1, maxDelayMs: 1 }, extra: merged },
    http: { timeoutMs: 1000, maxRetries: options.maxRetries ?? 0, backoffBaseMs: 10, backoffMaxMs: 5000 },
    budget: {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }),
    },
    signal: options.signal ?? new AbortController().signal,
    cycle: { id: null, kind: "manual" },
    logger: createLogger({ sink: (r) => options.records?.push(r), minLevel: "debug" }),
    known: { payloads: async () => new Map() },
    sleep: async () => undefined,
    random: () => 0,
    fetch: async (url, init) => {
      const call: Call = { url: new URL(url), headers: init.headers ?? {} };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { ctx, calls };
}

const pageOf = (url: URL): number => Number(url.searchParams.get("page"));
const idsOf = (url: URL): number[] => (url.searchParams.get("include") ?? "").split(",").filter(Boolean).map(Number);

/** Serves the fixtures like WordPress: posts by page (400 beyond the last), the companies asked for, all locations. */
function site(options: { totalPagesHeader?: boolean; pages?: unknown[][] } = {}): Handler {
  const pages = options.pages ?? PAGES;
  return ({ url }) => {
    if (url.pathname.endsWith("/posts")) {
      const page = pageOf(url);
      const body = pages[page - 1];
      if (body === undefined) return response(400, { code: "rest_post_invalid_page_number" });
      return response(200, body, options.totalPagesHeader === false ? {} : { "X-WP-TotalPages": String(pages.length), "X-WP-Total": "10" });
    }
    if (url.pathname.endsWith("/job_company")) return response(200, COMPANIES.filter((c) => idsOf(url).includes(c.id)));
    if (url.pathname.endsWith("/job_location")) return response(200, LOCATIONS);
    return response(404, "not found");
  };
}

const query = (overrides: Partial<SearchQuery> = {}): SearchQuery => ({ ...buildSweepQuery(shippedSearch(), "manual"), windowHours: 24, ...overrides });
const channel = (options: Parameters<typeof inputs>[0] = {}) => createBerlinStartupJobsChannel({ inputs: () => inputs(options), now: () => NOW });
const externalIds = (postings: ReadonlyArray<{ externalId: string }>): string[] => postings.map((p) => p.externalId);

/** The envelope the channel stores for a fixture post, built by hand (the parse tests do not need a scan). */
function envelope(id: number, options: { companies?: number[] | undefined; locations?: number[] | undefined } = {}): Json {
  const post = ALL_POSTS.find((p) => p.id === id);
  if (!post) throw new Error(`no fixture post ${id}`);
  const term = (list: Array<Json | { id: number }>, ids: readonly number[]): Json[] => ids.flatMap((i) => list.filter((t) => t.id === i) as Json[]);
  return structuredClone({
    post: trimPost(post),
    terms: { job_company: term(COMPANIES, options.companies ?? (post.job_company as number[])), job_location: term(LOCATIONS, options.locations ?? (post.job_location as number[])) },
  });
}

describe("title and dates", () => {
  it("splits a title at its last separator", () => {
    expect(splitTitle("Founding Engineer (m/f/d) // Example Robotics GmbH")).toEqual({ role: "Founding Engineer (m/f/d)", suffix: "Example Robotics GmbH" });
    expect(splitTitle("Social Paid Manager &#8211; X // Medior bis Senior // Yellowgrape GmbH")).toEqual({ role: "Social Paid Manager – X // Medior bis Senior", suffix: "Yellowgrape GmbH" });
    expect(splitTitle("Platform   Engineer")).toEqual({ role: "Platform Engineer", suffix: null });
    expect(splitTitle("See https://example.com/x")).toEqual({ role: "See https://example.com/x", suffix: null });
  });

  it("reads date_gmt as UTC, with or without a zone, and refuses anything else", () => {
    expect(fromGmt("2026-10-20T09:00:00")?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(fromGmt("2026-10-20T09:00:00+02:00")?.toISOString()).toBe("2026-10-20T07:00:00.000Z");
    for (const bad of ["", "yesterday", "2026-13-40T00:00:00", "2026-10-20", null, 5]) expect(fromGmt(bad)).toBeNull();
  });

  it("reads _unpublish_on as a real calendar day only", () => {
    expect(unpublishDay("2026-10-01")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    for (const bad of [null, undefined, "", "2026-02-30", "01.10.2026", "2026-10-01T00:00:00"]) expect(unpublishDay(bad)).toBeNull();
  });
});

describe("parse", () => {
  it("maps a plain post: role without the company suffix, the company term, Berlin only", () => {
    const draft = parseBerlinStartupJobsPayload(envelope(1001));
    expect(normalizedPostingDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft).toMatchObject({
      title: "Founding Engineer (m/f/d)",
      companyName: "Example Robotics",
      locations: [{ label: "Berlin, Germany", city: null, countryCode: null }],
      workplace: "unknown",
      contractHint: null,
      seniorityHint: null,
      salary: null,
      salaryText: null,
      applyUrl: "https://bsj.example/job/job-1001/",
      sourceUrl: "https://bsj.example/job/job-1001/",
    });
    expect(draft.postedAt?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(draft.extra).toMatchObject({ id: 1001, slug: "job-1001", categories: [3], jobPlan: [5], unpublishOn: "2027-01-18", featured: false, remote: [] });
  });

  it("decodes entities and cuts a title with two separators at the last one", () => {
    expect(parseBerlinStartupJobsPayload(envelope(1003)).title).toBe("Senior ML Engineer – Search // Platform Team");
    expect(parseBerlinStartupJobsPayload(envelope(1003)).description).toContain("Ranking and retrieval & evaluation.");
  });

  it("treats 'remote possible' as nothing stated, and a remote term as remote without a place", () => {
    expect(parseBerlinStartupJobsPayload(envelope(1003))).toMatchObject({ workplace: "unknown", locations: [{ label: "Berlin, Germany" }] });
    expect(parseBerlinStartupJobsPayload(envelope(1003)).extra).toMatchObject({ remote: ["remote-possible"] });
    expect(parseBerlinStartupJobsPayload(envelope(1005))).toMatchObject({ workplace: "remote", locations: [] });
    expect(parseBerlinStartupJobsPayload(envelope(1009))).toMatchObject({ workplace: "remote", locations: [{ label: "Berlin, Germany" }] });
  });

  it("falls back to the end of the title for the company, and fails when neither names one", () => {
    expect(parseBerlinStartupJobsPayload(envelope(1004, { companies: [] })).companyName).toBe("Contact Co");
    expect(() => parseBerlinStartupJobsPayload(envelope(1008))).toThrow(ChannelError);
    expect(() => parseBerlinStartupJobsPayload(envelope(1008))).toThrow(/no company/);
  });

  it("fails on a post without a title", () => {
    const e = envelope(1001) as { post: { title: { rendered: string } } };
    e.post.title.rendered = "   ";
    expect(() => parseBerlinStartupJobsPayload(e)).toThrow(/no title/);
  });

  it("removes e-mail addresses and phone numbers from the description, keeps the stored original, and links the site page, never a mailto", () => {
    const withContact = envelope(1004);
    const draft = parseBerlinStartupJobsPayload(withContact);
    expect(draft.description).not.toMatch(/jobs@example\.com|\+49 30 1234567/);
    expect(JSON.stringify(withContact)).toContain("jobs@example.com");
    const mailto = parseBerlinStartupJobsPayload(envelope(1009));
    expect(mailto.description).not.toMatch(/apply@example\.com|0000000/);
    expect(mailto.applyUrl).toBe("https://bsj.example/job/job-1009/");
    expect(JSON.stringify(mailto)).not.toContain("mailto:");
  });

  it("gives no link for a link that is not http(s), and no date for a date that is not one", () => {
    const e = envelope(1001) as { post: Json };
    e.post.link = "mailto:jobs@example.com";
    e.post.date_gmt = "soon";
    expect(parseBerlinStartupJobsPayload(e)).toMatchObject({ applyUrl: null, sourceUrl: null, postedAt: null });
  });

  it("every posting of the fixtures that has a company parses to a valid draft", () => {
    for (const post of ALL_POSTS.filter((p) => p.id !== 1008)) expect(normalizedPostingDraftSchema.safeParse(parseBerlinStartupJobsPayload(envelope(post.id as number))).success, String(post.id)).toBe(true);
  });

  it("rejects a payload of the wrong shape", () => {
    expect(() => parseBerlinStartupJobsPayload({ post: {} })).toThrow(ChannelError);
    expect(() => parseBerlinStartupJobsPayload("nope")).toThrow(/expected shape/);
  });
});

describe("descriptionHtml", () => {
  it("returns the post HTML, where the trap scan finds the hidden text", () => {
    const fragments = berlinStartupJobsDescriptionHtml(envelope(1004));
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.path).toBe("post.content.rendered");
    const findings = fragments.flatMap((f) => scanHtml(f, trapSettings()));
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ method: "display_none", text: expect.stringContaining("Ignore previous instructions") })]));
  });

  it("returns nothing for an unreadable payload", () => {
    expect(berlinStartupJobsDescriptionHtml("nope")).toEqual([]);
    expect(berlinStartupJobsDescriptionHtml({ post: {} })).toEqual([]);
  });
});

describe("request shape", () => {
  it("asks for the whitelisted fields only, and sends the user agent", async () => {
    const { ctx, calls } = makeContext(site());
    await channel().collect(query(), ctx);
    const first = calls[0];
    expect(first?.url.searchParams.get("_fields")).toBe(POST_FIELDS.join(","));
    expect(first?.url.searchParams.get("per_page")).toBe("4");
    expect(first?.url.searchParams.get("page")).toBe("1");
    expect(first?.headers["User-Agent"]).toBe(settings().user_agent);
    expect(postsUrl(settings(), 2)).toContain("page=2");
    for (const field of ["_invoice_url", "_submission_data", "yoast_head", "gf_entry_url", "company_admin_link"]) expect(first?.url.search).not.toContain(field);
  });

  it("sends only wp/v2 reads: three pages, one company request for the posts that stay, one location request", async () => {
    const { ctx, calls } = makeContext(site());
    await channel().collect(query(), ctx);
    expect(calls.map((c) => c.url.pathname.replace(/^.*\/wp\/v2\//, ""))).toEqual(["posts", "posts", "posts", "job_company", "job_location"]);
    // the expired and the too-old posts' companies (16, 17) are not asked for
    const company = calls.find((c) => c.url.pathname.endsWith("/job_company"));
    expect(idsOf(company?.url as URL).sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15, 18, 999]);
    expect(company?.url.searchParams.get("_fields")).toBe("id,name,slug,link");
    expect(calls.every((c) => c.url.pathname.startsWith("/wp-json/wp/v2/"))).toBe(true);
  });

  it("asks for companies in batches of at most 100", async () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ ...(ALL_POSTS[0] as Json), id: 5000 + i, job_company: [7000 + i], title: { rendered: `Platform Engineer ${i} // Co ${i}` } }));
    const { ctx, calls } = makeContext(site({ pages: [many] }), { per_page: 100 }, { maxResults: 500 });
    await channel().collect(query({ maxResults: 500 }), ctx);
    const batches = calls.filter((c) => c.url.pathname.endsWith("/job_company")).map((c) => idsOf(c.url).length);
    expect(batches).toEqual([100, 100, 30]);
  });
});

describe("scan", () => {
  it("keeps what passes the rules, newest first, and drops duplicates, expired, old and filtered posts", async () => {
    const records: LogRecord[] = [];
    const { ctx } = makeContext(site(), {}, { records });
    const postings = await channel().collect(query(), ctx);
    expect(externalIds(postings)).toEqual(["1001", "1003", "1004", "1005", "1008", "1009"]);
    expect(records.find((r) => r.message === "berlinstartupjobs scan done")?.fields).toMatchObject({ pages: 3, listed: 10, invalid: 0, duplicates: 1, expired: 1, tooOld: 1, prefiltered: 1, truncated: 0, postings: 6 });
    expect(postings[0]).toMatchObject({ url: "https://bsj.example/job/job-1001/", postedAt: new Date("2026-10-20T09:00:00Z") });
  });

  it("stops at X-WP-TotalPages", async () => {
    const handler: Handler = (call, n) => (call.url.pathname.endsWith("/posts") ? response(200, PAGES[pageOf(call.url) - 1] ?? [], { "X-WP-TotalPages": "2" }) : site()(call, n));
    const { ctx, calls } = makeContext(handler);
    const postings = await channel().collect(query(), ctx);
    expect(calls.filter((c) => c.url.pathname.endsWith("/posts"))).toHaveLength(2);
    expect(externalIds(postings)).not.toContain("1009");
  });

  it("without the header, stops at a page with fewer posts than per_page", async () => {
    const { ctx, calls } = makeContext(site({ totalPagesHeader: false }));
    await channel().collect(query(), ctx);
    expect(calls.filter((c) => c.url.pathname.endsWith("/posts"))).toHaveLength(3);
  });

  it("stops at an empty page", async () => {
    const { ctx, calls } = makeContext(site({ totalPagesHeader: false, pages: [PAGES[0] as Json[], PAGES[1] as Json[], [], PAGES[2] as Json[]] }));
    const postings = await channel().collect(query(), ctx);
    expect(calls.filter((c) => c.url.pathname.endsWith("/posts"))).toHaveLength(3);
    expect(externalIds(postings)).not.toContain("1009");
  });

  it("stops at max_pages", async () => {
    const { ctx, calls } = makeContext(site(), { max_pages: 2 });
    const postings = await channel().collect(query(), ctx);
    expect(calls.filter((c) => c.url.pathname.endsWith("/posts"))).toHaveLength(2);
    expect(externalIds(postings)).not.toContain("1009");
  });

  it("reads a 400 from page 2 on as the end, and keeps page 1", async () => {
    const handler: Handler = (call, n) => (call.url.pathname.endsWith("/posts") && pageOf(call.url) === 2 ? response(400, { code: "rest_post_invalid_page_number" }) : site()(call, n));
    const { ctx, calls } = makeContext(handler);
    const postings = await channel().collect(query(), ctx);
    expect(externalIds(postings)).toEqual(["1001", "1003", "1004"]);
    expect(calls.filter((c) => c.url.pathname.endsWith("/posts"))).toHaveLength(2);
  });

  it("applies skip_expired and max_age_days as set", async () => {
    const off = await channel().collect(query(), makeContext(site(), { skip_expired: false, max_age_days: 1000 }).ctx);
    expect(externalIds(off)).toEqual(expect.arrayContaining(["1006", "1007"]));
    const noExpiry = await channel().collect(query(), makeContext(site(), { skip_expired: false }).ctx);
    expect(externalIds(noExpiry)).toContain("1006");
    expect(externalIds(noExpiry)).not.toContain("1007");
    const edge = await channel().collect(query(), makeContext(site(), { max_age_days: 4 }).ctx);
    expect(externalIds(edge)).toEqual(["1001"]); // exactly 4 days old stays; older goes
  });

  it("keeps a post whose end date is today", async () => {
    const pages = [[{ ...(ALL_POSTS[0] as Json), _unpublish_on: "2026-10-24" }]];
    const postings = await channel().collect(query(), makeContext(site({ pages })).ctx);
    expect(externalIds(postings)).toEqual(["1001"]);
  });

  it("matches a watched company by its term name, and drops student jobs unless the company is watched", async () => {
    const base = { include_terms: [], exclude_terms: ["Werkstudent"] };
    const only = await channel({ keywords: ["Zzzz"], watched: ["Contact Co"] }).collect(query(), makeContext(site(), { title_prefilter: { enabled: true, ...base } }).ctx);
    expect(externalIds(only)).toEqual(["1004"]);
    const student = await channel({ keywords: ["Zzzz"], watched: ["Beispiel"] }).collect(query(), makeContext(site(), { title_prefilter: { enabled: true, ...base } }).ctx);
    expect(externalIds(student)).toEqual(["1002"]);
  });

  it("caps the stored postings at max_results, newest first", async () => {
    const postings = await channel().collect(query({ maxResults: 2 }), makeContext(site(), {}, { maxResults: 2 }).ctx);
    expect(externalIds(postings)).toEqual(["1001", "1003"]);
  });

  it("does not ask for terms when no post is left", async () => {
    const { ctx, calls } = makeContext(site({ pages: [[]] }));
    await expect(channel().collect(query(), ctx)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("stops when the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(channel().collect(query(), makeContext(site(), {}, { signal: controller.signal }).ctx)).rejects.toThrow();
  });
});

describe("the stored envelope", () => {
  it("is { post, terms } with the whitelisted keys only, and only the terms the post points to", async () => {
    const postings = await channel().collect(query(), makeContext(site()).ctx);
    const first = postings[0]?.payload as { post: Json; terms: { job_company: Json[]; job_location: Json[] } };
    expect(Object.keys(first)).toEqual(["post", "terms"]);
    expect(Object.keys(first.post).every((k) => (POST_FIELDS as readonly string[]).includes(k))).toBe(true);
    for (const leaked of ["_invoice_url", "_invoice_status", "_submission_data", "yoast_head"]) expect(first.post).not.toHaveProperty(leaked);
    expect(first.post).toMatchObject({ id: 1001, title: { rendered: "Founding Engineer (m/f/d) // Example Robotics GmbH" } });
    expect(first.terms.job_company).toEqual([{ id: 11, name: "Example Robotics", slug: "example-robotics", link: "https://bsj.example/company/example-robotics/" }]);
    expect(first.terms.job_location.map((t) => t.slug)).toEqual(["berlin-germany"]);
    const twoPlaces = postings.find((p) => p.externalId === "1003")?.payload as { terms: { job_location: Json[] } };
    expect(twoPlaces.terms.job_location.map((t) => t.slug)).toEqual(["berlin-germany", "remote-possible"]);
    const missing = postings.find((p) => p.externalId === "1008")?.payload as { terms: { job_company: Json[] } };
    expect(missing.terms.job_company).toEqual([]);
  });

  it("is byte for byte the same on a second run, and parses", async () => {
    const run = async () => channel().collect(query(), makeContext(site()).ctx);
    const [a, b] = [await run(), await run()];
    expect(JSON.stringify(a.map((p) => p.payload))).toBe(JSON.stringify(b.map((p) => p.payload)));
    for (const p of a.filter((x) => x.externalId !== "1008")) expect(normalizedPostingDraftSchema.safeParse(parseBerlinStartupJobsPayload(p.payload)).success, p.externalId).toBe(true);
  });

  it("keeps the raw description with its contact details", async () => {
    const postings = await channel().collect(query(), makeContext(site()).ctx);
    expect(JSON.stringify(postings.find((p) => p.externalId === "1004")?.payload)).toContain("jobs@example.com");
  });
});

describe("errors", () => {
  it("a page that is not an array is a parse error, a bad post only costs itself", async () => {
    const bad = (body: unknown): Handler => (call, n) => (call.url.pathname.endsWith("/posts") ? response(200, body) : site()(call, n));
    await expect(channel().collect(query(), makeContext(bad(readJson("posts-malformed.json"))).ctx)).rejects.toMatchObject({ code: "parse" });
    const records: LogRecord[] = [];
    const postings = await channel().collect(query(), makeContext(bad(readJson("posts-bad-item.json")), {}, { records }).ctx);
    expect(externalIds(postings)).toEqual(["1010"]);
    expect(records.find((r) => r.level === "warn" && r.message.includes("unexpected shape"))?.fields).toMatchObject({ count: 2 });
  });

  it.each([401, 403, 404, 410])("HTTP %i on the first page is blocked and trips the circuit", async (status) => {
    await expect(channel().collect(query(), makeContext(() => response(status, "no")).ctx)).rejects.toMatchObject({ code: "blocked" });
  });

  it("retries 429 with Retry-After and 5xx", async () => {
    const handler: Handler = (call, n) => (n === 0 ? response(429, "slow", { "Retry-After": "0" }) : n === 1 ? response(503, "down") : site()(call, n));
    const { ctx, calls } = makeContext(handler, {}, { maxRetries: 2 });
    const postings = await channel().collect(query(), ctx);
    expect(postings.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(5);
  });

  it("fails the run when the company terms cannot be read: no half-finished postings", async () => {
    const handler: Handler = (call, n) => (call.url.pathname.endsWith("/job_company") ? response(500, "down") : site()(call, n));
    await expect(channel().collect(query(), makeContext(handler).ctx)).rejects.toBeInstanceOf(ChannelError);
  });

  it("fails the run when the location terms cannot be read", async () => {
    const handler: Handler = (call, n) => (call.url.pathname.endsWith("/job_location") ? response(500, "down") : site()(call, n));
    await expect(channel().collect(query(), makeContext(handler).ctx)).rejects.toBeInstanceOf(ChannelError);
  });

  it("a term request that answers 401 or 404 is blocked", async () => {
    const handler: Handler = (call, n) => (call.url.pathname.endsWith("/job_company") ? response(404, "no") : site()(call, n));
    await expect(channel().collect(query(), makeContext(handler).ctx)).rejects.toMatchObject({ code: "blocked" });
  });

  it("a failing later page ends the scan: the earlier page is handed on with the failure", async () => {
    const handler: Handler = (call, n) => (call.url.pathname.endsWith("/posts") && pageOf(call.url) === 2 ? response(503, "down") : site()(call, n));
    const result = await channel().collect(query(), makeContext(handler).ctx).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(PartialCollectError);
    expect(externalIds((result as PartialCollectError).postings)).toEqual(["1001", "1003", "1004"]);
  });

  it("rejects an unusable settings block", async () => {
    const { ctx } = makeContext(site());
    const broken = { ...ctx, settings: { ...ctx.settings, extra: { enabled: true } } } as ChannelContext;
    await expect(channel().collect(query(), broken)).rejects.toMatchObject({ code: "unknown" });
  });
});

describe("channel", () => {
  it("is a keyword-less API channel of its own family, without catch-up", () => {
    const c = channel();
    expect(c).toMatchObject({ id: "berlinstartupjobs", family: "berlinstartupjobs", kind: "api", usesQueries: false });
    expect(c.supportsCatchUp?.(makeContext(site()).ctx.settings)).toBe(false);
  });
});
