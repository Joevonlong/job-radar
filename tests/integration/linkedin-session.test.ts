import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import type { CascadeSpec } from "@/lib/channels/cascade";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import { createApifyChannel } from "@/lib/channels/linkedin/apify";
import { createBrightDataChannel } from "@/lib/channels/linkedin/brightdata";
import { Mutex } from "@/lib/channels/linkedin/session/browser";
import { createSessionChannels, type SessionChannelDeps } from "@/lib/channels/linkedin/session/channel";
import { AUTH_FLAG_KEY } from "@/lib/channels/linkedin/session/auth-state";
import { createDbSessionStore, resetSessionAuth } from "@/lib/channels/linkedin/session/store";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import type { CycleKind } from "@/lib/db/repos/cycles";
import { closeDb, getDb, listChannelStates, listRawPostingsForChannel, listRunsForCycle } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getRuntimeState } from "@/lib/db/repos/runtime-state";
import { buildAlerts, collectErrorsOf } from "@/lib/notify/alerts";

import { fixture, happySite, authFileIn, fakeBrowser, type FakeSite } from "../channels/linkedin/session/helpers";
import { channelsWith } from "../channels/helpers";
import { config, quietLogger } from "../cycle/helpers";
import { notifyText } from "@/lib/notify/text";

const url = inject("testDatabaseUrl");

const NOW = new Date("2026-10-07T08:00:00Z"); // Wednesday 10:00 in Berlin: after the 07:00 slot
const BRIGHT = "linkedin-brightdata";
const APIFY = "linkedin-apify";
const SESSION = "linkedin-session";
const RECOMMENDED = "linkedin-session:recommended";
const GUEST = "fx-guest";
const cascade: CascadeSpec[] = [{ family: "linkedin", order: [BRIGHT, APIFY, SESSION, GUEST] }];

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, runs, cycles, channels, runtime_state restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

/** Bright Data switched off, Apify without a token (so "not configured"), the session channel on; `edit` changes the session block. */
function channels(edit: (session: Record<string, unknown>) => void = () => {}) {
  return channelsWith((raw) => {
    const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
    (linkedin.brightdata as Record<string, unknown>).enabled = false;
    const session = linkedin.session as Record<string, unknown>;
    session.enabled = true;
    session.recommended_daily = false;
    edit(session);
  });
}

function setup(options: { site?: FakeSite; login?: boolean; edit?: (session: Record<string, unknown>) => void } = {}) {
  const clock = { now: NOW };
  const channelsConfig = channels(options.edit);
  const authFile = authFileIn({ login: options.login ?? true });
  const browser = fakeBrowser(options.site ?? happySite());
  const deps: SessionChannelDeps = {
    settings: () => channelsConfig.linkedin.session,
    timeZone: () => "Europe/Berlin",
    recommendedSchedule: () => ({ enabled: true, cron: "0 7 * * *", timezone: "Europe/Berlin" }),
    store: () => createDbSessionStore(getDb()),
    openBrowser: browser.open,
    now: () => clock.now,
    authFile: () => authFile,
    mutex: new Mutex(),
  };
  const session = createSessionChannels(deps);
  const registry = new ChannelRegistry();
  registry.register(createBrightDataChannel({ costPer1kUsd: () => 1.5, environment: {}, now: () => NOW, sleep: async () => {} }));
  registry.register(createApifyChannel({ pricePer1kUsd: () => 0.4, actorId: () => "valig/linkedin-jobs-scraper", environment: {}, now: () => NOW }));
  registry.register(session.session);
  registry.register(session.recommended);
  const guest = registerFixtureChannel(registry, { id: GUEST, family: "linkedin" });
  const run = (kind: CycleKind = "manual") =>
    runCycle(kind, { registry, cascades: cascade, config: { ...config(), channels: channelsConfig }, logger: quietLogger, sleep: async () => {}, random: () => 0, now: () => clock.now });
  return { run, guest, browser, registry, channelsConfig, clock };
}

const flag = async () => (await getRuntimeState(getDb(), AUTH_FLAG_KEY))?.value;

describe("LinkedIn cascade: the session channel is third", () => {
  it("with Bright Data off and Apify not configured, the session channel serves every query; the guest channel is never reached", async () => {
    const { run, guest, browser } = setup();
    const result = await run();
    expect(result.status).toBe("succeeded");

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.map((r) => [r.channelId, r.status])).toEqual(Array(9).fill([SESSION, "succeeded"]));
    expect(guest.seen).toHaveLength(0);
    // 101, 102, 104 are real postings (103 is closed, 106 is gone)
    const raw = await listRawPostingsForChannel(getDb(), SESSION);
    expect(raw.map((r) => r.externalId).sort()).toEqual(["4385000101", "4385000102", "4385000104"]);
    expect(runs[0]).toMatchObject({ fetched: 3, newCount: 3 });
    expect(runs[1]).toMatchObject({ fetched: 3, newCount: 0 }); // already held: delivered again unchanged, no page opened for them

    // every page load was counted for the day, and the login was marked valid
    const counted = (await getRuntimeState(getDb(), "linkedin-session:requests:2026-10-07"))?.value;
    expect(counted).toEqual({ count: browser.log.loads.length });
    expect(await flag()).toMatchObject({ status: "valid" });
    const state = (await listChannelStates(getDb())).find((s) => s.id === SESSION);
    expect(state).toMatchObject({ circuitState: "closed", consecutiveFailures: 0 });
    expect(state?.lastSuccessAt).not.toBeNull();
  });

  it("without a login file the cascade skips the session channel (no failed run, no circuit strike) and the next channel serves", async () => {
    const { run, guest, browser } = setup({ login: false });
    const result = await run();
    expect(result.status).toBe("succeeded");
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.some((r) => r.channelId === SESSION)).toBe(false);
    expect(runs.filter((r) => r.channelId === GUEST)).toHaveLength(9);
    expect(guest.seen).toHaveLength(9);
    expect(browser.log.opened).toHaveLength(0);
    const state = (await listChannelStates(getDb())).find((s) => s.id === SESSION);
    expect(state?.consecutiveFailures ?? 0).toBe(0);
  });

  it("a login wall stops the session channel at once: one failed run, the circuit opens, the login is marked expired, the same query goes to the next channel", async () => {
    const wall: FakeSite = () => ({ html: fixture("login-wall.html"), url: "https://www.linkedin.com/login?session_redirect=x" });
    const { run, guest, browser } = setup({ site: wall });
    const first = await run();
    const runs = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(runs[0]).toMatchObject({ channelId: SESSION, status: "failed", errorCode: "auth_expired" });
    expect(runs.filter((r) => r.channelId === GUEST)).toHaveLength(9);
    expect(browser.log.loads).toHaveLength(1);
    expect(guest.seen).toHaveLength(9);

    const state = (await listChannelStates(getDb())).find((s) => s.id === SESSION);
    expect(state).toMatchObject({ circuitState: "open", consecutiveFailures: 1, lastErrorCode: "auth_expired" });
    expect(await flag()).toMatchObject({ status: "expired", reason: "login_required" });

    // the Telegram alert asks for a new login
    const alerts = buildAlerts({
      channels: [{ id: SESSION, family: "linkedin", enabled: true, circuitState: "open", lastErrorCode: "auth_expired" }],
      collectErrors: collectErrorsOf(first.results.collect),
      budgets: [],
      budgetThresholds: [],
      aiAllProvidersFailed: false,
    }, notifyText("zh"));
    expect(alerts.map((a) => `${a.kind}:${a.key}`)).toEqual([`circuit_open:${SESSION}`, `auth_expired:${SESSION}`]);
    expect(alerts.find((a) => a.kind === "auth_expired")?.title).toBe("LinkedIn 登录态失效，需要重新登录");
    expect(alerts.find((a) => a.kind === "auth_expired")?.detail).toContain("pnpm auth:linkedin");

    // later cycles do not touch LinkedIn at all while the circuit is open
    const second = await run();
    expect(browser.log.loads).toHaveLength(1);
    expect((await listRunsForCycle(getDb(), second.cycleId as number)).every((r) => r.channelId === GUEST)).toBe(true);

    // after the user logs in again, `pnpm auth:linkedin` marks the login valid and closes the circuit: the channel is back
    expect(await resetSessionAuth(getDb(), new Date(NOW.getTime() + 1000))).toEqual([SESSION]);
    expect(await flag()).toMatchObject({ status: "valid" });
  });

  it("a verification page raises the 'verification' alert, opens the circuit, and nothing is attempted on it", async () => {
    const challenge: FakeSite = () => ({ html: fixture("checkpoint.html"), url: "https://www.linkedin.com/checkpoint/challenge/AgE" });
    const { run, guest, browser } = setup({ site: challenge });
    const result = await run();
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs[0]).toMatchObject({ channelId: SESSION, status: "failed", errorCode: "blocked" });
    expect(browser.log.loads).toHaveLength(1); // one page, then stop
    expect(guest.seen).toHaveLength(9);
    expect((await listChannelStates(getDb())).find((s) => s.id === SESSION)).toMatchObject({ circuitState: "open", lastErrorCode: "blocked" });
    expect(await flag()).toMatchObject({ status: "expired", reason: "checkpoint" });
    const alerts = buildAlerts({
      channels: [{ id: SESSION, family: "linkedin", enabled: true, circuitState: "open", lastErrorCode: "blocked" }],
      collectErrors: collectErrorsOf(result.results.collect),
      budgets: [],
      budgetThresholds: [],
      aiAllProvidersFailed: false,
    }, notifyText("zh"));
    expect(alerts.map((a) => a.kind)).toEqual(["circuit_open", "verification"]);
    expect(alerts.find((a) => a.kind === "verification")?.detail).toContain("不会尝试自动通过");
  });

  it("when the day's page limit is used up the channel is skipped (budget) and the next channel takes over", async () => {
    const { run, guest, browser } = setup({ edit: (session) => (session.daily_request_limit = 2) });
    const result = await run();
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    // the first query gets 2 pages (search page + one posting page), then the limit is reached; the rest goes to the guest channel
    expect(runs[0]).toMatchObject({ channelId: SESSION, status: "succeeded" });
    expect(runs[1]).toMatchObject({ channelId: SESSION, status: "skipped", errorCode: "budget_exceeded" });
    expect(runs.slice(2).every((r) => r.channelId === GUEST)).toBe(true);
    expect(browser.log.loads).toHaveLength(2);
    expect(guest.seen.length).toBeGreaterThan(0);
  });
});

describe("a posting page that fails part-way", () => {
  it("keeps the postings read: interrupted run, the rest of the day skipped, and the next day does not open the pages of the stored postings", async () => {
    const site = { failing: true };
    const flaky = happySite({ detail: (u) => (site.failing && u.pathname.includes("4385000103") ? { html: "", timeout: true } : null) });
    // 7 pages: four search pages (two keyword strings, two pages each), the postings 101 and 102, and 103, which times out on the last page of the day
    const { run, guest, browser, clock } = setup({ site: flaky, edit: (session) => (session.daily_request_limit = 7) });

    const first = await run();
    const runs = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(runs[0]).toMatchObject({ channelId: SESSION, status: "partial", interrupted: true, errorCode: "network", fetched: 2, newCount: 2 });
    expect((await listRawPostingsForChannel(getDb(), SESSION)).map((r) => r.externalId).sort()).toEqual(["4385000101", "4385000102"]);
    expect((await getRuntimeState(getDb(), "linkedin-session:requests:2026-10-07"))?.value).toEqual({ count: 7 });
    // the day's pages are used up: the next query of the channel is skipped without opening a browser, the guest channel takes over
    expect(runs[1]).toMatchObject({ channelId: SESSION, status: "skipped", errorCode: "budget_exceeded", fetched: 0 });
    expect(runs.filter((r) => r.channelId === SESSION)).toHaveLength(2);
    expect(runs.filter((r) => r.channelId === GUEST).length).toBeGreaterThan(0);
    expect(browser.log.opened).toHaveLength(1);
    expect(browser.log.loads).toHaveLength(7);
    expect(guest.seen.length).toBeGreaterThan(0);

    // the next day: what the first day stored is delivered again from the database and its pages are not opened
    clock.now = new Date("2026-10-08T08:00:00Z");
    site.failing = false;
    const before = browser.log.loads.length;
    const second = await run();
    const next = browser.log.loads.slice(before).map((l) => new URL(l.url).pathname).filter((p) => p.startsWith("/jobs/view/"));
    expect(next).not.toContain("/jobs/view/4385000101/");
    expect(next).not.toContain("/jobs/view/4385000102/");
    expect(next).toContain("/jobs/view/4385000103/");
    const secondRuns = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(secondRuns[0]).toMatchObject({ channelId: SESSION, status: "succeeded", interrupted: false, fetched: 3, newCount: 1 });
    expect((await listRawPostingsForChannel(getDb(), SESSION)).map((r) => r.externalId).sort()).toEqual(["4385000101", "4385000102", "4385000104"]);
  });
});

describe("linkedin-session:recommended", () => {
  const withRecommended = { edit: (session: Record<string, unknown>) => (session.recommended_daily = true) };

  it("is read once a day: in the first scheduled cycle after the slot, not again in the next one that day; a manual cycle always reads it", async () => {
    const { run, browser } = setup(withRecommended);
    const morning = await run("weekday_morning");
    const runs = await listRunsForCycle(getDb(), morning.cycleId as number);
    const recommended = runs.filter((r) => r.channelId === RECOMMENDED);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]).toMatchObject({ status: "succeeded", fetched: 2 });
    expect(runs.filter((r) => r.channelId === SESSION)).toHaveLength(9);
    expect(browser.log.loads.some((l) => new URL(l.url).pathname === "/jobs/collections/recommended/")).toBe(true);
    expect((await listRawPostingsForChannel(getDb(), RECOMMENDED)).map((r) => r.externalId).sort()).toEqual(["4385000201", "4385000202"]);

    const evening = await run("weekday_evening");
    const eveningRuns = await listRunsForCycle(getDb(), evening.cycleId as number);
    expect(eveningRuns.some((r) => r.channelId === RECOMMENDED)).toBe(false);
    expect(eveningRuns.filter((r) => r.channelId === SESSION)).toHaveLength(9);

    const manual = await run("manual");
    expect((await listRunsForCycle(getDb(), manual.cycleId as number)).filter((r) => r.channelId === RECOMMENDED)).toHaveLength(1);
  });

  it("is left out entirely without a login (no skipped run, the cycle stays succeeded)", async () => {
    const { run } = setup({ ...withRecommended, login: false });
    const result = await run("weekday_morning");
    expect(result.status).toBe("succeeded");
    expect((await listRunsForCycle(getDb(), result.cycleId as number)).some((r) => r.channelId === RECOMMENDED)).toBe(false);
  });

  it("does not run when recommended_daily is off", async () => {
    const { run } = setup({ edit: (session) => (session.recommended_daily = false) });
    const result = await run("weekday_morning");
    expect((await listRunsForCycle(getDb(), result.cycleId as number)).some((r) => r.channelId === RECOMMENDED)).toBe(false);
  });

  it("`pnpm cycle:run --channel linkedin-session:recommended` runs it alone", async () => {
    const { registry, channelsConfig } = setup(withRecommended);
    const result = await runCycle("manual", { registry, channelIds: [RECOMMENDED], cascades: cascade, config: { ...config(), channels: channelsConfig }, logger: quietLogger, sleep: async () => {}, random: () => 0, now: () => NOW });
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.map((r) => r.channelId)).toEqual([RECOMMENDED]);
  });
});
