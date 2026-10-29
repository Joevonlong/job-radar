import { BudgetExceededError, ChannelError, InfrastructureError, isAbortError } from "../../errors";
import { marketForChannel } from "../../market";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../../types";
import { assertCredentialEndpoint } from "../../credential-endpoint";
import { affordableItems } from "../budget";
import { runActorSync } from "./client";
import {
  APIFY_TOKEN_ENV,
  apifySettingsSchema,
  buildActorInputs,
  dateRangeFor,
  isErrorItem,
  jobIdOfRecord,
  runSyncUrl,
  type ApifySettings,
} from "./contract";
import { apifyDescriptionHtml, parseApifyJob } from "./parse";
import { postedAtOf, postedBefore } from "./posted-date";

export const LINKEDIN_APIFY_ID = "linkedin-apify";

export { affordableItems } from "../budget";

const MS_PER_HOUR = 3_600_000;

export interface ApifyChannelOptions {
  /** `linkedin.apify.actor_id`. A getter so a config reload takes effect without re-registering; used for the "not configured" check. */
  actorId?: () => string;
  /** USD per 1000 dataset items. A getter for the same reason; used for the budget headroom estimate. */
  pricePer1kUsd: () => number;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  /** API origin override (tests). */
  origin?: string;
}

function readSettings(ctx: ChannelContext): ApifySettings {
  const parsed = apifySettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join("."));
    throw new ChannelError("unknown", `sources.yaml linkedin.apify is incomplete (${paths.join(", ")})`, { retryable: false });
  }
  return parsed.data;
}

/**
 * `linkedin-apify`: LinkedIn jobs through an Apify actor (second in the LinkedIn cascade). One query = one
 * synchronous actor run (keywords OR-merged, one city or the remote location; a keyword group too long for one
 * LinkedIn keyword field takes one run per piece). Without `APIFY_TOKEN` (or an actor id) the channel is "not
 * configured" and the cascade skips it without a failed run. Usage is recorded from the items the run delivered
 * (price per 1000 items plus the run's start fee, both from sources.yaml); with no budget left the channel raises
 * `BudgetExceededError` before spending anything, and the cascade moves on to the next channel.
 */
export function createApifyChannel(options: ApifyChannelOptions): Channel {
  const now = options.now ?? (() => new Date());
  const environment = (): Readonly<Record<string, string | undefined>> => options.environment ?? process.env;
  const tokenOf = (): string | undefined => environment()[APIFY_TOKEN_ENV]?.trim() || undefined;

  return {
    id: LINKEDIN_APIFY_ID,
    family: "linkedin",
    kind: "paid",
    usesQueries: true,
    // Billed per record with coarse date ranges and no newest-first order: stretching would mostly buy old postings.
    // Return true only after exact second-level requests and newest-first results under current settings have been measured.
    supportsCatchUp: () => false,
    estimateCost: (paidRecords) => (paidRecords * options.pricePer1kUsd()) / 1000,
    isConfigured: () => tokenOf() !== undefined && (options.actorId === undefined || options.actorId().trim() !== ""),

    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const settings = readSettings(ctx);
      const token = tokenOf();
      if (!token) throw new ChannelError("auth_expired", `${APIFY_TOKEN_ENV} is not set`);
      // the test origin override is not configuration; the configured base URL must be Apify's own host
      if (options.origin === undefined) assertCredentialEndpoint("apify", settings.api_base_url, ctx, environment());
      if (settings.actor_id === "") throw new ChannelError("unknown", "sources.yaml linkedin.apify.actor_id is empty", { retryable: false });

      const perItemUsd = settings.price_per_1k_usd / 1000;
      const startUsd = settings.run_start_usd;
      const budgetLimit = (): number => affordableItems(ctx.budget.snapshot().usdLeft, perItemUsd, startUsd);
      const total = Math.min(query.maxResults, budgetLimit());
      if (total < 1) throw new BudgetExceededError("channel", `${LINKEDIN_APIFY_ID}: budget left does not cover a run and one result`);

      const market = marketForChannel();
      const runs = buildActorInputs(query, settings, 1, market).length;
      if (total < runs) throw new BudgetExceededError("channel", `${LINKEDIN_APIFY_ID}: budget leaves room for fewer results than runs`);
      const perRunLimit = Math.max(1, Math.floor(total / runs));

      const delivered: Record<string, unknown>[] = [];
      let billedItems = 0;
      let billedUsd = 0;
      for (let index = 0; index < runs; index += 1) {
        try {
          if (index > 0) await ctx.throttle();
          const left = ctx.budget.snapshot();
          const limit = Math.min(perRunLimit, budgetLimit());
          if (limit < 1) throw new BudgetExceededError("channel", `${LINKEDIN_APIFY_ID}: budget exhausted after ${index} of ${runs} runs`);
          const runInput = buildActorInputs(query, settings, limit, market)[index];
          if (runInput === undefined) throw new Error("apify: missing actor input");
          const items = await runActorSync({
            ctx,
            token,
            url: runSyncUrl({
              actorId: settings.actor_id,
              maxItems: limit,
              maxTotalChargeUsd: left.usdLeft,
              memoryMb: settings.memory_mb,
              timeoutSecs: settings.timeout_secs,
              origin: options.origin ?? settings.api_base_url,
            }),
            input: runInput,
            timeoutSecs: settings.timeout_secs,
          });
          const records = items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item) && !isErrorItem(item));
          // Billed usage is never dropped: every delivered item counts, and so does the run's start fee, even for an empty run.
          const costUsd = startUsd + records.length * perItemUsd;
          await ctx.budget.consume(records.length, { costUsd, allowOverspend: true });
          billedItems += records.length;
          billedUsd += costUsd;
          delivered.push(...records);
        } catch (error) {
          // a later run failing must not throw away what earlier runs already delivered and billed
          if (delivered.length === 0 || isAbortError(error) || error instanceof InfrastructureError || ctx.signal.aborted) throw error;
          ctx.logger.warn("apify run failed after earlier runs delivered; keeping those", { run: index + 1, runs });
          break;
        }
      }

      const left = ctx.budget.snapshot();
      if (left.usdLeft < perItemUsd + startUsd) ctx.logger.warn("apify budget exhausted by this query", { items: billedItems, usd: billedUsd });
      ctx.logger.info("apify actor run finished", {
        runs,
        items: billedItems,
        usd: Math.round(billedUsd * 1e6) / 1e6,
        ...(ctx.cycle.id === null ? { dryRun: true, note: "dry run: the actor was billed, but nothing is stored or added to the persisted monthly usage" } : {}),
      });

      // Local time window for ranges shorter than LinkedIn's discrete one (the actor filters by day / week / month only).
      const { rangeHours } = dateRangeFor(query.windowHours);
      const observedAt = now().getTime();
      const cutoff = query.windowHours < rangeHours ? observedAt - query.windowHours * MS_PER_HOUR : null;

      const seen = new Set<string>();
      const out: RawPostingInput[] = [];
      let outsideWindow = 0;
      let noIdentity = 0;
      for (const record of delivered) {
        const externalId = jobIdOfRecord(record);
        if (externalId === null) {
          noIdentity += 1;
          continue;
        }
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        if (cutoff !== null && postedBefore(record, cutoff, observedAt)) {
          outsideWindow += 1;
          continue;
        }
        out.push({
          externalId,
          url: typeof record.url === "string" ? record.url : null,
          payload: record,
          postedAt: postedAtOf(record.postedDate),
        });
      }
      if (outsideWindow > 0 || noIdentity > 0) ctx.logger.info("apify records not stored", { outsideWindow, noIdentity });
      return out;
    },

    parse: parseApifyJob,
    descriptionHtml: apifyDescriptionHtml,
  };
}
