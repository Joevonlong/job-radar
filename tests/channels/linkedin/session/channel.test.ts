// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BudgetExceededError, ChannelError } from "@/lib/channels/errors";
import { sessionPayloadSchema } from "@/lib/channels/linkedin/session/payload";
import { createMemorySessionStore } from "@/lib/channels/linkedin/session/store";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

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

const DAY = "2026-10-07";

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

  it("stops listing at the limit; delivers what was read when the limit hits while reading postings", async () => {
    const s = setup({ config: limited(4), store: createMemorySessionStore({ requests: { [DAY]: 1 } }) });
    const h = await harness(s.session, s.config);
    const out = await s.session.collect(berlinQuery(), h.ctx);
    // 3 loads left: the search page, the next search page, then one posting page
    expect(s.browser.log.loads).toHaveLength(3);
    expect(out.map((o) => o.externalId)).toEqual(["4385000101"]);
    expect(s.store.requests.get(DAY)).toBe(4);
    expect(h.warnings.map((w) => w.message)).toContain("daily page limit reached while reading postings; the rest waits for the next run");
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

  it("a verification page in the middle of reading postings stops at once (earlier postings are not delivered half-way)", async () => {
    const s = setup({ site: happySite({ detail: (url) => (url.pathname.includes("4385000102") ? { html: fixture("checkpoint.html") } : null) }) });
    const h = await harness(s.session, s.config);
    expect(await failure(s.session.collect(berlinQuery(), h.ctx))).toMatchObject({ code: "blocked" });
    expect(s.browser.log.loads.map((l) => new URL(l.url).pathname).filter((p) => p.startsWith("/jobs/view/"))).toEqual(["/jobs/view/4385000101/", "/jobs/view/4385000102/"]);
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
