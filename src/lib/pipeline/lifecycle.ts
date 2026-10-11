import type { ChannelLogger, HttpClient } from "@/lib/channels/types";
import type { PipelineConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { listJobSources } from "@/lib/db/repos/job-sources";
import { listJobsForLinkCheck, listWatchedJobsForRecheck, markJobsPossiblyClosed, recordLinkCheck, recordWatchedCheck, touchJobsSeen } from "@/lib/db/repos/jobs";
import type { HostResolver, UrlGuard } from "@/lib/net/public-url";
import type { SleepFn } from "@/lib/channels/http";

import { checkLink, combineLinkStatuses, type LinkStatus } from "./link-check";
import { compilePhrases, createWatchedChecker } from "./recheck";

/** What the recheck of watched jobs did this run. */
export interface WatchedRecheckResult {
  checked: number;
  /** 404 / 410: closed. */
  closed: number;
  /** A "no longer accepting" phrase: possibly closed (the user confirms). */
  possiblyClosed: number;
  alive: number;
  /** robots.txt forbids the page: not fetched. */
  robots: number;
  /** No answer, an error status or a timeout: nothing changed. */
  unknown: number;
}

export interface MaintenanceResult {
  /** Jobs whose `last_seen_at` moved forward because a source returned them again. */
  seen: number;
  /** Of those, jobs that were possibly_closed / closed and are active again. */
  reopened: number;
  /** Active jobs no source returned for `possibly_closed_after_days` days. */
  possiblyClosed: number;
  linkChecked: number;
  /** Link checks that found the posting gone (404 / 410): the job is now `closed`. */
  closed: number;
  /** Link checks that found the posting still online: the job is `active` again. */
  alive: number;
  /** The recheck of watched jobs; null when it is off. */
  watched: WatchedRecheckResult | null;
  aborted: boolean;
}

export interface MaintenanceOptions {
  config: PipelineConfig;
  http: HttpClient;
  logger: ChannelLogger;
  signal?: AbortSignal;
  now: () => Date;
  /** Resolves host names for the link check's public-address rule (default: the system resolver; tests inject one). */
  resolveHost?: HostResolver;
  /** Replaces the whole public-address check of the link check and the recheck (tests against a local server); wins over `resolveHost`. */
  urlGuard?: UrlGuard;
  /**
   * The recheck of watched jobs (`ui.yaml: job_checks.closed_recheck`): on / off and the user's extra phrases (added to the
   * packs' `closed_posting.phrases`). Absent = off.
   */
  watched?: { enabled: boolean; extraPhrases: readonly string[] };
  /** Wait of the per-host throttle (injected for tests). */
  sleep?: SleepFn;
  /** Milliseconds clock of the per-host throttle (injected for tests). */
  clock?: () => number;
}

/**
 * The `maintenance` step: refresh `last_seen_at` from what the channels returned, mark jobs nobody
 * returns any more as `possibly_closed`, then check the links of at most
 * `lifecycle.max_link_checks_per_cycle` possibly_closed jobs (404 / 410 → `closed`). Jobs are only
 * ever updated, never deleted, so jobs with an application keep their history.
 */
export async function runMaintenance(db: Db, options: MaintenanceOptions): Promise<MaintenanceResult> {
  const { config, http, logger, signal } = options;
  const now = options.now();
  const watchedOn = options.watched?.enabled === true;
  const userAgent = config.lifecycle.watch_recheck.user_agent;
  const result: MaintenanceResult = { seen: 0, reopened: 0, possiblyClosed: 0, linkChecked: 0, closed: 0, alive: 0, watched: null, aborted: false };

  const touched = await touchJobsSeen(db);
  result.seen = touched.seen;
  result.reopened = touched.reopened;

  const overdue = await markJobsPossiblyClosed(db, { now, days: config.lifecycle.possibly_closed_after_days });
  result.possiblyClosed = overdue.length;
  if (overdue.length > 0) logger.info("jobs marked possibly_closed", { count: overdue.length });

  let skipped = 0;
  // watched jobs are left to their own recheck below (one request per posting, robots.txt obeyed)
  const candidates = await listJobsForLinkCheck(db, config.lifecycle.max_link_checks_per_cycle, { skipWatched: watchedOn });
  for (const job of candidates) {
    if (signal?.aborted) {
      result.aborted = true;
      break;
    }
    const urls = [
      ...new Set(
        (await listJobSources(db, job.id)).flatMap((source) => {
          const url = source.url ?? source.applyUrl;
          return url === null ? [] : [url];
        }),
      ),
    ];
    const statuses: LinkStatus[] = [];
    for (const url of urls) {
      const status = await checkLink(http, url, { ...(options.resolveHost ? { resolve: options.resolveHost } : {}), ...(options.urlGuard ? { guard: options.urlGuard } : {}), onBlocked: () => (skipped += 1), userAgent, timeoutMs: options.config.lifecycle.link_check_timeout_ms });
      statuses.push(status);
      if (status === "alive") break;
    }
    const outcome = combineLinkStatuses(statuses);
    await recordLinkCheck(db, job.id, { outcome, at: options.now() });
    result.linkChecked += 1;
    if (outcome === "gone") result.closed += 1;
    if (outcome === "alive") result.alive += 1;
  }
  // One line per cycle: a posting whose link points at a private or internal address is never requested.
  if (skipped > 0) logger.warn(`${skipped} link checks skipped (non-public address)`, { skipped });
  if (result.linkChecked > 0) logger.info("possibly_closed links checked", { checked: result.linkChecked, closed: result.closed, alive: result.alive });

  if (watchedOn && !result.aborted && options.watched) {
    const { aborted, ...watched } = await recheckWatchedJobs(db, options, options.watched.extraPhrases);
    result.watched = watched;
    if (aborted) result.aborted = true;
  }
  return result;
}

/** Recheck the postings of watched jobs (at most `max_per_cycle`, each at most once in `interval_hours`). */
async function recheckWatchedJobs(db: Db, options: MaintenanceOptions, extraPhrases: readonly string[]): Promise<WatchedRecheckResult & { aborted: boolean }> {
  const { config, http, logger, signal } = options;
  const settings = config.lifecycle.watch_recheck;
  const now = options.now();
  const out = { checked: 0, closed: 0, possiblyClosed: 0, alive: 0, robots: 0, unknown: 0, aborted: false };
  const jobs = await listWatchedJobsForRecheck(db, { limit: settings.max_per_cycle, olderThan: new Date(now.getTime() - settings.interval_hours * 3_600_000) });
  if (jobs.length === 0) return out;
  const checker = createWatchedChecker(
    {
      userAgent: settings.user_agent,
      timeoutMs: settings.timeout_ms,
      maxBodyBytes: settings.max_body_bytes,
      perHostMinIntervalMs: settings.per_host_min_interval_ms,
      phrases: compilePhrases([...config.closed_posting.phrases, ...extraPhrases]),
    },
    {
      http,
      ...(signal ? { signal } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.resolveHost ? { resolve: options.resolveHost } : {}),
      ...(options.urlGuard ? { guard: options.urlGuard } : {}),
    },
  );
  for (const job of jobs) {
    if (signal?.aborted) {
      out.aborted = true;
      break;
    }
    const urls = [
      ...new Set(
        (await listJobSources(db, job.id)).flatMap((source) => {
          const url = source.url ?? source.applyUrl;
          return url === null ? [] : [url];
        }),
      ),
    ];
    let check;
    try {
      check = await checker.checkJob(urls);
    } catch (error) {
      if (signal?.aborted) {
        out.aborted = true;
        break;
      }
      // one broken page must not stop the maintenance step: the job counts as checked without an answer (`unknown`)
      logger.warn("watched posting recheck failed", { jobId: job.id, error: error instanceof Error ? error.name : "unknown" });
      check = null;
    }
    const at = options.now();
    const evidence = check
      ? { outcome: check.outcome, httpStatus: check.httpStatus, phrase: check.phrase, quote: check.quote, url: check.url, at: at.toISOString() }
      : { outcome: "unknown" as const, httpStatus: null, phrase: null, quote: null, url: null, at: at.toISOString() };
    await recordWatchedCheck(db, job.id, evidence, at);
    out.checked += 1;
    if (evidence.outcome === "gone") out.closed += 1;
    else if (evidence.outcome === "phrase") out.possiblyClosed += 1;
    else if (evidence.outcome === "alive") out.alive += 1;
    else if (evidence.outcome === "robots") out.robots += 1;
    else out.unknown += 1;
  }
  logger.info("watched postings rechecked", { checked: out.checked, closed: out.closed, possiblyClosed: out.possiblyClosed, alive: out.alive, robots: out.robots, unknown: out.unknown });
  return out;
}
