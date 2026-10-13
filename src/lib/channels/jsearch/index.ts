import { jsearchSettingsSchema, loadConfig, type JsearchSettings } from "@/lib/config";

import { BudgetExceededError, ChannelError, isAbortError, PartialCollectError } from "../errors";
import { marketForChannel } from "@/lib/channels/market";
import type { Channel, ChannelContext, NormalizedPostingDraft, RawPostingInput, SearchQuery } from "../types";
import { assertCredentialEndpoint } from "../credential-endpoint";
import { loadKnownDetails, storedDetailOf } from "../known";
import { cleanUrl } from "./apply";
import { getRecords, detailsUrl, JSEARCH_API_KEY_ENV, MAX_DETAIL_IDS, searchUrl } from "./client";
import { assertRequestsAllowed } from "./pace";
import { parseJsearchPayload, postedAt } from "./parse";
import { buildRequests } from "./query";
import { jobSchema, lacksDescription, payloadSchema } from "./schema";

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
      /** The request of a later keyword failed: what the earlier keywords read is kept, the failure is reported with it. */
      let interrupted: ChannelError | null = null;
      /** A later keyword was refused by the plan's own limits before its request: a planned stop, not a failure. */
      let stoppedBy: BudgetExceededError | null = null;
      for (const [index, request] of buildRequests(query, settings).entries()) {
        ctx.signal.throwIfAborted();
        if (index > 0) await ctx.throttle();
        try {
          assertRequestsAllowed(ctx.budget, settings, settings.pages_per_query, now());
        } catch (error) {
          // the first keyword refused: the whole query is skipped, as before
          if (!(error instanceof BudgetExceededError) || index === 0) throw error;
          ctx.logger.info("jsearch budget reached mid-query", { query: query.id, keywordsDone: index });
          stoppedBy = error;
          break;
        }
        let answer: Awaited<ReturnType<typeof getRecords>>;
        try {
          answer = await getRecords(ctx, settings, apiKey, searchUrl(settings, request));
        } catch (error) {
          if (isAbortError(error) || ctx.signal.aborted || !(error instanceof ChannelError)) throw error;
          interrupted = error;
          break;
        }
        // the request is answered, so it is used: booked in full even when another unit just took the last of the global allowance
        await ctx.budget.consume(settings.pages_per_query, { allowOverspend: true });
        requestsMade += settings.pages_per_query;
        if (answer.remaining !== null) ctx.logger.debug("jsearch plan requests left", { remaining: answer.remaining });
        lists.push(answer.records);
      }
      const selected = interleaveRecords(lists, query.maxResults);
      const dropped = lists.reduce((sum, list) => sum + list.length, 0) - selected.length;
      // nothing to hand over: the failure or the refusal is the result
      if (selected.length === 0 && (interrupted ?? stoppedBy)) throw interrupted ?? stoppedBy;

      // ---- details: only for postings the search left without a description (none after a failed request: it would fail too)
      const details = new Map<string, unknown>();
      if (settings.fetch_details && interrupted === null) {
        const wanted = selected
          .filter(({ record }) => lacksDescription(record))
          .slice(0, settings.max_details_per_query)
          .map(({ id }) => id);
        try {
          for (let from = 0; from < wanted.length; from += MAX_DETAIL_IDS) {
            const batch = wanted.slice(from, from + MAX_DETAIL_IDS);
            await ctx.throttle();
            assertRequestsAllowed(ctx.budget, settings, batch.length, now());
            const answer = await getRecords(ctx, settings, apiKey, detailsUrl(settings, batch));
            await ctx.budget.consume(batch.length, { allowOverspend: true });
            requestsMade += batch.length;
            for (const record of answer.records) {
              const id = idOf(record);
              if (id !== null) details.set(id, record);
            }
          }
        } catch (error) {
          // a failure of ours (the usage store) is not "details unavailable"
          if (isAbortError(error) || ctx.signal.aborted || !(error instanceof ChannelError)) throw error;
          // the search already cost requests: keep its postings, only the descriptions are missing
          // (a quota / auth problem shows again on the next query)
          ctx.logger.warn("jsearch details unavailable, continuing with search data", {
            query: query.id,
            code: error.code,
            budget: error instanceof BudgetExceededError,
          });
        }
      }

      // ---- stored details: a posting with no description from this search and none from a new detail keeps the description of
      // one stored earlier, whatever stopped the details from being fetched (the stored payload would otherwise be replaced by none)
      const missing = selected.filter(({ id, record }) => lacksDescription(record) && lacksDescription(details.get(id))).map(({ id }) => id);
      const storedDetail = storedDetailOf<unknown>(payloadSchema);
      const stored = await loadKnownDetails(ctx, {
        enabled: true,
        externalIds: missing,
        // a stored detail without a usable description gives nothing to keep
        detailOf: (payload) => {
          const detail = storedDetail(payload);
          return detail !== null && !lacksDescription(detail) ? detail : null;
        },
      });

      const postings = selected.map(({ id, record }): RawPostingInput => {
        const typed = jobSchema.safeParse(record);
        const keptDetail = stored.get(id);
        return {
          externalId: id,
          url: cleanUrl(stringField(record, "job_apply_link")),
          // the whole record as the API sent it (C1), plus the details record when one was fetched; a detail kept from an earlier
          // cycle is marked, and the parser takes only its description
          payload: keptDetail === undefined ? { search: record, detail: details.get(id) ?? null } : { search: record, detail: keptDetail, detail_source: "stored" },
          postedAt: typed.success ? postedAt(typed.data) : null,
        };
      });
      ctx.logger.info("jsearch query done", {
        query: query.id,
        requests: requestsMade,
        postings: postings.length,
        details: details.size,
        storedDetails: stored.size,
        dropped: dropped,
        ...(interrupted ? { interrupted: interrupted.code } : {}),
        ...(stoppedBy ? { stopped: "budget" } : {}),
      });
      if (interrupted) throw new PartialCollectError(postings, interrupted);
      if (stoppedBy) throw new PartialCollectError(postings, stoppedBy, { planned: true });
      return postings;
    },

    parse(payload: unknown): NormalizedPostingDraft {
      return parseJsearchPayload(payload, configured().apply_publisher_preference);
    },
  };
}
