// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createChannelContext } from "@/lib/channels/context";
import { placeGeo } from "@/lib/market/places";
import { createMemoryDiscoveryStore } from "@/lib/channels/discovery";
import { ChannelError, PartialCollectError } from "@/lib/channels/errors";
import {
  buildPlaces,
  createHandpickedChannel,
  detailUrl,
  discoveryLinks,
  handpickedDescriptionHtml,
  indexUrl,
  matchesPlace,
  parseHandpickedPayload,
  selectPostings,
  type HandpickedDeps,
  type HandpickedInputs,
} from "@/lib/channels/handpicked";
import { fromDateOnly } from "@/lib/channels/handpicked/parse";
import { indexEntrySchema, type HandpickedIndexEntry } from "@/lib/channels/handpicked/schema";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { createTitlePrefilter } from "@/lib/channels/ats/prefilter";
import { buildSweepQuery } from "@/lib/channels/query";
import { normalizedPostingDraftSchema, type ChannelContext, type HttpResponse, type SearchQuery } from "@/lib/channels/types";
import { companiesSchema, configRegistry, type HandpickedSettings } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { scanHtml } from "@/lib/traps/html";

import { shippedYaml } from "../config/helpers";
import { trapSettings } from "../traps/helpers";
import { shippedChannels, shippedSearch } from "./helpers";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/handpicked");
const readJson = (...parts: string[]): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), "utf8")) as unknown;

type Raw = Record<string, unknown> & { id: string };
const INDEX = readJson("search-index.json") as Raw[];
const DETAILS = new Map(fs.readdirSync(path.join(FIXTURES, "details")).map((f) => [f.replace(/\.json$/, ""), readJson("details", f)]));
const entryOf = (id: string): Raw => {
  const found = INDEX.find((e) => e.id === id);
  if (!found) throw new Error(`no fixture entry ${id}`);
  return found;
};

/** The fixtures' clock: the picking is measured from it. */
const NOW = new Date("2026-10-24T09:00:00Z");

const settings = (overrides: Partial<HandpickedSettings> = {}): HandpickedSettings => ({
  ...shippedChannels().sources.handpicked,
  enabled: true,
  title_prefilter: { enabled: true, include_terms: [], exclude_terms: ["Werkstudent", "Working Student", "Intern", "Internship", "Praktikum"] },
  ...overrides,
});

/** Places, keywords and boards the channel reads, built here (not taken from any shipped config). */
const NO_TABLES = { cityAliases: {}, cities: {}, countries: [], regions: {} };

function inputs(options: { remoteScope?: "none" | "home_country"; watched?: string[]; boards?: Array<{ ats: "greenhouse" | "personio"; token: string; enabled?: boolean }> } = {}): HandpickedInputs {
  const search = {
    ...shippedSearch(),
    keyword_groups: { roles: ["AI Engineer", "Machine Learning Engineer", "Data Scientist", "MLOps Engineer"] },
  };
  const pipeline = loadPipeline();
  return {
    search,
    preferences: { home_city: "Berlin", places: [{ place: "München", relocate: true }], workplace: options.remoteScope === "none" ? ["onsite"] : ["onsite", "remote"] },
    interests: { ...configRegistry.interests.schema.parse(shippedYaml("interests.yaml")), watched_companies: options.watched ?? [] },
    pipeline: { ...pipeline, filter: { ...pipeline.filter, city_aliases: { München: ["Munich", "Muenchen"] } } },
    companies: companiesSchema.parse({ companies: (options.boards ?? [{ ats: "greenhouse", token: "KnownCo", enabled: false }]).map((b) => ({ name: b.token, ats: b.ats, token: b.token, enabled: b.enabled ?? true })) }),
    country: "DE",
  };
}

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

const THROTTLE_MS = 7;

function makeContext(
  handler: Handler,
  overrides: Partial<HandpickedSettings> = {},
  options: { maxRetries?: number; maxResults?: number; records?: LogRecord[]; signal?: AbortSignal; consumed?: number[]; real?: boolean; known?: Map<string, unknown> } = {},
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const merged = settings(overrides);
  const ctx: ChannelContext = createChannelContext({
    channelId: "handpicked",
    settings: {
      enabled: true,
      maxResults: options.maxResults ?? merged.max_results,
      monthlyBudgetUsd: 0,
      companyQueries: false,
      freeRecordsPerMonth: 0,
      throttle: { minDelayMs: THROTTLE_MS, maxDelayMs: THROTTLE_MS },
      extra: merged,
    },
    http: { timeoutMs: 1000, maxRetries: options.maxRetries ?? 0, backoffBaseMs: 10, backoffMaxMs: 5000 },
    budget: {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async (records) => {
        options.consumed?.push(records);
        return { usd: 0, freeRecords: 0, paidRecords: 0 };
      },
    },
    signal: options.signal ?? new AbortController().signal,
    cycle: options.real ? { id: 1, kind: "manual" } : { id: null, kind: "manual" },
    logger: createLogger({ sink: (r) => options.records?.push(r), minLevel: "debug" }),
    known: { payloads: async (ids) => new Map(ids.flatMap((id) => (options.known?.has(id) ? [[id, options.known.get(id)] as const] : []))) },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
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

const detailId = (url: URL): string | null => /\/jobs\/d\/([^/]+)\.json$/.exec(url.pathname)?.[1] ?? null;

/** Serves the index and the details of the fixtures; a detail without a fixture is a 404. */
function site(index: unknown = INDEX): Handler {
  return ({ url }) => {
    if (url.pathname === "/jobs/search-index.json") return response(200, index);
    const id = detailId(url);
    const detail = id === null ? undefined : DETAILS.get(id);
    return detail === undefined ? response(404, "not found") : response(200, detail);
  };
}

function sweepQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { ...buildSweepQuery(shippedSearch(), "manual"), windowHours: 24, ...overrides };
}

function channel(options: Parameters<typeof inputs>[0] = {}, extra: Partial<HandpickedDeps> = {}) {
  const store = createMemoryDiscoveryStore();
  return { store, channel: createHandpickedChannel({ inputs: () => inputs(options), store: () => store, now: () => NOW, ...extra }) };
}

const ids = (postings: ReadonlyArray<{ externalId: string }>): string[] => postings.map((p) => p.externalId);
const entryIds = (selected: ReadonlyArray<{ entry: { id: string } }>): string[] => selected.map((s) => s.entry.id);

const entries = (): HandpickedIndexEntry[] => INDEX.flatMap((raw) => {
  const parsed = indexEntrySchema.safeParse(raw);
  return parsed.success ? [parsed.data] : [];
});

function prefilter(options: Parameters<typeof inputs>[0] = {}, s: HandpickedSettings = settings()) {
  const i = inputs(options);
  return createTitlePrefilter({ settings: s.title_prefilter, keywordGroups: i.search.keyword_groups, watchedCompanies: i.interests.watched_companies, pipeline: i.pipeline });
}

function placesOf(options: Parameters<typeof inputs>[0] = {}) {
  const i = inputs(options);
  return buildPlaces({ preferences: i.preferences, geo: placeGeo(i.pipeline), country: i.country });
}

describe("fixtures", () => {
  it("are an array whose first entry is a sponsored, older one, and contain two broken entries", () => {
    expect(entryOf("a000000001")).toMatchObject({ tier: "sponsored" });
    expect(entries()).toHaveLength(INDEX.length - 2);
  });
});

describe("places", () => {
  const places = placesOf();
  const entry = (id: string) => indexEntrySchema.parse(entryOf(id));

  it("matches a wanted city by its slug, a spelling through the city aliases, and drops an unwanted one", () => {
    expect(matchesPlace(entry("b000000002"), places)).toBe(true); // berlin
    expect(matchesPlace(entry("b000000005"), places)).toBe(true); // munich, wanted as München
    expect(matchesPlace(entry("b000000006"), places)).toBe(false); // hamburg is not configured
  });

  it("matches German remote by the remote scope", () => {
    expect(matchesPlace(entry("b000000007"), places)).toBe(true);
    expect(matchesPlace(entry("b000000007"), placesOf({ remoteScope: "none" }))).toBe(false);
  });

  it("drops a remote posting that is open to another country only", () => {
    expect(matchesPlace(entry("b000000010"), places)).toBe(false);
    expect(matchesPlace({ ...entry("b000000010"), remoteCountryCodes: [] }, places)).toBe(true);
  });

  it("has no city when none is configured, and compares without case or accents", () => {
    expect(matchesPlace(entry("b000000002"), buildPlaces({ preferences: { home_city: "BERLIN", places: [], workplace: ["onsite"] }, geo: NO_TABLES, country: "DE" }))).toBe(true);
    expect(matchesPlace(entry("b000000005"), buildPlaces({ preferences: { home_city: "Berlin", places: [], workplace: ["onsite"] }, geo: NO_TABLES, country: "DE" }))).toBe(false);
  });
});

describe("selectPostings", () => {
  const known = new Set(["greenhouse:knownco"]);
  const select = (overrides: Partial<Parameters<typeof selectPostings>[1]> = {}) =>
    selectPostings(entries(), { places: placesOf(), maxAgeDays: 14, now: NOW, prefilter: prefilter(), known, skipKnownBoards: true, ...overrides });

  it("applies place, age, title and known boards in turn, newest first", () => {
    const { selected, stats } = select();
    expect(entryIds(selected)).toEqual(["b000000002", "b000000003", "b000000011", "b000000004", "b00000000b", "b000000005", "b00000000c", "b000000007"]);
    expect(stats).toMatchObject({ listed: 15, place: 2, tooOld: 2, prefiltered: 2, knownBoard: 1 });
  });

  it("orders by posting date, not by the order of the index", () => {
    const dates = select().selected.map((s) => s.postedAt.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it("cuts at max_age_days, counted in days from today", () => {
    // today is 10-24: three days back is 10-21
    expect(entryIds(select({ maxAgeDays: 3 }).selected)).toEqual(["b000000002", "b000000003", "b000000011", "b000000004", "b00000000b"]);
  });

  it("skips boards in ats_boards by default (any case), and keeps them with skip_known_boards: false", () => {
    expect(entryIds(select({ skipKnownBoards: false }).selected)).toContain("b00000000a");
    expect(entryIds(select().selected)).not.toContain("b00000000a");
    expect(entryIds(select({ known: new Set(["greenhouse:gammasystems"]) }).selected)).not.toContain("b000000004");
  });

  it("keeps a watched company's posting although the title does not match", () => {
    const watched = prefilter({ watched: ["Eta Office"] });
    expect(entryIds(select({ prefilter: watched }).selected)).toContain("b000000008");
  });
});

describe("discoveryLinks", () => {
  const options = { places: placesOf(), prefilter: prefilter() };
  it("takes postings of the wanted places whose title matches, whatever their age", () => {
    const links = discoveryLinks(entries(), { ...options, requireTitleMatch: true });
    expect(links.map((l) => l.label)).toContain("Lambda Old");
    expect(links.map((l) => l.label)).not.toContain("Eta Office");
    expect(links.map((l) => l.label)).not.toContain("Epsilon Nord");
  });
  it("takes every posting of the places when the title need not match", () => {
    const links = discoveryLinks(entries(), { ...options, requireTitleMatch: false });
    expect(links.map((l) => l.label)).toContain("Eta Office");
    expect(links.map((l) => l.label)).toContain("Theta Studios");
    expect(links.length).toBeGreaterThan(discoveryLinks(entries(), { ...options, requireTitleMatch: true }).length);
  });
});

describe("parse", () => {
  const payload = (id: string, detailOverride: Record<string, unknown> = {}) => ({ index: entryOf(id), detail: { ...(DETAILS.get(id) as Record<string, unknown>), ...detailOverride } });

  it("maps every picked fixture posting to a valid draft", () => {
    for (const id of DETAILS.keys()) expect(normalizedPostingDraftSchema.safeParse(parseHandpickedPayload(payload(id))).success).toBe(true);
  });

  it("maps title, company, place, work mode, salary text, date and link", () => {
    expect(parseHandpickedPayload(payload("b000000002"))).toMatchObject({
      title: "Machine Learning Engineer (m/w/d)",
      companyName: "Acme Robotics",
      locations: [{ label: "Berlin", city: null, countryCode: null }],
      workplace: "unknown",
      contractHint: null,
      seniorityHint: null,
      salaryText: null,
      salary: null,
      applyUrl: "https://acme-robotics.jobs.personio.de/job/1001",
      sourceUrl: "https://acme-robotics.jobs.personio.de/job/1001",
      postedAt: new Date("2026-10-23T00:00:00Z"),
    });
    expect(parseHandpickedPayload(payload("b000000003"))).toMatchObject({ workplace: "hybrid", salaryText: "€70,000–85,000" });
    expect(parseHandpickedPayload(payload("b000000007"))).toMatchObject({ workplace: "remote", locations: [{ label: "Germany (Remote)" }] });
  });

  it("splits the places at the site's own separator only", () => {
    expect(parseHandpickedPayload(payload("b000000004")).locations.map((l) => l.label)).toEqual(["Berlin", "Munich"]);
    const odd = { index: { ...entryOf("b000000002"), location: "Berlin, Mitte / Hybrid" }, detail: DETAILS.get("b000000002") };
    expect(parseHandpickedPayload(odd).locations.map((l) => l.label)).toEqual(["Berlin, Mitte / Hybrid"]);
  });

  it("treats onsite and an unknown work mode as unknown", () => {
    expect(parseHandpickedPayload({ index: { ...entryOf("b000000002"), remoteType: "onsite" }, detail: DETAILS.get("b000000002") }).workplace).toBe("unknown");
    expect(parseHandpickedPayload({ index: { ...entryOf("b000000002"), remoteType: "whatever" }, detail: DETAILS.get("b000000002") }).workplace).toBe("unknown");
  });

  it("prefers the detail's link, falls back to the index, and makes a non-http link null", () => {
    expect(parseHandpickedPayload(payload("b000000003")).applyUrl).toBe("https://beta-labs.example/careers/ai-engineer");
    expect(parseHandpickedPayload(payload("b000000003", { url: undefined })).applyUrl).toBe("https://jobs.ashbyhq.com/beta-labs/11111111-1111-4111-8111-111111111111");
    expect(parseHandpickedPayload(payload("b000000003", { url: "javascript:alert(1)" })).applyUrl).toBe("https://jobs.ashbyhq.com/beta-labs/11111111-1111-4111-8111-111111111111");
    const bad = { index: { ...entryOf("b000000003"), url: "mailto:x@example.com" }, detail: { ...(DETAILS.get("b000000003") as object), url: "ftp://x" } };
    expect(parseHandpickedPayload(bad)).toMatchObject({ applyUrl: null, sourceUrl: null });
  });

  it("reads a day as 00:00 UTC and nothing else as a date", () => {
    expect(fromDateOnly("2026-10-23")).toEqual(new Date("2026-10-23T00:00:00Z"));
    for (const bad of ["yesterday", "2026-02-31", "2026-13-01", "2026-10-23T10:00:00Z", 20261023, null]) expect(fromDateOnly(bad)).toBeNull();
    expect(parseHandpickedPayload(payload("b000000002", {}) && { index: entryOf("b00000000e"), detail: DETAILS.get("b000000002") }).postedAt).toBeNull();
  });

  it("turns the HTML into text and removes the e-mail address and phone number, leaving the stored payload alone", () => {
    const stored = payload("b000000004");
    const before = JSON.stringify(stored);
    const { description } = parseHandpickedPayload(stored);
    expect(description).toContain("Train and ship models");
    expect(description).not.toContain("kontakt@example.com");
    expect(description).not.toContain("1234567");
    expect(description).not.toMatch(/<\/?[a-z]/i);
    expect(JSON.stringify(stored)).toBe(before);
    expect(JSON.stringify(stored)).toContain("kontakt@example.com");
  });

  it("keeps the leftovers in extra", () => {
    expect(parseHandpickedPayload(payload("b000000003")).extra).toMatchObject({ id: "b000000003", category: "tech-dev", isInternship: false, tier: "standard", cities: ["berlin"], location: "Berlin" });
  });

  it("rejects a payload without title, company or detail", () => {
    expect(() => parseHandpickedPayload({ index: { ...entryOf("b000000002"), title: "  " }, detail: DETAILS.get("b000000002") })).toThrow(ChannelError);
    expect(() => parseHandpickedPayload({ index: { ...entryOf("b000000002"), company: "" }, detail: DETAILS.get("b000000002") })).toThrow(ChannelError);
    expect(() => parseHandpickedPayload({ index: entryOf("b000000002") })).toThrow(ChannelError);
    expect(() => parseHandpickedPayload("nope")).toThrow(ChannelError);
  });
});

describe("descriptionHtml", () => {
  it("returns the detail HTML, where the trap scan finds the hidden text", () => {
    const stored = { index: entryOf("b000000005"), detail: DETAILS.get("b000000005") };
    const fragments = handpickedDescriptionHtml(stored);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.path).toBe("detail.descriptionHTML");
    const findings = fragments.flatMap((f) => scanHtml(f, trapSettings()));
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ method: "display_none", text: expect.stringContaining("Ignore all previous instructions") })]));
  });

  it("returns nothing for an unreadable payload", () => {
    expect(handpickedDescriptionHtml("nope")).toEqual([]);
    expect(handpickedDescriptionHtml({ index: entryOf("b000000005") })).toEqual([]);
  });
});

describe("collect", () => {
  it("stores the picked postings that have a detail, with the index entry and the detail as delivered", async () => {
    const { ctx } = makeContext(site());
    const { channel: c } = channel();
    const postings = await c.collect(sweepQuery(), ctx);
    expect(ids(postings)).toEqual(["b000000002", "b000000003", "b000000011", "b000000004", "b00000000b", "b000000005", "b00000000c", "b000000007"]);
    const first = postings[0];
    expect(first).toMatchObject({ externalId: "b000000002", url: "https://acme-robotics.jobs.personio.de/job/1001", postedAt: new Date("2026-10-23T00:00:00Z") });
    expect(first?.payload).toEqual({ index: entryOf("b000000002"), detail: DETAILS.get("b000000002") });
  });

  it("asks for the index once and the details of the picked postings only, with the configured user agent", async () => {
    const { ctx, calls } = makeContext(site(), { base_url: "https://hp.example.test/", user_agent: "Example/1" });
    await channel().channel.collect(sweepQuery(), ctx);
    expect(calls.filter((c) => c.url.pathname === "/jobs/search-index.json")).toHaveLength(1);
    expect(calls.every((c) => c.url.host === "hp.example.test" && c.headers["User-Agent"] === "Example/1")).toBe(true);
    expect(calls.map((c) => detailId(c.url)).filter((id) => id !== null).sort()).toEqual(["b000000002", "b000000003", "b000000004", "b000000005", "b000000007", "b00000000b", "b00000000c", "b000000011"].sort());
    expect(indexUrl({ base_url: "https://hp.example.test/" })).toBe("https://hp.example.test/jobs/search-index.json");
  });

  it("does not fetch a detail it has stored, and re-delivers the stored one", async () => {
    const known = new Map<string, unknown>([["b000000002", { index: entryOf("b000000002"), detail: { ...(DETAILS.get("b000000002") as object), descriptionHTML: "<p>stored text</p>" } }]]);
    const { ctx, calls } = makeContext(site(), {}, { known });
    const postings = await channel().channel.collect(sweepQuery(), ctx);
    expect(calls.map((c) => detailId(c.url))).not.toContain("b000000002");
    expect(postings.find((p) => p.externalId === "b000000002")?.payload).toMatchObject({ detail: { descriptionHTML: "<p>stored text</p>" } });
  });

  it("fetches at most max_details_per_run and leaves the rest for the next run", async () => {
    const records: LogRecord[] = [];
    const { ctx, calls, sleeps } = makeContext(site(), { max_details_per_run: 2 }, { records });
    const postings = await channel().channel.collect(sweepQuery(), ctx);
    expect(calls.filter((c) => detailId(c.url) !== null)).toHaveLength(2);
    expect(ids(postings)).toEqual(["b000000002", "b000000003"]);
    expect(sleeps).toEqual([THROTTLE_MS]); // between the two detail requests
    expect(records.find((r) => r.message.includes("done"))?.fields).toMatchObject({ fetched: 2, deferred: 6, postings: 2 });
  });

  it("keeps at most max_results postings, newest first, and honours a smaller query limit", async () => {
    const { ctx } = makeContext(site(), {}, { maxResults: 3 });
    expect(ids(await channel().channel.collect(sweepQuery(), ctx))).toEqual(["b000000002", "b000000003", "b000000011"]);
    const second = makeContext(site());
    expect(await channel().channel.collect(sweepQuery({ maxResults: 1 }), second.ctx)).toHaveLength(1);
  });

  it("books the stored postings against the budget", async () => {
    const consumed: number[] = [];
    const { ctx } = makeContext(site(), {}, { consumed });
    const postings = await channel().channel.collect(sweepQuery(), ctx);
    expect(consumed).toEqual([postings.length]);
  });

  it("does not start when the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, calls } = makeContext(site(), {}, { signal: controller.signal });
    await expect(channel().channel.collect(sweepQuery(), ctx)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("stops fetching details when the run is cancelled in between", async () => {
    const controller = new AbortController();
    const { ctx, calls } = makeContext(
      (call, n) => {
        if (n === 1) controller.abort();
        return site()(call, n);
      },
      {},
      { signal: controller.signal },
    );
    await expect(channel().channel.collect(sweepQuery(), ctx)).rejects.toThrow();
    expect(calls.length).toBeLessThan(5);
  });

  it("never puts an id that is not hexadecimal into a URL", async () => {
    expect(detailUrl({ base_url: "https://x.example" }, "../etc")).toBeNull();
    expect(detailUrl({ base_url: "https://x.example/" }, "AB12")).toBe("https://x.example/jobs/d/AB12.json");
    const index = [{ ...entryOf("b000000002"), id: "../admin" }, entryOf("b000000003")];
    const records: LogRecord[] = [];
    const { ctx, calls } = makeContext(site(index), {}, { records });
    const postings = await channel().channel.collect(sweepQuery(), ctx);
    expect(ids(postings)).toEqual(["b000000003"]);
    expect(calls.every((c) => !c.url.pathname.includes(".."))).toBe(true);
    expect(records.find((r) => r.level === "warn" && r.message.includes("unexpected shape"))?.fields).toMatchObject({ count: 1 });
  });
});

describe("collect: errors", () => {
  const failure = async (handler: Handler, options: { maxRetries?: number } = {}): Promise<ChannelError> => {
    const { ctx } = makeContext(handler, {}, options);
    const error = await channel()
      .channel.collect(sweepQuery(), ctx)
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    return error as ChannelError;
  };

  it("an index of the wrong shape is a parse error", async () => {
    expect((await failure(site(readJson("index-object.json")))).code).toBe("parse");
    expect((await failure(() => response(200, "<html>maintenance</html>"))).code).toBe("parse");
  });

  it("a broken entry is skipped with a warning, the others are kept", async () => {
    const records: LogRecord[] = [];
    const { ctx } = makeContext(site(), {}, { records });
    const postings = await channel().channel.collect(sweepQuery(), ctx);
    expect(postings.length).toBeGreaterThan(0);
    expect(records.find((r) => r.level === "warn" && r.message.includes("unexpected shape"))?.fields).toMatchObject({ count: 2 });
  });

  it("a 403, 404 and 410 on the index are blocked and open the circuit", async () => {
    expect((await failure(() => response(403, "Forbidden"))).code).toBe("blocked");
    for (const status of [404, 410]) {
      const error = await failure(() => response(status, "gone"));
      expect(error).toMatchObject({ code: "blocked", tripsCircuit: true });
      expect(error.message).toContain(`HTTP ${status}`);
    }
  });

  it("retries a 429 after its Retry-After", async () => {
    const { ctx, calls, sleeps } = makeContext((call, n) => (n === 0 ? response(429, "", { "Retry-After": "2" }) : site()(call, n)), {}, { maxRetries: 2 });
    expect((await channel().channel.collect(sweepQuery(), ctx)).length).toBeGreaterThan(0);
    expect(calls[0]?.url.pathname).toBe("/jobs/search-index.json");
    expect(calls[1]?.url.pathname).toBe("/jobs/search-index.json");
    expect(sleeps[0]).toBe(2000);
  });

  it("an empty index returns nothing and warns, without judging any posting gone", async () => {
    const records: LogRecord[] = [];
    const { ctx } = makeContext(site(readJson("index-empty.json")), {}, { records });
    expect(await channel().channel.collect(sweepQuery(), ctx)).toEqual([]);
    expect(records.some((r) => r.level === "warn" && r.message.includes("empty"))).toBe(true);
  });

  it("a withdrawn detail only loses that posting; a detail of the wrong shape too", async () => {
    const records: LogRecord[] = [];
    const bad = (call: Call, n: number) => {
      const id = detailId(call.url);
      if (id === "b000000003") return response(200, { id });
      if (id === "b000000004") return response(404, "gone");
      return site()(call, n);
    };
    const { ctx } = makeContext(bad, {}, { records });
    const postings = await channel().channel.collect(sweepQuery(), ctx);
    expect(ids(postings)).not.toContain("b000000003");
    expect(ids(postings)).not.toContain("b000000004");
    expect(ids(postings)).toContain("b000000002");
    expect(records.some((r) => r.level === "warn" && r.message.includes("withdrawn"))).toBe(true);
    expect(records.some((r) => r.level === "warn" && r.message.includes("details of an unexpected shape"))).toBe(true);
  });

  it("a failing detail after some were fetched keeps those and interrupts the run", async () => {
    const consumed: number[] = [];
    const handler = (call: Call, n: number) => (detailId(call.url) === "b000000004" ? response(503, "down") : site()(call, n));
    const { ctx, calls } = makeContext(handler, {}, { consumed });
    const result = await channel().channel.collect(sweepQuery(), ctx).then(() => null, (e: unknown) => e);
    expect(result).toBeInstanceOf(PartialCollectError);
    const error = result as PartialCollectError;
    expect(ids(error.postings)).toEqual(["b000000002", "b000000003", "b000000011"]);
    expect(error.cause.code).toBe("network");
    expect(calls.filter((c) => detailId(c.url) !== null)).toHaveLength(4); // nothing after the failure
    expect(consumed).toEqual([3]);
  });

  it("a failing first detail fails the run", async () => {
    const error = await failure((call, n) => (detailId(call.url) !== null ? response(500, "down") : site()(call, n)));
    expect(error.code).toBe("network");
  });
});

describe("collect: company discovery", () => {
  const SEEN = ["ashby:beta-labs", "greenhouse:gammasystems", "lever:zeta-remote", "personio:acme-robotics", "personio:delta-analytics", "personio:lambda-old"].sort();
  const seen = (store: ReturnType<typeof createMemoryDiscoveryStore>) => [...store.candidates.keys()].sort();

  it("writes the boards of matching postings that are not in ats_boards, tagged and titled with the company", async () => {
    const { store, channel: c } = channel();
    const { ctx } = makeContext(site(), {}, { real: true });
    await c.collect(sweepQuery(), ctx);
    expect(seen(store)).toEqual(SEEN);
    expect(store.candidates.get("personio:acme-robotics")).toMatchObject({ title: "Acme Robotics", foundBy: "handpicked", boardUrl: "https://acme-robotics.jobs.personio.de" });
    expect(store.foundBy.get("ashby:beta-labs")).toEqual(["handpicked"]);
    expect(store.runs).toBe(1);
  });

  it("leaves out join.com, Workday and other hosts, and boards that ats_boards lists", async () => {
    const { store, channel: c } = channel({ boards: [{ ats: "personio", token: "Acme-Robotics", enabled: false }] });
    await c.collect(sweepQuery(), makeContext(site(), {}, { real: true }).ctx);
    expect(seen(store)).not.toContain("personio:acme-robotics");
    expect(seen(store).some((k) => /join|kappa|omicron/.test(k))).toBe(false);
  });

  it("offers more companies when the title need not match", async () => {
    const { store, channel: c } = channel();
    await c.collect(sweepQuery(), makeContext(site(), { discover_boards: { enabled: true, interval_hours: 24, require_title_match: false } }, { real: true }).ctx);
    expect(seen(store)).toEqual(expect.arrayContaining(["personio:eta-office", "personio:theta-studios", ...SEEN]));
    expect(seen(store)).not.toContain("personio:epsilon-nord"); // hamburg is not a wanted place
  });

  it("writes nothing while the interval is running, and still returns the postings", async () => {
    const { store, channel: c } = channel();
    store.last = new Date(NOW.getTime() - 3_600_000);
    const postings = await c.collect(sweepQuery(), makeContext(site(), {}, { real: true }).ctx);
    expect(postings.length).toBeGreaterThan(0);
    expect(store.candidates.size).toBe(0);
    expect(store.runs).toBe(0);
  });

  it("writes again once the interval has passed", async () => {
    const { store, channel: c } = channel();
    store.last = new Date(NOW.getTime() - 25 * 3_600_000);
    await c.collect(sweepQuery(), makeContext(site(), {}, { real: true }).ctx);
    expect(store.candidates.size).toBeGreaterThan(0);
  });

  it("a dry run neither reads nor writes the store and lists the candidates in the log", async () => {
    const records: LogRecord[] = [];
    let asked = 0;
    const { store, channel: c } = channel({}, { store: () => { asked += 1; return createMemoryDiscoveryStore(); } });
    await c.collect(sweepQuery(), makeContext(site(), {}, { records }).ctx);
    expect(asked).toBe(0);
    expect(store.candidates.size).toBe(0);
    expect(records.find((r) => r.message.includes("dry run"))?.fields).toMatchObject({ boards: expect.arrayContaining(SEEN) as string[] });
    expect((records.find((r) => r.message.includes("dry run"))?.fields as { boards: string[] }).boards).toHaveLength(SEEN.length);
  });

  it("does nothing when discovery is switched off", async () => {
    const { store, channel: c } = channel();
    await c.collect(sweepQuery(), makeContext(site(), { discover_boards: { enabled: false, interval_hours: 24, require_title_match: true } }, { real: true }).ctx);
    expect(store.candidates.size + store.runs).toBe(0);
  });

  it("a failing store costs a warning, not the postings", async () => {
    const records: LogRecord[] = [];
    const broken = createMemoryDiscoveryStore();
    broken.upsert = async () => {
      throw new Error("database down");
    };
    const { channel: c } = channel({}, { store: () => broken });
    const postings = await c.collect(sweepQuery(), makeContext(site(), {}, { real: true, records }).ctx);
    expect(postings.length).toBeGreaterThan(0);
    expect(records.find((r) => r.level === "warn" && r.message.includes("discovery failed"))?.fields).toMatchObject({ error: "database down" });
  });

  it("still discovers when the postings are interrupted, and the interruption is reported", async () => {
    const { store, channel: c } = channel();
    const handler = (call: Call, n: number) => (detailId(call.url) === "b000000004" ? response(503, "down") : site()(call, n));
    await expect(c.collect(sweepQuery(), makeContext(handler, {}, { real: true }).ctx)).rejects.toBeInstanceOf(PartialCollectError);
    expect(store.candidates.size).toBeGreaterThan(0);
  });
});

describe("settings", () => {
  it("the shipped block is a valid, switched-off channel", () => {
    expect(shippedChannels().sources.handpicked).toMatchObject({ markets: ["DE"], monthly_budget_usd: 0 });
  });
});
