import { BudgetExceededError, ChannelError } from "../../errors";
import type { SleepFn } from "../../http";
import { marketForChannel } from "../../market";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../../types";
import { postedDateEvidence } from "../date-window";
import { BrightDataClient } from "./client";
import {
  BRIGHTDATA_API_KEY_ENV,
  MAX_LIMIT_PER_INPUT,
  brightDataSettingsSchema,
  buildDiscoveryInputs,
  isProviderErrorRecord,
  timeRangeFor,
  type BrightDataSettings,
} from "./contract";
import { brightDataDescriptionHtml, parseBrightDataJob, postedAtOf } from "./parse";

export const LINKEDIN_BRIGHTDATA_ID = "linkedin-brightdata";

export interface BrightDataChannelOptions {
  /** USD per 1000 records beyond the free allowance. A getter so a config reload changes the price without re-registering. */
  costPer1kUsd: () => number;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  sleep?: SleepFn;
  /** Milliseconds clock for the snapshot timeout (tests). */
  clock?: () => number;
  /** API origin override (tests). */
  origin?: string;
}

function readSettings(ctx: ChannelContext): BrightDataSettings {
  const parsed = brightDataSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join("."));
    throw new ChannelError("unknown", `sources.yaml linkedin.brightdata is incomplete (${paths.join(", ")})`, { retryable: false });
  }
  return parsed.data;
}

/**
 * How many records one trigger may ask for, so that the snapshot can never exceed what the budget
 * still covers: the free allowance first, then what the remaining USD buys at `cost_per_1k_usd`.
 */
export function affordableRecords(snapshot: { freeRecordsLeft: number; usdLeft: number }, costPer1kUsd: number): number {
  if (costPer1kUsd <= 0) return Number.POSITIVE_INFINITY;
  return snapshot.freeRecordsLeft + Math.floor((snapshot.usdLeft / costPer1kUsd) * 1000 + 1e-9);
}

/**
 * `linkedin-brightdata`: LinkedIn jobs through Bright Data's Web Scraper API (first in the LinkedIn
 * cascade). One query = one trigger (keywords OR-merged, one city or the remote location).
 * Usage is recorded from the number of records the snapshot delivered (all of them are billed,
 * including duplicates and records the local time window drops; the dropped ones are not persisted as raw postings). With no
 * budget left the channel raises `BudgetExceededError` before spending anything, and the cascade moves on.
 */
export function createBrightDataChannel(options: BrightDataChannelOptions): Channel {
  const now = options.now ?? (() => new Date());

  return {
    id: LINKEDIN_BRIGHTDATA_ID,
    family: "linkedin",
    kind: "paid",
    usesQueries: true,
    supportsCompanyQueries: true,
    // Billed per record with coarse date ranges and no newest-first order: stretching would mostly buy old postings.
    // Return true only after exact second-level requests and newest-first results under current settings have been measured.
    supportsCatchUp: () => false,
    estimateCost: (paidRecords) => (paidRecords * options.costPer1kUsd()) / 1000,
    // no API key: "not configured", skipped by the cascade without a request, a failed run or a breaker strike
    isConfigured: () => ((options.environment ?? process.env)[BRIGHTDATA_API_KEY_ENV] ?? "").trim() !== "",

    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const settings = readSettings(ctx);
      const env = options.environment ?? process.env;
      const apiKey = env[BRIGHTDATA_API_KEY_ENV]?.trim();
      if (!apiKey) throw new ChannelError("auth_expired", `${BRIGHTDATA_API_KEY_ENV} is not set`);

      const inputs = buildDiscoveryInputs(query, settings, marketForChannel());
      const affordable = affordableRecords(ctx.budget.snapshot(), settings.cost_per_1k_usd);
      const limitPerInput = Math.min(
        MAX_LIMIT_PER_INPUT,
        Math.max(1, Math.floor(Math.min(query.maxResults, affordable) / inputs.length)),
      );
      if (Math.min(query.maxResults, affordable) < inputs.length) {
        throw new BudgetExceededError("channel", `${LINKEDIN_BRIGHTDATA_ID}: budget leaves room for fewer records than inputs`);
      }

      const client = new BrightDataClient({
        ctx,
        apiKey,
        datasetId: settings.dataset_id,
        pollIntervalMs: settings.poll_interval_ms,
        timeoutMs: settings.timeout_ms,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.clock ? { now: options.clock } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      });
      const snapshot = await client.run(inputs, limitPerInput);

      // Every non-error record was billed, whatever happens to it below.
      const providerErrors = snapshot.items.filter(isProviderErrorRecord).length;
      const delivered: { record: Record<string, unknown>; ordinal: number | undefined }[] = [];
      for (const [itemIndex, item] of snapshot.items.entries()) {
        const ordinal = snapshot.ordinals[itemIndex];
        const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : null;
        const providerError = isProviderErrorRecord(item);
        if (record === null || providerError) {
          const id = record?.job_posting_id;
          const externalId = typeof id === "string" || typeof id === "number" ? String(id).trim() || null : null;
          if (ordinal !== undefined) ctx.deliveries.drop(ordinal, providerError ? "provider_error" : "no_identity", { externalId });
          continue;
        }
        delivered.push({ record, ordinal });
      }
      // Billed usage is never dropped: a snapshot bigger than the budget (the provider ignored the limit) is recorded in
      // full; the channel then has no headroom left and the cascade moves on for the following queries.
      const usage = await ctx.budget.consume(delivered.length, { allowOverspend: true });
      const left = ctx.budget.snapshot();
      if (left.freeRecordsLeft === 0 && left.usdLeft <= 0) {
        ctx.logger.warn("bright data budget exhausted by this snapshot", { records: delivered.length, usd: usage.usd });
      }
      ctx.logger.info("bright data snapshot downloaded", {
        records: delivered.length,
        providerErrors,
        freeRecords: usage.freeRecords,
        paidRecords: usage.paidRecords,
        usd: usage.usd,
        ...(ctx.cycle.id === null
          ? { dryRun: true, note: "dry run: the provider billed these records, but they are neither stored nor added to the persisted monthly usage" }
          : {}),
      });

      // Local time window for ranges shorter than the provider's discrete one.
      const { rangeHours } = timeRangeFor(query.windowHours);
      const cutoff = query.windowHours < rangeHours ? now().getTime() - query.windowHours * 3_600_000 : null;
      ctx.deliveries.setWindowCutoff(cutoff);

      const seen = new Set<string>();
      const out: RawPostingInput[] = [];
      let outsideWindow = 0;
      let noIdentity = 0;
      for (const { record, ordinal } of delivered) {
        const postedDate = typeof record.job_posted_date === "string" ? record.job_posted_date : null;
        const postedAt = postedAtOf(postedDate);
        const { end, flags } = postedDateEvidence(postedDate, postedAt);
        if (ordinal !== undefined) ctx.deliveries.flag(ordinal, flags);
        const id = record.job_posting_id;
        const externalId = typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
        if (externalId === "") {
          noIdentity += 1;
          if (ordinal !== undefined) ctx.deliveries.drop(ordinal, "no_identity", { externalId: null });
          continue;
        }
        if (seen.has(externalId)) {
          if (ordinal !== undefined) ctx.deliveries.drop(ordinal, "duplicate_in_run", { externalId });
          continue;
        }
        seen.add(externalId);
        if (cutoff !== null && end !== null && end < cutoff) {
          outsideWindow += 1;
          if (ordinal !== undefined) ctx.deliveries.drop(ordinal, "outside_window", { externalId });
          continue;
        }
        out.push({ externalId, url: typeof record.url === "string" ? record.url : null, payload: record, postedAt,
          ...(ordinal === undefined ? {} : { deliveryOrdinal: ordinal }) });
      }
      if (outsideWindow > 0 || noIdentity > 0) {
        ctx.logger.info("bright data records not stored", { outsideWindow, noIdentity });
      }
      return out;
    },

    parse: parseBrightDataJob,
    descriptionHtml: brightDataDescriptionHtml,
  };
}
