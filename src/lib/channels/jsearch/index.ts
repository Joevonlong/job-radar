import { jsearchSettingsSchema, loadConfig, type JsearchSettings } from "@/lib/config";

import { BudgetExceededError, ChannelError, isAbortError } from "../errors";
import { marketForChannel } from "@/lib/channels/market";
import type { Channel, ChannelContext, NormalizedPostingDraft, RawPostingInput, SearchQuery } from "../types";
import { assertCredentialEndpoint } from "../credential-endpoint";
import { cleanUrl } from "./apply";
import { getRecords, detailsUrl, JSEARCH_API_KEY_ENV, MAX_DETAIL_IDS, searchUrl } from "./client";
import { assertRequestsAllowed } from "./pace";
import { parseJsearchPayload, postedAt } from "./parse";
import { buildRequests } from "./query";
import { jobSchema } from "./schema";

export { JSEARCH_API_KEY_ENV } from "./client";
export { rankApplyLinks, cleanUrl, type ApplyLink } from "./apply";
export { assertRequestsAllowed, pacedAllowance } from "./pace";
export { parseJsearchPayload } from "./parse";
export { buildRequests, datePostedFor } from "./query";

export const JSEARCH_CHANNEL_ID = "jsearch";

export interface JsearchDeps {
  /** The channel's sources.yaml block, read when its price or apply-link order is needed (a config reload applies without re-registering). */
  settings?: () => JsearchSettings;
  /** Environment holding `JSEARCH_API_KEY` (read at collect time, never logged). */
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

function settingsOf(ctx: ChannelContext): JsearchSettings {
  const parsed = jsearchSettingsSchema.safeParse(ctx.settings.extra);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
    throw new ChannelError("unknown", `sources.yaml sources.jsearch is not usable (${paths.join(", ")})`, { retryable: false });
  }
  // An empty country follows the market
  return { ...parsed.data, country: parsed.data.country || marketForChannel().country.toLowerCase() };
}

/** The id of a raw record when it has one (records without one cannot be stored: no way to deduplicate them). */
function idOf(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const id = (record as Record<string, unknown>).job_id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

function stringField(record: unknown, key: string): string | null {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Records of the lists merged without duplicates, taking one from each list in turn until `limit`. */
export function interleaveRecords(lists: readonly (readonly unknown[])[], limit: number): Array<{ id: string; record: unknown }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; record: unknown }> = [];
  for (let i = 0; out.length < limit; i += 1) {
    let any = false;
    for (const list of lists) {
      const record = list[i];
      if (record === undefined) continue;
      any = true;
      const id = idOf(record);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, record });
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}

/**
 * `jsearch`: Google for Jobs through the JSearch API on RapidAPI. One query = the first
 * `keywords_per_query` keywords of a group, each searched in the city (or as a remote search).
 * Usage is counted in requests (a page is one request): they are booked against
 * `monthly_request_limit` and, beyond it, against `monthly_budget_usd`. Without `JSEARCH_API_KEY` the
 * channel is "not configured": it logs that and sends nothing.
 */
export function createJsearchChannel(deps: JsearchDeps = {}): Channel {
  const configured = deps.settings ?? (() => loadConfig("channels").sources.jsearch);
  const now = deps.now ?? (() => new Date());

  return {
    id: JSEARCH_CHANNEL_ID,
    family: "google",
    kind: "api",
    usesQueries: true,
    estimateCost: (paidRecords) => paidRecords * configured().overage_cost_per_request_usd,

    async collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]> {
      const env = deps.environment ?? process.env;
      const apiKey = env[JSEARCH_API_KEY_ENV]?.trim();
      if (!apiKey) {
        ctx.logger.info("jsearch is not configured", { env: JSEARCH_API_KEY_ENV });
        return [];
      }
      const settings = settingsOf(ctx);
      assertCredentialEndpoint("jsearch", settings.api_base_url, ctx, env);

      // ---- search: one request series per keyword
      const lists: unknown[][] = [];
      let requestsMade = 0;
      for (const [index, request] of buildRequests(query, settings).entries()) {
        ctx.signal.throwIfAborted();
        if (index > 0) await ctx.throttle();
        assertRequestsAllowed(ctx.budget, settings, settings.pages_per_query, now());
        const answer = await getRecords(ctx, settings, apiKey, searchUrl(settings, request));
        await ctx.budget.consume(settings.pages_per_query);
        requestsMade += settings.pages_per_query;
        if (answer.remaining !== null) ctx.logger.debug("jsearch plan requests left", { remaining: answer.remaining });
        lists.push(answer.records);
      }
      const selected = interleaveRecords(lists, query.maxResults);
      const dropped = lists.reduce((sum, list) => sum + list.length, 0) - selected.length;

      // ---- details: only for postings the search left without a description
      const details = new Map<string, unknown>();
      if (settings.fetch_details) {
        const wanted = selected
          .filter(({ record }) => (stringField(record, "job_description") ?? "").trim() === "")
          .slice(0, settings.max_details_per_query)
          .map(({ id }) => id);
        try {
          for (let from = 0; from < wanted.length; from += MAX_DETAIL_IDS) {
            const batch = wanted.slice(from, from + MAX_DETAIL_IDS);
            await ctx.throttle();
            assertRequestsAllowed(ctx.budget, settings, batch.length, now());
            const answer = await getRecords(ctx, settings, apiKey, detailsUrl(settings, batch));
            await ctx.budget.consume(batch.length);
            requestsMade += batch.length;
            for (const record of answer.records) {
              const id = idOf(record);
              if (id !== null) details.set(id, record);
            }
          }
        } catch (error) {
          if (isAbortError(error) || ctx.signal.aborted) throw error;
          // the search already cost requests: keep its postings, only the descriptions are missing
          // (a quota / auth problem shows again on the next query)
          const failure = error instanceof ChannelError ? error : null;
          ctx.logger.warn("jsearch details unavailable, continuing with search data", {
            query: query.id,
            code: failure?.code ?? "unknown",
            budget: error instanceof BudgetExceededError,
          });
        }
      }

      const postings = selected.map(({ id, record }): RawPostingInput => {
        const detail = details.get(id) ?? null;
        const typed = jobSchema.safeParse(record);
        return {
          externalId: id,
          url: cleanUrl(stringField(record, "job_apply_link")),
          // the whole record as the API sent it (C1), plus the details record when one was fetched
          payload: { search: record, detail },
          postedAt: typed.success ? postedAt(typed.data) : null,
        };
      });
      ctx.logger.info("jsearch query done", { query: query.id, requests: requestsMade, postings: postings.length, details: details.size, dropped: dropped });
      return postings;
    },

    parse(payload: unknown): NormalizedPostingDraft {
      return parseJsearchPayload(payload, configured().apply_publisher_preference);
    },
  };
}
