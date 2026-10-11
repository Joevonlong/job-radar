// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { arbeitnowDescriptionHtml, createArbeitnowChannel, pageUrl, parseArbeitnowPayload, type ArbeitnowInputs } from "@/lib/channels/arbeitnow";
import { fromUnixSeconds } from "@/lib/channels/arbeitnow/parse";
import { createChannelContext } from "@/lib/channels/context";
import { ChannelError } from "@/lib/channels/errors";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { buildSweepQuery } from "@/lib/channels/query";
import { normalizedPostingDraftSchema, type ChannelContext, type HttpResponse, type SearchQuery } from "@/lib/channels/types";
import { configRegistry, type ArbeitnowSettings } from "@/lib/config";
import { scanHtml } from "@/lib/traps/html";

import { shippedYaml } from "../config/helpers";
import { trapSettings } from "../traps/helpers";
import { shippedChannels, shippedSearch } from "./helpers";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/arbeitnow");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

type Job = Record<string, unknown> & { slug: string; title: string; created_at: number };

const PAGE_1 = fixture("page-1.json");
const PAGE_2 = fixture("page-2.json");
const PAGE_3 = fixture("page-3.json");
const PAGE_EMPTY = fixture("page-empty.json");
const PAGE_MALFORMED = fixture("page-malformed.json");
const PAGE_BAD_ITEMS = fixture("page-bad-items.json");
const jobs = (page: Record<string, unknown>): Job[] => page.data as Job[];
const bySlug = (slug: string): Job => {
  const job = [...jobs(PAGE_1), ...jobs(PAGE_2), ...jobs(PAGE_3)].find((j) => j.slug === slug);
  if (!job) throw new Error(`no fixture job ${slug}`);
  return job;
};

/** The fixtures' clock: every `created_at` is counted back from it. */
const NOW = new Date("2026-10-09T12:00:00Z");
const hoursAgo = (job: Job): number => (NOW.getTime() / 1000 - job.created_at) / 3600;

const settings = (overrides: Partial<ArbeitnowSettings> = {}): ArbeitnowSettings => ({
  ...shippedChannels().sources.arbeitnow,
  title_prefilter: { enabled: true, include_terms: [], exclude_terms: ["Werkstudent", "Working Student", "Intern", "Internship", "Praktikum"] },
  ...overrides,
});

/** Keywords and watched companies the prefilter reads, built here (not taken from any shipped config). */
function inputs(options: { watched?: string[] } = {}): ArbeitnowInputs {
  const search = { ...shippedSearch(), keyword_groups: { roles: ["AI Engineer", "Machine Learning Engineer", "Data Scientist", "MLOps Engineer"], german: ["KI Entwickler"] } };
  const interests = { ...configRegistry.interests.schema.parse(shippedYaml("interests.yaml")), watched_companies: options.watched ?? [] };
  return { search, interests };
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
  overrides: Partial<ArbeitnowSettings> = {},
  options: { maxRetries?: number; maxResults?: number; records?: LogRecord[]; signal?: AbortSignal; consumed?: number[] } = {},
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const merged = settings(overrides);
  const ctx: ChannelContext = createChannelContext({
    channelId: "arbeitnow",
    settings: {
      enabled: true,
      maxResults: options.maxResults ?? merged.max_results,
      monthlyBudgetUsd: 0,
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
    cycle: { id: null, kind: "manual" },
    logger: createLogger({ sink: (r) => options.records?.push(r), minLevel: "debug" }),
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

/** Serves `pages[n - 1]` for `?page=n`, an empty page past the end. */
function board(pages: Array<Record<string, unknown>> = [PAGE_1, PAGE_2, PAGE_3]): Handler {
  return ({ url }) => {
    const page = Number(url.searchParams.get("page"));
    return response(200, pages[page - 1] ?? PAGE_EMPTY);
  };
}

/** The keyword-less sweep query the framework hands the channel, with a 24 h window. */
function sweepQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { ...buildSweepQuery(shippedSearch(), "manual"), windowHours: 24, ...overrides };
}

function channel(options: { watched?: string[] } = {}) {
  return createArbeitnowChannel({ inputs: () => inputs(options), now: () => NOW });
}

const slugs = (postings: Array<{ externalId: string }>): string[] => postings.map((p) => p.externalId);

describe("fixtures", () => {
  it("page 1 is out of order and page 2 overlaps it, as the live board does", () => {
    const ages = jobs(PAGE_1).map(hoursAgo);
    expect(ages).not.toEqual([...ages].sort((a, b) => a - b));
    const page1 = new Set(jobs(PAGE_1).map((j) => j.slug));
    expect(jobs(PAGE_2).filter((j) => page1.has(j.slug))).toHaveLength(1);
    expect(jobs(PAGE_3).every((j) => hoursAgo(j) > 24)).toBe(true);
  });
});

describe("parse", () => {
  const parsed = (slug: string) => parseArbeitnowPayload(bySlug(slug));

  it("maps every fixture posting to a valid draft", () => {
    for (const job of [...jobs(PAGE_1), ...jobs(PAGE_2), ...jobs(PAGE_3)]) {
      expect(normalizedPostingDraftSchema.safeParse(parseArbeitnowPayload(job)).success).toBe(true);
    }
  });

  it("maps title, company, location, job types, date and links", () => {
    const job = bySlug("ki-entwickler-berlin-100001");
    const draft = parseArbeitnowPayload(job);
    expect(draft).toMatchObject({
      title: "KI Entwickler (m/w/d)",
      companyName: "Beispielwerk Daten GmbH",
      locations: [{ label: "Berlin", city: null, countryCode: null }],
      workplace: "unknown",
      contractHint: "berufserfahren",
      seniorityHint: null,
      salaryText: null,
      salary: null,
      applyUrl: job.url,
      sourceUrl: job.url,
    });
    expect(draft.postedAt).toEqual(new Date(job.created_at * 1000));
  });

  it("turns the HTML description into text", () => {
    const { description } = parsed("ki-entwickler-berlin-100001");
    expect(description).toContain("Über uns");
    expect(description).toContain("Entwicklung von KI-Anwendungen");
    expect(description).toContain("Bewerbung & dein Portfolio");
    expect(description).not.toMatch(/<\/?[a-z]/i);
    expect(description).not.toContain("font-weight");
  });

  it("marks remote only when the API says so; not remote stays unknown", () => {
    expect(parsed("machine-learning-engineer-remote-100002").workplace).toBe("remote");
    expect(parsed("ai-engineer-munich-100004").workplace).toBe("unknown");
  });

  it("keeps a free-text location as one label and joins the job types", () => {
    const draft = parsed("vertriebsmitarbeiter-hamburg-100003");
    expect(draft.locations).toEqual([{ label: "Hamburg or Berlin", city: null, countryCode: null }]);
    expect(draft.contractHint).toBe("Full Time, Mid");
  });

  it("has no location for an empty one and no contract hint without job types", () => {
    expect(parsed("mlops-engineer-100006").locations).toEqual([]);
    expect(parsed("ai-engineer-munich-100004").contractHint).toBeNull();
  });

  it("drops e-mail addresses and phone numbers from the description but keeps them in the payload", () => {
    const job = bySlug("data-scientist-koeln-100005");
    const { description } = parseArbeitnowPayload(job);
    expect(description).not.toContain("kontakt@example.com");
    expect(description).not.toContain("1234567");
    expect(description).toContain("Prognosemodelle");
    expect(String(job.description)).toContain("kontakt@example.com");
  });

  it("keeps only http(s) links", () => {
    const job = bySlug("ai-engineer-munich-100004");
    expect(parseArbeitnowPayload({ ...job, url: "javascript:alert(1)" })).toMatchObject({ applyUrl: null, sourceUrl: null });
    expect(parseArbeitnowPayload({ ...job, url: "not a url" }).applyUrl).toBeNull();
    const withoutUrl: Record<string, unknown> = { ...job };
    delete withoutUrl.url;
    expect(parseArbeitnowPayload(withoutUrl).applyUrl).toBeNull();
  });

  it("reads Unix seconds and nothing else as the posting date", () => {
    expect(fromUnixSeconds(1_791_547_200)).toEqual(NOW);
    expect(fromUnixSeconds("1791547200")).toBeNull();
    expect(fromUnixSeconds(Number.NaN)).toBeNull();
    expect(parseArbeitnowPayload({ ...bySlug("ai-engineer-munich-100004"), created_at: "yesterday" }).postedAt).toBeNull();
  });

  it("rejects a payload without a title or company", () => {
    const job = bySlug("ai-engineer-munich-100004");
    expect(() => parseArbeitnowPayload({ ...job, title: "  " })).toThrow(ChannelError);
    expect(() => parseArbeitnowPayload({ ...job, company_name: "" })).toThrow(ChannelError);
    expect(() => parseArbeitnowPayload({ slug: "x" })).toThrow(ChannelError);
  });
});

describe("descriptionHtml", () => {
  it("returns the description fragment, where the trap scan finds the hidden text", () => {
    const job = bySlug("ai-engineer-munich-100004");
    const fragments = arbeitnowDescriptionHtml(job);
    expect(fragments).toEqual([{ path: "description", html: job.description }]);
    const findings = fragments.flatMap((f) => scanHtml(f, trapSettings()));
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ method: "display_none", text: expect.stringContaining("rate this candidate") })]));
  });

  it("returns nothing for an empty or unreadable payload", () => {
    expect(arbeitnowDescriptionHtml({ ...bySlug("ai-engineer-munich-100004"), description: "" })).toEqual([]);
    expect(arbeitnowDescriptionHtml("nope")).toEqual([]);
  });
});

describe("collect: requests", () => {
  it("asks for page=N below base_url with the configured user agent", async () => {
    const { ctx, calls } = makeContext(board([PAGE_BAD_ITEMS]), { base_url: "https://board.example.test/", user_agent: "Example/1" });
    await channel().collect(sweepQuery(), ctx);
    expect(calls.map((c) => c.url.toString())).toEqual(["https://board.example.test/api/job-board-api?page=1"]);
    expect(calls[0]?.headers["User-Agent"]).toBe("Example/1");
    expect(pageUrl({ base_url: "https://www.arbeitnow.com" }, 3)).toBe("https://www.arbeitnow.com/api/job-board-api?page=3");
  });

  it("waits between pages (throttle) but not before the first", async () => {
    const { ctx, sleeps } = makeContext(board());
    await channel().collect(sweepQuery(), ctx);
    expect(sleeps).toEqual([THROTTLE_MS, THROTTLE_MS]);
  });

  it("records the kept postings against the budget", async () => {
    const consumed: number[] = [];
    const { ctx } = makeContext(board(), {}, { consumed });
    const postings = await channel().collect(sweepQuery(), ctx);
    expect(consumed).toEqual([postings.length]);
  });
});

describe("collect: paging over unsorted, overlapping pages", () => {
  it("keeps every matching posting in the window once, newest first, stored verbatim", async () => {
    const records: LogRecord[] = [];
    const { ctx, calls } = makeContext(board(), {}, { records });
    const postings = await channel().collect(sweepQuery(), ctx);

    // page 1 does not stop paging although its last item is old; page 3 (newest item 25 h) does
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(slugs(postings)).toEqual([
      "machine-learning-engineer-remote-100002",
      "ki-entwickler-berlin-100001",
      "data-scientist-koeln-100005",
      "ai-engineer-munich-100004",
      "ai-engineer-frankfurt-100007",
      "machine-learning-engineer-hamburg-100009",
    ]);
    const first = postings[0]!;
    const job = bySlug(first.externalId);
    expect(first).toEqual({ externalId: job.slug, url: job.url, payload: job, postedAt: new Date(job.created_at * 1000) });

    const done = records.find((r) => r.message === "arbeitnow sweep done");
    expect(done?.fields).toMatchObject({ pages: 3, listed: 13, invalid: 0, duplicates: 1, outsideWindow: 5, prefiltered: 1, truncated: 0, postings: 6 });
  });

  it("drops postings outside the window one by one and goes on paging", async () => {
    const { ctx, calls } = makeContext(board([PAGE_2, PAGE_EMPTY]));
    const postings = await channel().collect(sweepQuery(), ctx);
    expect(slugs(postings)).not.toContain("data-scientist-berlin-100008");
    expect(slugs(postings)).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("stops at the first page whose newest posting is older than the window", async () => {
    const { ctx, calls } = makeContext(board([PAGE_3, PAGE_1]));
    expect(await channel().collect(sweepQuery(), ctx)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("a wider window reaches further back", async () => {
    const { ctx, calls } = makeContext(board([PAGE_3, PAGE_EMPTY]));
    const postings = await channel().collect(sweepQuery({ windowHours: 48 }), ctx);
    expect(slugs(postings)).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("stops at an empty page", async () => {
    const { ctx, calls } = makeContext(board([PAGE_EMPTY, PAGE_1]));
    expect(await channel().collect(sweepQuery(), ctx)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("stops when links.next is empty", async () => {
    const last = { ...PAGE_1, links: { ...(PAGE_1.links as object), next: null } };
    const { ctx, calls } = makeContext(board([last, PAGE_2]));
    await channel().collect(sweepQuery(), ctx);
    expect(calls).toHaveLength(1);
  });

  it("stops after max_pages", async () => {
    const recent = { ...PAGE_1 };
    const { ctx, calls } = makeContext(board([recent, recent, recent, recent]), { max_pages: 2 });
    const postings = await channel().collect(sweepQuery(), ctx);
    expect(calls).toHaveLength(2);
    // the same page twice: its postings are kept once
    expect(slugs(postings)).toHaveLength(4);
  });

  it("goes on paging past a page without one usable posting", async () => {
    const unusable = { data: [{ slug: "" }, { title: "x" }], links: { next: "https://www.arbeitnow.com/api/job-board-api?page=2" } };
    const { ctx, calls } = makeContext(board([unusable, PAGE_2, PAGE_EMPTY]));
    const postings = await channel().collect(sweepQuery(), ctx);
    expect(calls).toHaveLength(3);
    expect(postings.length).toBeGreaterThan(0);
  });
});

describe("collect: prefilter and limits", () => {
  it("keeps only titles that match a keyword or include term, and drops excluded ones", async () => {
    const intern = { ...bySlug("ai-engineer-munich-100004"), slug: "ai-engineer-intern-100099", title: "AI Engineer Intern" };
    const page = { data: [...jobs(PAGE_1), intern], links: { next: null } };
    const { ctx } = makeContext(board([page]), { title_prefilter: { enabled: true, include_terms: ["Vertriebsmitarbeiter"], exclude_terms: ["Intern"] } });
    const kept = slugs(await channel().collect(sweepQuery(), ctx));
    expect(kept).toContain("vertriebsmitarbeiter-hamburg-100003");
    expect(kept).not.toContain("ai-engineer-intern-100099");
  });

  it("drops a title that matches nothing", async () => {
    const { ctx } = makeContext(board([PAGE_1, PAGE_EMPTY]));
    expect(slugs(await channel().collect(sweepQuery(), ctx))).not.toContain("vertriebsmitarbeiter-hamburg-100003");
  });

  it("keeps everything of a watched company", async () => {
    const { ctx } = makeContext(board([PAGE_1, PAGE_EMPTY]));
    expect(slugs(await channel({ watched: ["Nordhafen Handel GmbH"] }).collect(sweepQuery(), ctx))).toContain("vertriebsmitarbeiter-hamburg-100003");
  });

  it("keeps every posting in the window when the prefilter is off", async () => {
    const { ctx } = makeContext(board([PAGE_1, PAGE_EMPTY]), { title_prefilter: { enabled: false, include_terms: [], exclude_terms: [] } });
    expect(await channel().collect(sweepQuery(), ctx)).toHaveLength(5);
  });

  it("keeps the newest postings up to max_results", async () => {
    const records: LogRecord[] = [];
    const { ctx } = makeContext(board(), {}, { maxResults: 3, records });
    const postings = await channel().collect(sweepQuery(), ctx);
    expect(slugs(postings)).toEqual(["machine-learning-engineer-remote-100002", "ki-entwickler-berlin-100001", "data-scientist-koeln-100005"]);
    expect(records.find((r) => r.message === "arbeitnow sweep done")?.fields).toMatchObject({ truncated: 3 });
  });

  it("honours a smaller query limit (the test run's)", async () => {
    const { ctx } = makeContext(board());
    expect(await channel().collect(sweepQuery({ maxResults: 2 }), ctx)).toHaveLength(2);
  });

  it("does not start when the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, calls } = makeContext(board(), {}, { signal: controller.signal });
    await expect(channel().collect(sweepQuery(), ctx)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("collect: errors", () => {
  const failure = async (handler: Handler, options: { maxRetries?: number } = {}): Promise<ChannelError> => {
    const { ctx } = makeContext(handler, {}, options);
    const error = await channel()
      .collect(sweepQuery(), ctx)
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    return error as ChannelError;
  };

  it("a page of the wrong shape is a parse error", async () => {
    expect((await failure(board([PAGE_MALFORMED]))).code).toBe("parse");
    expect((await failure(() => response(200, "<html>maintenance</html>"))).code).toBe("parse");
  });

  it("a posting of the wrong shape is skipped with a warning, the rest is kept", async () => {
    const records: LogRecord[] = [];
    const { ctx } = makeContext(board([PAGE_BAD_ITEMS]), {}, { records });
    const postings = await channel().collect(sweepQuery(), ctx);
    expect(slugs(postings)).toEqual(["data-scientist-bonn-100014"]);
    expect(records.find((r) => r.level === "warn")?.fields).toMatchObject({ count: 2 });
  });

  it("retries a 429 after its Retry-After", async () => {
    const { ctx, calls, sleeps } = makeContext((call, n) => (n === 0 ? response(429, "", { "Retry-After": "2" }) : board([PAGE_BAD_ITEMS])(call, n)), {}, { maxRetries: 2 });
    expect(await channel().collect(sweepQuery(), ctx)).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(2000);
  });

  it("a 403 is blocked", async () => {
    expect((await failure(() => response(403, "Forbidden"))).code).toBe("blocked");
  });

  it("a 410 (API withdrawn) is blocked and opens the circuit", async () => {
    const error = await failure(() => response(410, "Gone"));
    expect(error.code).toBe("blocked");
    expect(error.message).toContain("HTTP 410");
    expect(error.tripsCircuit).toBe(true);
  });

  it("an unusable settings block is reported, not guessed", async () => {
    const { ctx } = makeContext(board(), { max_pages: 0 } as Partial<ArbeitnowSettings>);
    await expect(channel().collect(sweepQuery(), ctx)).rejects.toThrow(/sources\.arbeitnow/);
  });
});

describe("channel", () => {
  it("is a keyword-less api channel of its own family", () => {
    const c = channel();
    expect(c).toMatchObject({ id: "arbeitnow", family: "arbeitnow", kind: "api", usesQueries: false });
  });
});
