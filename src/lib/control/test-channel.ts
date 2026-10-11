/**
 * `test_channel`: the "test" button of a channel on /sources. One small dry fetch in the runner: the first
 * query of the cycle plan (or the board sweep), at most `sources.yaml: test_channel.max_results` postings, parsed in
 * memory. Nothing is written: no run, raw posting, usage or circuit row (C1 does not apply: nothing is kept).
 */
import { BudgetTracker, monthKey } from "@/lib/channels/budget";
import { createChannelContext, httpSettingsFromConfig, NO_KNOWN_POSTINGS } from "@/lib/channels/context";
import { isAbortError, toChannelError } from "@/lib/channels/errors";
import type { FetchLike, SleepFn } from "@/lib/channels/http";
import { buildQueries, buildSweepQuery, capQuery } from "@/lib/channels/query";
import { defaultRegistry, type ChannelRegistry } from "@/lib/channels/registry";
import { createDbStateStore, createMemoryStateStore } from "@/lib/channels/store";
import { normalizedPostingDraftSchema, rawPostingInputSchema, type RawPostingInput } from "@/lib/channels/types";
import { loadConfig, type ChannelsConfig, type ScheduleConfig, type SearchConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { isCycleRunning } from "@/lib/db/repos/cycles";

import { testChannelPayloadSchema, type ControlHandler, type ControlOutcome } from "./types";

/** Titles of the first parsed postings shown under the button. */
export const TEST_SAMPLE_TITLES = 3;
const MAX_TITLE_CHARS = 120;

/** Why a channel test did not run or failed (`control_requests.result.error`). */
export type TestChannelError =
  | "invalid_payload"
  | "unknown_channel"
  | "channel_excluded"
  | "channel_disabled"
  | "not_configured"
  | "budget_exceeded"
  | "another_cycle_running"
  | "channel_test_failed";

export interface TestChannelDeps {
  registry?: ChannelRegistry;
  /** Config overrides (defaults: the loaded files). */
  config?: Partial<{ channels: ChannelsConfig; search: SearchConfig; schedule: ScheduleConfig }>;
  /** Whether a cycle runs now (default: the `cycles` table). */
  cycleRunning?: (db: Db) => Promise<boolean>;
  /** Budget state; default: the database (read only, through an in-memory overlay). */
  budgetStore?: (db: Db) => Parameters<typeof BudgetTracker.create>[0]["store"];
  fetch?: FetchLike;
  sleep?: SleepFn;
  random?: () => number;
  now?: () => Date;
}

const failed = (error: TestChannelError, extra: Record<string, unknown> = {}): ControlOutcome => ({ status: "failed", result: { error, ...extra } });

export function createTestChannelHandler(deps: TestChannelDeps = {}): ControlHandler {
  return async (request, context) => {
    const payload = testChannelPayloadSchema.safeParse(request.payload);
    if (!payload.success) return failed("invalid_payload");
    const { channelId } = payload.data;
    const registry = deps.registry ?? defaultRegistry;
    const now = deps.now ?? (() => new Date());
    const channels = deps.config?.channels ?? loadConfig("channels");
    const search = deps.config?.search ?? loadConfig("search");
    const schedule = deps.config?.schedule ?? loadConfig("schedule");
    const test = channels.test_channel;

    const channel = registry.get(channelId);
    const settings = registry.settingsFor(channelId, channels);
    if (!channel || !settings) return failed("unknown_channel", { channelId });
    if ((test.excluded_kinds as readonly string[]).includes(channel.kind)) return failed("channel_excluded", { channelId });
    if (!settings.enabled) return failed("channel_disabled", { channelId });
    if (channel.isConfigured && !channel.isConfigured()) return failed("not_configured", { channelId });
    // a running cycle owns the sources (and their rate limits) until it is done
    if (await (deps.cycleRunning ?? isCycleRunning)(context.db)) return failed("another_cycle_running", { channelId });

    const budget = await BudgetTracker.create({
      store: deps.budgetStore ? deps.budgetStore(context.db) : createMemoryStateStore(createDbStateStore(context.db)),
      month: monthKey(now(), schedule.timezone),
      globalCapUsd: channels.paid_total_monthly_budget_usd,
      settingsFor: (id) => registry.settingsFor(id, channels),
    });
    if (!budget.hasHeadroom(channel)) return failed("budget_exceeded", { channelId });

    const maxResults = Math.min(settings.maxResults, test.max_results);
    const planned = channel.usesQueries ? buildQueries(search, "manual")[0] : buildSweepQuery(search, "manual");
    if (!planned) return failed("channel_test_failed", { channelId, errorCode: "unknown" });
    const query = capQuery({ ...planned, maxResults: Math.min(planned.maxResults, maxResults) }, maxResults);

    const timeout = AbortSignal.timeout(test.timeout_seconds * 1000);
    const signal = AbortSignal.any([context.signal, timeout]);
    const started = now().getTime();
    // board-discovery channels (tavily, brave) send `max_queries_per_run` paid searches: the test sends at most `max_queries`
    const perRun = settings.extra.max_queries_per_run;
    const extra = typeof perRun === "number" ? { ...settings.extra, max_queries_per_run: Math.min(perRun, test.max_queries) } : settings.extra;
    const channelContext = createChannelContext({
      channelId,
      settings: { ...settings, maxResults, extra },
      http: httpSettingsFromConfig(channels),
      budget: budget.forChannel(channel),
      signal,
      cycle: { id: null, kind: "manual" },
      logger: context.logger,
      known: NO_KNOWN_POSTINGS,
      now,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
    });

    context.logger.info("channel test started", { channel: channelId, query: query.id, maxResults });
    let collected: RawPostingInput[];
    try {
      const output: unknown = await channel.collect(query, channelContext);
      if (!Array.isArray(output)) return failed("channel_test_failed", { channelId, errorCode: "parse", durationMs: now().getTime() - started });
      collected = output as RawPostingInput[];
    } catch (error) {
      // the runner is shutting down: let the poller record it like any other interrupted request
      if (context.signal.aborted) throw error;
      const errorCode = timeout.aborted || isAbortError(error) ? "timeout" : toChannelError(error).code;
      context.logger.warn("channel test failed", { channel: channelId, code: errorCode });
      return failed("channel_test_failed", { channelId, errorCode, durationMs: now().getTime() - started });
    }

    let parsed = 0;
    let parseFailed = 0;
    const sampleTitles: string[] = [];
    for (const record of collected) {
      const raw = rawPostingInputSchema.safeParse(record);
      if (!raw.success) {
        parseFailed += 1;
        continue;
      }
      try {
        const draft = normalizedPostingDraftSchema.parse(channel.parse(raw.data.payload));
        parsed += 1;
        if (sampleTitles.length < TEST_SAMPLE_TITLES) sampleTitles.push(draft.title.slice(0, MAX_TITLE_CHARS));
      } catch {
        parseFailed += 1;
      }
    }
    const durationMs = now().getTime() - started;
    context.logger.info("channel test finished", { channel: channelId, fetched: collected.length, parsed, parseFailed, durationMs });
    return {
      status: "done",
      result: { channelId, fetched: collected.length, parsed, parseFailed, sampleTitles, durationMs, keywordGroup: query.keywordGroup, location: query.location },
    };
  };
}

export const testChannelHandler: ControlHandler = createTestChannelHandler();
