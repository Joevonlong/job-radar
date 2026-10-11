/**
 * The recheck of watched jobs (starred, or an application the user follows). Each link is fetched like a careful reader: our
 * own User-Agent, robots.txt obeyed, one request per host every `per_host_min_interval_ms`, a body read up to `max_body_bytes`.
 * The page is untrusted data (C6): it is parsed, never run, and only its visible text is searched. A 404 / 410 means the posting is
 * gone; a "no longer accepting applications" phrase in the visible text only marks it possibly closed (the user confirms), with the
 * phrase and a short quote kept as evidence (C3).
 */
import * as cheerio from "cheerio";

import { ChannelError } from "@/lib/channels/errors";
import { unsafePhraseReason } from "@/lib/config/schemas/common";
import { defaultSleep, readTextUpTo, type SleepFn } from "@/lib/channels/http";
import type { HttpClient, HttpResponse } from "@/lib/channels/types";
import type { LinkCheckEvidence } from "@/lib/jobs/link-check-evidence";
import { publicUrlGuard, requestPublicUrl, type HostResolver, type UrlGuard } from "@/lib/net/public-url";
import { parseStyle } from "@/lib/traps/css";
import { NON_RENDERED_TAGS } from "@/lib/traps/types";

import { ALLOW_ALL, DISALLOW_ALL, MAX_ROBOTS_BYTES, parseRobots, type RobotsPolicy } from "./robots";

export type { LinkCheckEvidence };
/** What one check found (stored in `jobs.link_check_json` as `LinkCheckEvidence`, shown as the evidence of the closed tag). */
export type WatchedOutcome = LinkCheckEvidence["outcome"];

export interface PageCheck {
  outcome: WatchedOutcome;
  httpStatus: number | null;
  phrase: string | null;
  quote: string | null;
  url: string;
}

/** Most characters of visible text searched for the phrases (the user's own regexes run on it). */
export const MAX_SEARCHED_CHARS = 200_000;
/** Time budget of the phrase search on one page; when it runs out before a match the page counts as not checked (`unknown`). */
export const PHRASE_BUDGET_MS = 250;
/** Longest quote kept as evidence. */
export const QUOTE_MAX = 200;
/** Characters of context on each side of the matched phrase. */
const QUOTE_CONTEXT = 80;
const GONE_STATUSES: readonly number[] = [404, 410];
/** Elements that are not the posting: navigation, sidebars ("other jobs: no longer available"), footers. */
const NOT_THE_POSTING = ["aside", "nav", "footer", '[role="complementary"]', '[role="navigation"]', '[role="contentinfo"]'];

/**
 * The case-insensitive Unicode regexes of the phrases. Invalid or unsafe ones (`unsafePhraseReason`) were rejected by the config
 * check; any that still arrive are skipped here, so no phrase can backtrack catastrophically on a page.
 */
export function compilePhrases(sources: readonly string[]): RegExp[] {
  return [...new Set(sources)].flatMap((source) => {
    if (unsafePhraseReason(source) !== null) return [];
    try {
      return [new RegExp(source, "iu")];
    } catch {
      return [];
    }
  });
}

function hiddenByMarkup(attribs: Record<string, string>): boolean {
  if ("hidden" in attribs) return true;
  if ((attribs["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  if ((attribs.type ?? "").toLowerCase() === "hidden") return true;
  const style = parseStyle(attribs.style);
  const display = (style.get("display") ?? "").toLowerCase();
  const visibility = (style.get("visibility") ?? "").toLowerCase();
  const opacity = style.get("opacity");
  return display === "none" || visibility === "hidden" || visibility === "collapse" || (opacity !== undefined && Number.parseFloat(opacity) === 0);
}

/** The text a reader sees: no scripts, styles, templates, hidden elements, navigation, sidebars or footers; spaces squeezed. */
export function visiblePageText(html: string): string {
  const $ = cheerio.load(html);
  $([...NON_RENDERED_TAGS, "head", "svg", "iframe", ...NOT_THE_POSTING].join(",")).remove();
  $("*").each((_, el) => {
    if (el.type === "tag" && hiddenByMarkup(el.attribs)) $(el).remove();
  });
  // block elements end a line, so words of two elements never run together
  $("br, p, div, li, h1, h2, h3, h4, h5, h6, section, article, tr, td, th").after(" ");
  return $("body").text().replace(/[\s ]+/gu, " ").trim() || $.root().text().replace(/[\s ]+/gu, " ").trim();
}

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - QUOTE_CONTEXT);
  const end = Math.min(text.length, index + length + QUOTE_CONTEXT);
  const quote = `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
  return quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX - 1)}…` : quote;
}

/**
 * One page: 404 / 410 → gone; 2xx / 3xx → phrase (a phrase in the first MAX_SEARCHED_CHARS of the visible text) or alive; anything
 * else, or a phrase search that ran out of its time budget, → unknown.
 */
export function classifyPage(status: number, html: string, phrases: readonly RegExp[], clock: () => number = () => performance.now()): Omit<PageCheck, "url"> {
  if (GONE_STATUSES.includes(status)) return { outcome: "gone", httpStatus: status, phrase: null, quote: null };
  if (status >= 400) return { outcome: "unknown", httpStatus: status, phrase: null, quote: null };
  const text = visiblePageText(html).slice(0, MAX_SEARCHED_CHARS);
  const started = clock();
  for (const phrase of phrases) {
    // the budget is checked between phrases (a single regex cannot be interrupted; the text cap bounds each one)
    if (clock() - started > PHRASE_BUDGET_MS) return { outcome: "unknown", httpStatus: status, phrase: null, quote: null };
    const match = phrase.exec(text);
    if (match) return { outcome: "phrase", httpStatus: status, phrase: phrase.source, quote: quoteAround(text, match.index, match[0].length) };
  }
  return { outcome: "alive", httpStatus: status, phrase: null, quote: null };
}

/**
 * The links of one job together: any live link keeps it open; all gone closes it; all gone or phrase with at least one phrase marks it
 * possibly closed; links robots.txt forbids all = robots; anything else is unknown (nothing changes).
 */
export function combineChecks(checks: readonly PageCheck[]): PageCheck | null {
  if (checks.length === 0) return null;
  const alive = checks.find((c) => c.outcome === "alive");
  if (alive) return alive;
  if (checks.every((c) => c.outcome === "gone")) return checks[0]!;
  if (checks.every((c) => c.outcome === "gone" || c.outcome === "phrase")) return checks.find((c) => c.outcome === "phrase")!;
  if (checks.every((c) => c.outcome === "robots")) return checks[0]!;
  return checks.find((c) => c.outcome === "unknown") ?? checks[0]!;
}

export interface RecheckSettings {
  userAgent: string;
  timeoutMs: number;
  maxBodyBytes: number;
  perHostMinIntervalMs: number;
  phrases: readonly RegExp[];
}

export interface RecheckDeps {
  http: HttpClient;
  signal?: AbortSignal;
  sleep?: SleepFn;
  /** Milliseconds clock (injected for tests). */
  clock?: () => number;
  /** Resolves host names for the public-address check of every hop (default: the system resolver). */
  resolve?: HostResolver;
  /** Replaces the whole public-address check (tests against a local server); wins over `resolve`. */
  guard?: UrlGuard;
}

type HopStop = "robots" | "unknown";

/**
 * The fetcher of one maintenance run: the per-host throttle and the robots.txt answers live as long as it (one cycle). Every request
 * (robots.txt and the page, each redirect hop) goes through `requestPublicUrl`: only public http(s) addresses, redirects followed by
 * hand (at most 5), and a hop on another host is fetched only when that host's robots.txt allows it. A robots.txt that answers 4xx
 * allows everything; 5xx, a refused address, a timeout or a network error skips the host for this run (outcome `unknown`).
 */
export function createWatchedChecker(settings: RecheckSettings, deps: RecheckDeps) {
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.clock ?? (() => Date.now());
  const guard = deps.guard ?? publicUrlGuard(deps.resolve);
  const lastRequest = new Map<string, number>();
  const robots = new Map<string, Promise<RobotsPolicy | null>>();
  const headers = { "user-agent": settings.userAgent };

  async function throttle(host: string): Promise<void> {
    const last = lastRequest.get(host);
    if (last !== undefined) {
      const wait = last + settings.perHostMinIntervalMs - clock();
      if (wait > 0) await sleep(wait, deps.signal);
    }
    lastRequest.set(host, clock());
  }

  const readBody = (response: HttpResponse, maxBytes: number) => (response.textUpTo ? response.textUpTo(maxBytes) : readTextUpTo(response, maxBytes));

  async function loadRobots(origin: string): Promise<RobotsPolicy | null> {
    try {
      const result = await requestPublicUrl(deps.http, `${origin}/robots.txt`, {
        method: "GET",
        headers,
        timeoutMs: settings.timeoutMs,
        guard,
        ...(deps.signal ? { signal: deps.signal } : {}),
        beforeHop: async (hop) => {
          await throttle(new URL(hop).host);
          return null;
        },
      });
      if (result.kind !== "response") return null;
      const { response } = result;
      const { text } = await readBody(response, MAX_ROBOTS_BYTES);
      if (response.status >= 500) return null;
      // RFC 9309: "unavailable" (4xx) means no rules; 401 / 403 are treated the same way here (we fetch a single public page)
      if (response.status >= 400) return ALLOW_ALL;
      return parseRobots(text, settings.userAgent);
    } catch (error) {
      if (!(error instanceof ChannelError)) throw error;
      return null;
    }
  }

  /** The robots.txt policy of the URL's origin (scheme, host and port), asked once per run; a cancelled load is not kept. */
  function policyFor(url: URL): Promise<RobotsPolicy | null> {
    let policy = robots.get(url.origin);
    if (!policy) {
      policy = loadRobots(url.origin);
      robots.set(url.origin, policy);
      policy.catch(() => robots.delete(url.origin));
    }
    return policy;
  }

  /** Before each hop of the page request: robots.txt of that hop's host, then the per-host gap. */
  async function beforePageHop(hop: string): Promise<HopStop | null> {
    const url = new URL(hop);
    const policy = await policyFor(url);
    if (policy === null) return "unknown";
    if (policy === DISALLOW_ALL || !policy.allows(`${url.pathname}${url.search}`)) return "robots";
    await throttle(url.host);
    return null;
  }

  /** Check one link. */
  async function checkPage(link: string): Promise<PageCheck> {
    const none = { httpStatus: null, phrase: null, quote: null, url: link };
    try {
      const result = await requestPublicUrl<HopStop>(deps.http, link, {
        method: "GET",
        headers,
        timeoutMs: settings.timeoutMs,
        guard,
        ...(deps.signal ? { signal: deps.signal } : {}),
        beforeHop: beforePageHop,
      });
      if (result.kind === "refused") return { outcome: "unknown", ...none };
      if (result.kind === "stopped") return { outcome: result.stop, ...none };
      const { text } = await readBody(result.response, settings.maxBodyBytes);
      return { ...classifyPage(result.response.status, text, settings.phrases), url: link };
    } catch (error) {
      if (!(error instanceof ChannelError)) throw error;
      return { outcome: "unknown", ...none };
    }
  }

  /** Check the links of one job (stopping at the first live one) and combine them. */
  async function checkJob(links: readonly string[]): Promise<PageCheck | null> {
    const checks: PageCheck[] = [];
    for (const link of links) {
      deps.signal?.throwIfAborted();
      const check = await checkPage(link);
      checks.push(check);
      if (check.outcome === "alive") break;
    }
    return combineChecks(checks);
  }

  return { checkPage, checkJob };
}
