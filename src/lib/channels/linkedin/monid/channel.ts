import { BudgetExceededError, ChannelError, InfrastructureError, isAbortError, PartialCollectError } from "../../errors";
import type { FetchLike, SleepFn } from "../../http";
import { marketForChannel } from "../../market";
import type { Channel, ChannelContext, RawPostingInput, SearchQuery } from "../../types";
import { buildActorInputs, dateRangeFor, isErrorItem } from "../apify/contract";
import { postedAtOf } from "../brightdata/parse";
import { affordableItems } from "../budget";
import { postedDateEvidence } from "../date-window";
import { MonidClient } from "./client";
import { MONID_API_KEY_ENV, monidSettingsSchema } from "./contract";
import { monidDescriptionHtml, monidJobId, parseMonidJob, unidentifiedExternalId } from "./parse";

export const LINKEDIN_MONID_ID = "linkedin-monid";
const MS_PER_HOUR = 3_600_000;

export interface MonidChannelOptions {
  pricePer1kUsd: () => number;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  sleep?: SleepFn;
  stopFetch?: FetchLike;
}

export function createMonidChannel(options: MonidChannelOptions): Channel {
  const now = options.now ?? (() => new Date());
  const environment = (): Readonly<Record<string, string | undefined>> => options.environment ?? process.env;
  const key = (): string | undefined => environment()[MONID_API_KEY_ENV]?.trim() || undefined;
  return {
    id: LINKEDIN_MONID_ID, family: "linkedin", kind: "paid", usesQueries: true,
    // Billed per record with coarse date ranges and no newest-first order: stretching would mostly buy old postings.
    // Return true only after exact second-level requests and newest-first results under current settings have been measured.
    supportsCatchUp: () => false,
    estimateCost: (records) => records * options.pricePer1kUsd() / 1000,
    isConfigured: () => key() !== undefined,

    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const apiKey = key();
      if (!apiKey) throw new ChannelError("auth_expired", "MONID_API_KEY is not set", { retryable: false });
      const parsed = monidSettingsSchema.safeParse(ctx.settings.extra);
      if (!parsed.success) throw new ChannelError("unknown", "sources.yaml linkedin.monid is incomplete or invalid", { retryable: false });
      const settings = parsed.data;
      const market = marketForChannel();
      const runs = buildActorInputs(query, settings, 1, market).length;
      const maxResults = Math.min(query.maxResults, ctx.settings.maxResults);
      if (maxResults < runs) throw new BudgetExceededError("channel", "linkedin-monid: result cap cannot cover one item per split run");
      const perRunLimit = Math.max(1, Math.floor(maxResults / runs));
      const client = new MonidClient({ ctx, apiKey, settings, environment: environment(), now: () => now().getTime(),
        ...(options.sleep ? { sleep: options.sleep } : {}), ...(options.stopFetch ? { stopFetch: options.stopFetch } : {}) });
      const postings: RawPostingInput[] = [];
      const seen = new Set<string>();
      const { rangeHours } = dateRangeFor(query.windowHours);
      const cutoff = query.windowHours < rangeHours ? now().getTime() - query.windowHours * MS_PER_HOUR : null;
      ctx.deliveries.setWindowCutoff(cutoff);
      let remaining = maxResults;
      for (let index = 0; index < runs && remaining > 0; index += 1) {
        let localBudgetStop = false;
        try {
          ctx.signal.throwIfAborted();
          if (index > 0) await ctx.throttle();
          const usdLeft = ctx.budget.snapshot().usdLeft;
          const limit = Math.min(perRunLimit, remaining, affordableItems(usdLeft, settings.price_per_1k_usd / 1000, settings.flat_fee_usd));
          if (usdLeft <= 0 || limit < 1) {
            localBudgetStop = true;
            throw new BudgetExceededError("channel", "linkedin-monid: budget left does not cover a run and one result");
          }
          const input = buildActorInputs(query, settings, limit, market)[index];
          if (!input) throw new ChannelError("unknown", "Monid query has no actor input", { retryable: false });
          const { items, ordinals } = await client.run(input, limit);
          remaining -= limit;
          let errorItems = 0;
          let outsideWindow = 0;
          for (const [itemIndex, item] of items.entries()) {
            const ordinal = ordinals[itemIndex];
            if (isErrorItem(item)) {
              errorItems += 1;
              if (ordinal !== undefined) ctx.deliveries.drop(ordinal, "provider_error", { externalId: monidJobId(item) });
              continue;
            }
            const id = monidJobId(item);
            const externalId = id ?? unidentifiedExternalId(item);
            const record = typeof item === "object" && item !== null && !Array.isArray(item) ? item as Record<string, unknown> : null;
            const postedDate = typeof record?.postedDate === "string" ? record.postedDate : null;
            const postedAt = postedAtOf(postedDate);
            const { end, flags } = postedDateEvidence(postedDate, postedAt);
            if (ordinal !== undefined) {
              ctx.deliveries.flag(ordinal, flags);
              if (id === null) ctx.deliveries.flag(ordinal, ["unidentified"]);
            }
            if (seen.has(externalId)) {
              if (ordinal !== undefined) ctx.deliveries.drop(ordinal, "duplicate_in_run", { externalId });
              continue;
            }
            seen.add(externalId);
            // Unidentified records are always quarantined, even when their date is malformed or old.
            if (id !== null && cutoff !== null && end !== null && end < cutoff) {
              outsideWindow += 1;
              if (ordinal !== undefined) ctx.deliveries.drop(ordinal, "outside_window", { externalId });
              continue;
            }
            postings.push({ externalId, payload: item, url: typeof record?.linkedinUrl === "string" ? record.linkedinUrl : null, postedAt,
              ...(ordinal === undefined ? {} : { deliveryOrdinal: ordinal }) });
          }
          if (errorItems || outsideWindow) ctx.logger.info("monid items skipped", { errorItems, outsideWindow });
        } catch (error) {
          if (ctx.signal.aborted || isAbortError(error) || error instanceof InfrastructureError || postings.length === 0) throw error;
          if (error instanceof ChannelError) throw new PartialCollectError(postings, error, { planned: localBudgetStop });
          throw error;
        }
      }
      return postings;
    },
    parse: parseMonidJob,
    descriptionHtml: monidDescriptionHtml,
  };
}
