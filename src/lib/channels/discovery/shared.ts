import { createHash } from "node:crypto";

import { assertCredentialEndpoint } from "@/lib/channels/credential-endpoint";
import { ChannelError, isAbortError } from "@/lib/channels/errors";
import { orderQueries } from "@/lib/channels/rotation";
import type { Channel, ChannelContext, NormalizedPostingDraft, RawPostingInput, SearchQuery } from "@/lib/channels/types";
import type { CompaniesConfig, SearchConfig } from "@/lib/config";
import type { CredentialService } from "@/lib/credential-endpoints";

import { boardFromUrl, boardKey, type DiscoverableAts } from "./boards";
import type { DiscoveryStore } from "./store";

/**
 * What the discovery channels (`brave`, `tavily`) share: the candidate bookkeeping and the search loop.
 * A provider only supplies its queries, the one HTTP call, and its credentials. Discovery collects no
 * postings: each run searches for career-board URLs of the five ATS, keeps the official ones that are
 * not in `sources.yaml (ats_boards)`, and writes them to the candidate table, where `/sources` lists them.
 * When queries exceed the cap, `orderQueries` serves the longest-waiting first; cancellation before
 * writing leaves candidates, turns and the run marker untouched.
 */

export interface DiscoveryQuery {
  /** Stable while ATS, group, city, query text and domains are unchanged, regardless of config order. */
  id: string;
  ats: DiscoverableAts;
  group: string;
  city: string;
  /** The query string sent to the provider. */
  q: string;
  /** Hosts the search is restricted to, for providers that filter by domain instead of `site:` (Tavily). */
  domains?: string[];
}

export function discoveryQueryId(parts: { ats: DiscoverableAts; group: string; city: string; q: string; domains?: readonly string[] }): string {
  const canonical = JSON.stringify([parts.ats, parts.group, parts.city, parts.q, parts.domains ?? []]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Keep current queries' previous turns, set this run's turns to `now`, and drop queries no longer built. */
export function mergeTurns(all: readonly DiscoveryQuery[], previous: ReadonlyMap<string, Date>, turned: readonly string[], now: Date): Map<string, Date> {
  const next = new Map<string, Date>();
  const current = new Set(turned);
  for (const query of all) {
    const at = current.has(query.id) ? now : previous.get(query.id);
    if (at !== undefined) next.set(query.id, at);
  }
  return next;
}

export interface DiscoveredBoard {
  ats: DiscoverableAts;
  token: string;
  region: "eu" | null;
  boardUrl: string;
  title: string | null;
}

/** One search hit, whatever the provider calls its fields. */
export interface SearchHit {
  url: string;
  title?: string | null | undefined;
}

/** The career page of a board (what the user can open to look at the company). */
export function boardUrlOf(ats: DiscoverableAts, token: string, region: "eu" | null): string {
  const path = encodeURIComponent(token);
  switch (ats) {
    case "greenhouse":
      return `https://boards.greenhouse.io/${path}`;
    case "lever":
      return `https://${region === "eu" ? "jobs.eu.lever.co" : "jobs.lever.co"}/${path}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${path}`;
    case "personio":
      return `https://${path}.jobs.personio.de`;
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${path}`;
  }
}

/** The new boards among `hits`: official URLs only, not in `known`, once per board. */
export function boardsFromHits(hits: readonly SearchHit[], known: ReadonlySet<string>): DiscoveredBoard[] {
  const found = new Map<string, DiscoveredBoard>();
  for (const hit of hits) {
    const board = boardFromUrl(hit.url);
    if (!board) continue;
    const key = boardKey(board.ats, board.token);
    if (known.has(key) || found.has(key)) continue;
    found.set(key, { ...board, boardUrl: boardUrlOf(board.ats, board.token, board.region), title: hit.title?.trim() || null });
  }
  return [...found.values()];
}

/** Dependencies both discovery channels take. */
export interface DiscoveryDeps {
  /** Live config read on every run, including sources.yaml collect.query_rotation, not the cycle's frozen config. */
  inputs(): { search: SearchConfig; companies: CompaniesConfig; queryRotation: boolean };
  /** Candidate storage; only asked for in real runs. */
  store(): DiscoveryStore;
  /** Environment holding the API key (read at collect time, never logged). */
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

/** Settings every discovery channel has. */
export interface DiscoverySettings {
  interval_hours: number;
  max_queries_per_run: number;
}

export interface DiscoveryProvider<S extends DiscoverySettings> {
  id: string;
  /** Environment variable holding the API key. */
  keyEnv: string;
  /** The channel's validated sources.yaml block; throws a ChannelError when it is unusable. */
  settingsOf(ctx: ChannelContext): S;
  buildQueries(search: SearchConfig, settings: S): DiscoveryQuery[];
  /** The service and base URL the key is sent to (checked once per run, see `assertCredentialEndpoint`). */
  endpoint(settings: S): { service: Exclude<CredentialService, "gmail">; url: string };
  /** Run one search; throw a classified ChannelError on failure. May throw BudgetExceededError before sending. */
  search(query: DiscoveryQuery, apiKey: string, settings: S, ctx: ChannelContext): Promise<SearchHit[]>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export function createDiscoveryChannel<S extends DiscoverySettings>(provider: DiscoveryProvider<S>, deps: DiscoveryDeps, extra: Partial<Channel> = {}): Channel {
  return {
    id: provider.id,
    family: "ats",
    kind: "api",
    usesQueries: false,
    ...extra,
    async collect(_query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const env = deps.environment ?? process.env;
      const apiKey = env[provider.keyEnv]?.trim();
      if (!apiKey) {
        ctx.logger.info(`${provider.id} discovery is not configured`, { env: provider.keyEnv });
        return [];
      }
      const settings = provider.settingsOf(ctx);
      const endpoint = provider.endpoint(settings);
      assertCredentialEndpoint(endpoint.service, endpoint.url, ctx, env);
      const now = (deps.now ?? (() => new Date()))();
      // dry runs (no cycle id) write nothing, so they neither read nor update the run marker
      const store = ctx.cycle.id === null ? null : deps.store();
      if (store) {
        const last = await store.lastRunAt();
        if (last && now.getTime() - last.getTime() < settings.interval_hours * 3_600_000) {
          ctx.logger.info(`${provider.id} discovery ran recently; skipped`, { lastRunAt: last.toISOString(), intervalHours: settings.interval_hours });
          return [];
        }
      }

      const inputs = deps.inputs();
      const known = new Set(inputs.companies.companies.map((c) => boardKey(c.ats, c.token)));
      const all = provider.buildQueries(inputs.search, settings);
      let previous = new Map<string, Date>();
      let turnsReadable = store !== null;
      if (store) {
        try {
          previous = await store.lastTurns();
        } catch (error) {
          turnsReadable = false;
          ctx.logger.warn(`${provider.id} discovery turns could not be read; using config order`, { error: errorMessage(error) });
        }
      }
      const rotate = turnsReadable && inputs.queryRotation;
      const turnsMap = new Map(all.map((q) => [q.id, previous.get(q.id) ?? null]));
      const queries = orderQueries(all, turnsMap, rotate).slice(0, settings.max_queries_per_run);
      const found = new Map<string, DiscoveredBoard>();
      const failures: ChannelError[] = [];
      const turned: string[] = [];
      let fatal: ChannelError | null = null;
      for (const [index, query] of queries.entries()) {
        ctx.signal.throwIfAborted();
        if (index > 0) await ctx.throttle();
        try {
          const hits = await provider.search(query, apiKey, settings, ctx);
          turned.push(query.id);
          for (const board of boardsFromHits(hits, known)) {
            const key = boardKey(board.ats, board.token);
            if (!found.has(key)) found.set(key, board);
          }
        } catch (error) {
          if (isAbortError(error) || ctx.signal.aborted) throw error;
          const failure = error instanceof ChannelError ? error : new ChannelError("unknown", errorMessage(error).slice(0, 300), { cause: error });
          if (failure.code !== "budget_exceeded") turned.push(query.id);
          // a rejected key or an exhausted quota / budget fails every following search the same way: stop, keep what was found
          if (failure.code === "auth_expired" || failure.code === "blocked" || failure.code === "rate_limited" || failure.code === "budget_exceeded") {
            fatal = failure;
            break;
          }
          ctx.logger.warn(`${provider.id} search failed`, { ats: query.ats, group: query.group, city: query.city, code: failure.code });
          failures.push(failure);
        }
      }
      ctx.signal.throwIfAborted();
      const next = mergeTurns(all, previous, turned, now);
      const saveTurns = async (): Promise<boolean> => {
        if (!store || !turnsReadable) return false;
        try {
          await store.saveTurns(next);
          return true;
        } catch (error) {
          ctx.logger.warn(`${provider.id} discovery turns could not be saved`, { error: errorMessage(error) });
          return false;
        }
      };
      let turnsSaved = false;
      const [first] = failures;
      if (!fatal && first && failures.length === queries.length) {
        await saveTurns();
        throw first;
      }

      const boards = [...found.values()];
      let added = 0;
      if (store) {
        added = await store.upsert(boards.map((b) => ({ ats: b.ats, token: b.token, region: b.region, boardUrl: b.boardUrl, title: b.title })));
        turnsSaved = await saveTurns();
        // a run that stopped early is not a finished run: the next cycle tries again
        if (!fatal) await store.markRun();
      } else {
        ctx.logger.info(`${provider.id} discovery dry run: candidates`, { boards: boards.map((b) => `${b.ats}:${b.token}`) });
      }
      ctx.logger.info(`${provider.id} discovery done`, {
        searches: queries.length,
        failedSearches: failures.length,
        candidates: boards.length,
        newCandidates: store ? added : null,
        queries: all.length,
        capped: all.length - queries.length,
        neverRun: turnsSaved ? all.filter((q) => !next.has(q.id)).length : null,
        rotation: rotate,
      });
      if (fatal) throw fatal;
      return [];
    },
    parse(): NormalizedPostingDraft {
      throw new ChannelError("parse", `${provider.id} discovers boards; it stores no postings`);
    },
  };
}
