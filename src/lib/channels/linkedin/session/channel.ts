import { latestSlotAtOrBefore } from "@/lib/cycle/schedule";
import { getDb } from "@/lib/db/client";

import { BudgetExceededError, ChannelError } from "../../errors";
import { marketForChannel } from "../../market";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../../types";
import { loadConfig } from "@/lib/config";
import { hasLoginState, readAuthFileInfo, resolveAuthFile } from "./auth-file";
import { loginStateOf, type ExpiryReason } from "./auth-state";
import { openPlaywrightBrowser, sessionMutex, type LoadedPage, type Mutex, type OpenBrowser, type SessionBrowser } from "./browser";
import { classifyPage, type PageVerdict } from "./classify";
import {
  dayKey,
  jobUrl,
  keywordPieces,
  LINKEDIN_SESSION_ID,
  LINKEDIN_SESSION_RECOMMENDED_ID,
  readSessionSettings,
  recommendedUrl,
  searchUrl,
  SEARCH_PAGE_SIZE,
  type SessionSettings,
} from "./contract";
import { hasJobContent, parseJobDetail } from "./parse-detail";
import { isEmptyResultsPage, parseListCards, type ListCard } from "./parse-search";
import { buildPayload, parseSessionPayload, sessionDescriptionHtml, sessionPayloadSchema, type PayloadSource, type SessionPayload } from "./payload";
import { createDbSessionStore, createMemorySessionStore, type SessionStore } from "./store";

export interface SessionChannelDeps {
  /** `sources.yaml: linkedin.session`; a getter so a config reload takes effect without re-registering. */
  settings(): SessionSettings;
  /** `schedule.yaml: timezone`: the zone the daily request limit counts days in. */
  timeZone(): string;
  /** `schedule.yaml: linkedin_recommended`. */
  recommendedSchedule(): { enabled: boolean; cron: string; timezone: string };
  /** The store of a real run. Dry runs never call it (they get a throwaway in-memory store). */
  store(): SessionStore;
  openBrowser: OpenBrowser;
  now(): Date;
  /** Where the login state file lives; defaults to `linkedin.session.site.auth_file` under the app root. */
  authFile?(settings: SessionSettings): string;
  /** Serialises browsing sessions; one per process by default. */
  mutex?: Mutex;
}

/** The deps of the real channels: config from the hot-reloaded YAML, the database store, Playwright. */
export function defaultSessionDeps(): SessionChannelDeps {
  return {
    settings: () => loadConfig("channels").linkedin.session,
    timeZone: () => loadConfig("schedule").timezone,
    recommendedSchedule: () => {
      const schedule = loadConfig("schedule");
      return { ...schedule.linkedin_recommended, timezone: schedule.timezone };
    },
    store: () => createDbSessionStore(getDb()),
    openBrowser: openPlaywrightBrowser,
    now: () => new Date(),
  };
}

/** The daily page limit is used up (internal: turned into a budget skip, or into a partial result). */
class DailyLimitReached extends Error {
  constructor(readonly limit: number) {
    super(`daily request limit of ${limit} LinkedIn pages reached`);
    this.name = "DailyLimitReached";
  }
}

interface Plan {
  source: PayloadSource;
  /** How many keyword pieces are searched one after another (1 for the recommended list). */
  pieces: number;
  listUrl(piece: number, start: number): string;
  /** Most postings returned. */
  limit: number;
}

const EXPIRY_ERRORS: Record<Exclude<PageVerdict["kind"], "ok" | "unavailable" | "denied">, ExpiryReason> = {
  login_required: "login_required",
  checkpoint: "checkpoint",
};

/** The first line of an error message, with every URL cut down to its origin (no query strings in logs and run rows). */
function firstLine(message: string): string {
  const line = message.split("\n")[0]?.slice(0, 300) ?? "";
  return line.replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return "[url]";
    }
  });
}

/** One browsing session: open the browser with the saved login, read the list pages, then the pages of the postings that are new. */
async function browse(deps: SessionChannelDeps, ctx: ChannelContext, settings: SessionSettings, plan: Plan): Promise<RawPostingInput[]> {
  const authFile = deps.authFile ? deps.authFile(settings) : resolveAuthFile(settings.site.auth_file);
  const file = readAuthFileInfo(authFile);
  if (!file.hasSessionCookie) {
    throw new ChannelError("auth_expired", "no LinkedIn login state: run `pnpm auth:linkedin` once on the host", { retryable: false });
  }
  const dryRun = ctx.cycle.id === null;
  const store = dryRun ? createMemorySessionStore() : deps.store();
  const login = loginStateOf(file, await store.loadAuthFlag(), deps.now());
  if (login.status === "expired") {
    throw new ChannelError("auth_expired", `the saved LinkedIn login is no longer valid (${login.reason ?? "expired"}): run \`pnpm auth:linkedin\` to log in again`, { retryable: false });
  }

  return (deps.mutex ?? sessionMutex).run(async () => {
    const day = dayKey(deps.now(), deps.timeZone());
    const limit = settings.daily_request_limit;
    const counter = { used: await store.requestsOn(day) };
    if (counter.used >= limit) throw new BudgetExceededError("channel", `${LINKEDIN_SESSION_ID}: daily limit of ${limit} LinkedIn pages reached`);

    const browser: SessionBrowser = await deps.openBrowser({
      authFile,
      headless: settings.browser.headless,
      navigationTimeoutMs: settings.browser.navigation_timeout_ms,
      renderWaitMs: settings.browser.render_wait_ms,
      scrollSteps: settings.browser.scroll_steps,
      scrollPauseMs: settings.browser.scroll_pause_ms,
      locale: settings.browser.locale,
      blockResources: settings.browser.block_resources,
      userAgent: settings.browser.user_agent,
      signal: ctx.signal,
    });
    try {
      return await read({ deps, ctx, settings, plan, browser, store, day, counter });
    } finally {
      await browser.close();
    }
  });
}

interface ReadInput {
  deps: SessionChannelDeps;
  ctx: ChannelContext;
  settings: SessionSettings;
  plan: Plan;
  browser: SessionBrowser;
  store: SessionStore;
  day: string;
  /** Pages loaded today by all session channels (starts at the persisted count). */
  counter: { used: number };
}

async function read(input: ReadInput): Promise<RawPostingInput[]> {
  const { deps, ctx, settings, plan, browser, store, day } = input;
  const limit = settings.daily_request_limit;
  let loads = 0;
  let markedValid = false;

  /** Mark the login expired and stop: this is the whole reaction to a login wall or a verification page. */
  const expire = async (reason: ExpiryReason): Promise<void> => {
    await store.saveAuthFlag({ status: "expired", reason, at: deps.now().toISOString() });
  };

  const load = async (url: string, scrollList: boolean): Promise<{ page: LoadedPage; verdict: PageVerdict }> => {
    ctx.signal.throwIfAborted();
    if (input.counter.used >= limit) throw new DailyLimitReached(limit);
    if (loads > 0) await ctx.throttle();
    input.counter.used = await store.addRequest(day);
    loads += 1;
    let page: LoadedPage;
    try {
      page = await browser.load(url, { scrollList });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      // Playwright's TimeoutError must not look like a cancelled cycle
      throw new ChannelError("network", `LinkedIn page did not load: ${firstLine(error instanceof Error ? error.message : "unknown error")}`, { cause: error });
    }
    const verdict = classifyPage(page);
    if (verdict.kind === "login_required" || verdict.kind === "checkpoint") {
      await expire(EXPIRY_ERRORS[verdict.kind]);
      if (verdict.kind === "login_required") {
        throw new ChannelError("auth_expired", `LinkedIn asked to sign in (${verdict.reason}): the saved login is no longer valid; run \`pnpm auth:linkedin\` to log in again`, { retryable: false, tripsCircuit: true });
      }
      throw new ChannelError(
        "blocked",
        `LinkedIn showed a verification page (${verdict.reason}); stopped without touching it. Complete it in a normal browser, then run \`pnpm auth:linkedin\``,
        { retryable: false, tripsCircuit: true },
      );
    }
    if (verdict.kind === "denied") {
      if (verdict.status === 429) throw new ChannelError("rate_limited", "LinkedIn answered HTTP 429 (too many requests)", { status: 429 });
      throw new ChannelError("blocked", `LinkedIn denied the request (HTTP ${verdict.status})`, { status: verdict.status, retryable: false, tripsCircuit: true });
    }
    if (verdict.kind === "ok" && !markedValid) {
      markedValid = true;
      if ((await store.loadAuthFlag())?.status !== "valid") await store.saveAuthFlag({ status: "valid", at: deps.now().toISOString() });
    }
    return { page, verdict };
  };

  // ---- list pages
  const cards = new Map<string, ListCard>();
  let pages = 0;
  lists: for (let piece = 0; piece < plan.pieces; piece += 1) {
    for (let pageIndex = 0; pageIndex < settings.max_pages; pageIndex += 1) {
      if (cards.size >= plan.limit) break lists;
      let loaded: { page: LoadedPage; verdict: PageVerdict };
      try {
        loaded = await load(plan.listUrl(piece, pageIndex * SEARCH_PAGE_SIZE), true);
      } catch (error) {
        if (!(error instanceof DailyLimitReached)) throw error;
        if (cards.size === 0) throw new BudgetExceededError("channel", `${LINKEDIN_SESSION_ID}: daily limit of ${limit} LinkedIn pages reached`);
        ctx.logger.warn("daily page limit reached while listing", { limit });
        break lists;
      }
      pages += 1;
      const found = parseListCards(loaded.page.html, deps.now());
      if (found.length === 0) {
        if (pageIndex > 0 || isEmptyResultsPage(loaded.page.html)) break;
        throw new ChannelError("parse", "a LinkedIn result page has no job cards and is not an empty-results page: the page layout may have changed");
      }
      for (const card of found) if (!cards.has(card.jobId)) cards.set(card.jobId, card);
    }
  }

  // ---- postings
  const selected = [...cards.values()].slice(0, plan.limit);
  const stored = ctx.cycle.id === null ? new Map<string, unknown>() : await store.storedPayloads(selected.map((c) => c.jobId));
  const out: RawPostingInput[] = [];
  const counts = { reused: 0, fetched: 0, unavailable: 0, closed: 0, cardOnly: 0, unreadable: 0 };
  let capped = false;

  const emit = (jobId: string, payload: unknown, postedAt: string | null | undefined): void => {
    out.push({ externalId: jobId, url: jobUrl(settings.site.base_url, jobId), payload, postedAt: postedAt ? new Date(postedAt) : null });
  };

  for (const card of selected) {
    const prior = stored.get(card.jobId);
    const priorPayload = sessionPayloadSchema.safeParse(prior);
    if (priorPayload.success) {
      // already held: delivered again unchanged (no page load); that is what keeps the job "seen"
      emit(card.jobId, prior, priorPayload.data.postedAt);
      counts.reused += 1;
      continue;
    }
    const url = jobUrl(settings.site.base_url, card.jobId);
    let payload: SessionPayload | null;
    if (!settings.fetch_details) {
      payload = buildPayload({ jobId: card.jobId, url, source: plan.source, card, detail: null });
      if (payload === null) counts.unreadable += 1;
    } else {
      let loaded: { page: LoadedPage; verdict: PageVerdict };
      try {
        loaded = await load(url, false);
      } catch (error) {
        if (!(error instanceof DailyLimitReached)) throw error;
        capped = true;
        break;
      }
      if (loaded.verdict.kind === "unavailable") {
        counts.unavailable += 1;
        continue;
      }
      const detail = parseJobDetail(loaded.page.html, deps.now());
      if (detail.closed) {
        counts.closed += 1;
        continue;
      }
      const readable = hasJobContent(detail);
      payload = buildPayload({ jobId: card.jobId, url, source: plan.source, card, detail: readable ? detail : null });
      if (payload === null) counts.unreadable += 1;
      else if (readable) counts.fetched += 1;
      else counts.cardOnly += 1;
    }
    if (payload !== null) emit(card.jobId, payload, payload.postedAt);
  }
  if (capped) ctx.logger.warn("daily page limit reached while reading postings; the rest waits for the next run", { limit });
  if (out.length === 0 && counts.unreadable > 0) {
    throw new ChannelError("parse", "no LinkedIn posting page could be read: the page layout may have changed");
  }
  if (counts.cardOnly > 0) ctx.logger.warn("some posting pages had no readable content; their list card data was kept", { count: counts.cardOnly });
  ctx.logger.info("linkedin session read finished", {
    source: plan.source,
    listPages: pages,
    cards: cards.size,
    delivered: out.length,
    ...counts,
    pagesToday: input.counter.used,
    dailyLimit: limit,
    ...(ctx.cycle.id === null ? { dryRun: true, note: "dry run: the page loads are real, but the daily counter is not persisted" } : {}),
  });
  return out;
}

/**
 * The two LinkedIn channels that read with the user's own login: `linkedin-session` (third in the LinkedIn cascade: the keyword
 * searches of search.yaml) and `linkedin-session:recommended` ("recommended for you", once a day, outside the cascade).
 *
 * Both are read-only: pages are opened, nothing is clicked, liked, applied to or sent. A login wall or a verification page stops the run at
 * once (the circuit opens, a Telegram alert follows) and is never worked around. Without `.auth/linkedin.json` both channels are
 * "not configured": the cascade skips the first, the second is not due.
 */
export function createSessionChannels(deps: SessionChannelDeps = defaultSessionDeps()): { session: Channel; recommended: Channel } {
  const configured = (): boolean => {
    const settings = deps.settings();
    return hasLoginState(deps.authFile ? deps.authFile(settings) : resolveAuthFile(settings.site.auth_file));
  };

  const session: Channel = {
    id: LINKEDIN_SESSION_ID,
    family: "linkedin",
    kind: "session",
    usesQueries: true,
    isConfigured: configured,
    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const settings = readSessionSettings(ctx.settings.extra);
      const pieces = keywordPieces(query);
      const market = marketForChannel();
      return browse(deps, ctx, settings, {
        source: "search",
        pieces: pieces.length,
        listUrl: (piece, start) => searchUrl(query, settings, pieces[piece] ?? "", start, market),
        limit: query.maxResults,
      });
    },
    parse: parseSessionPayload,
    descriptionHtml: sessionDescriptionHtml,
  };

  const recommended: Channel = {
    id: LINKEDIN_SESSION_RECOMMENDED_ID,
    family: "linkedin",
    kind: "session",
    usesQueries: false,
    isConfigured: configured,
    async isDue({ kind, now, dryRun }) {
      if (!configured()) return false;
      if (dryRun || kind === "manual") return true;
      const schedule = deps.recommendedSchedule();
      if (!schedule.enabled) return false;
      const slot = latestSlotAtOrBefore(schedule.cron, schedule.timezone, now);
      if (slot === null) return false;
      const last = await deps.store().lastRecommendedAt();
      return last === null || last.getTime() < slot.getTime();
    },
    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const settings = readSessionSettings(ctx.settings.extra);
      const found = await browse(deps, ctx, settings, {
        source: "recommended",
        pieces: 1,
        listUrl: (_piece, start) => recommendedUrl(settings, start),
        limit: Math.min(query.maxResults, settings.recommended_max_results),
      });
      if (ctx.cycle.id !== null) await deps.store().markRecommended();
      return found;
    },
    parse: parseSessionPayload,
    descriptionHtml: sessionDescriptionHtml,
  };

  return { session, recommended };
}
