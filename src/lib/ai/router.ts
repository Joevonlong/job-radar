import type { ZodType } from "zod";

import { monthKey } from "@/lib/channels/budget";
import type { ChannelLogger } from "@/lib/channels/types";
import { type AiModelSource } from "@/lib/ai-usage/constants";
import { cliDefaultModel, findCatalogModel, type AiConfig, type ModelsConfig } from "@/lib/config";

import { loadModelCatalog } from "./catalog";
import { AiProviderError, AiUnavailableError, sanitize, type AiAttempt, type AiQuotaGuardMark } from "./errors";
import { cooldownUntil, createMemoryHealthStore, healthDay, isCoolingDown, requestsOn, type AiHealthStore } from "./health";
import {
  evaluateQuota,
  isQuotaGuarded,
  nextQuotaState,
  quotaPolicy,
  quotaStateChanged,
  type AiQuotaStore,
  type AiRequestOrigin,
} from "./quota-guard";
import { toJsonSchema } from "./schema-to-json";
import type { AiCallRecord, AiPrompt, AiProvider, AiProviderId, AiResult, AiRunOptions, AiTask } from "./types";
import { CODEX_DEFAULT_MODEL } from "./providers/codex-cli";
import { estimateCostUsd, estimateEquivalentUsd, type AiUsageStore } from "./usage";
import { webCapable } from "./web-tasks";

/**
 * Provider order for `task`: the task's own `order` if ai.yaml sets one, else the global `order`;
 * the `api` entry expands to `api_order`; duplicates keep their first position.
 */
export function resolveProviderOrder(config: AiConfig, task: AiTask): AiProviderId[] {
  const entries = config.tasks[task].order ?? config.order;
  const out: AiProviderId[] = [];
  const add = (id: AiProviderId): void => {
    if (!out.includes(id)) out.push(id);
  };
  for (const entry of entries) {
    if (entry === "api") config.api_order.forEach(add);
    else add(entry);
  }
  return out;
}

export interface AiRouterOptions {
  config: AiConfig;
  providers: readonly AiProvider[];
  /** null: no persistence; the API budget is then tracked in memory for this router only. */
  usage: AiUsageStore | null;
  /** Time zone of the budget month (schedule.yaml `timezone`). */
  timeZone?: string;
  now?: () => Date;
  logger?: ChannelLogger;
  /** Cross-process provider health: cooldowns, today's request counts. Omitted: tracked in memory for this router only; null: not tracked. */
  health?: AiHealthStore | null;
  /** The AI work of this cycle must end by then: later requests fail at once with "budget" attempts. */
  deadline?: Date | null;
  /**
   * The model catalog (models.yaml) used for prices. Omitted: read from the config (a broken file counts as no
   * catalog); null: no catalog (API providers are skipped, the subscription CLIs are unaffected).
   */
  catalog?: ModelsConfig | null;
  /**
   * Job Radar's own usage cap for the subscription CLIs (ai.yaml `quota_guard`): where the calls are counted and the
   * window state is kept. Omitted / null: no cap (an error cooldown still applies, as before).
   */
  quota?: AiQuotaStore | null;
  /** Who asks: `cycle` (default) is held back by the per-cycle cap too; `control` (a request the user made) only by the window cap and a cooldown. */
  origin?: AiRequestOrigin;
  /** When the current cycle started: the per-cycle cap counts the calls since then. null / omitted: no per-cycle cap. */
  cycleStartedAt?: Date | null;
}

const POLICY_KEY = { "claude-cli": "claude_cli", "codex-cli": "codex_cli", anthropic: "anthropic", deepseek: "deepseek", mimo: "mimo" } as const;

interface GateBlock {
  kind: AiProviderError["kind"];
  message: string;
  guard?: AiQuotaGuardMark;
}

const clock = (at: Date, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(at);

export interface AiRouter {
  /** The providers that would be tried for `task`, in order (configured or not). */
  plan(task: AiTask): AiProviderId[];
  /** Whether any provider of `task`'s plan could be tried right now, and why the others cannot (cooldown, cap, off, not installed). */
  usable(task: AiTask): Promise<{ usable: boolean; blocked: AiAttempt[] }>;
  run<T>(task: AiTask, prompt: AiPrompt, schema: ZodType<T>, opts?: AiRunOptions): Promise<AiResult<T>>;
}

export function createAiRouter(options: AiRouterOptions): AiRouter {
  const { config, usage } = options;
  const providers = new Map(options.providers.map((p) => [p.id, p]));
  const now = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? "UTC";
  const logger = options.logger;
  const health = options.health === undefined ? createMemoryHealthStore() : options.health;
  const deadline = options.deadline ?? null;
  const quota = options.quota && config.quota_guard.enabled ? options.quota : null;
  const origin: AiRequestOrigin = options.origin ?? "cycle";
  const cycleStartedAt = options.cycleStartedAt ?? null;
  const getCatalog = (): ModelsConfig | null => (options.catalog === undefined ? loadModelCatalog(logger) : options.catalog);
  /** A health store that is down must never take the AI layer down with it. */
  const safely = async <R>(what: string, fn: (store: AiHealthStore) => Promise<R>): Promise<R | undefined> => {
    if (!health) return undefined;
    try {
      return await fn(health);
    } catch (error) {
      logger?.warn("ai provider health could not be read or written", { what, error: error instanceof Error ? sanitize(error.message) : "unknown" });
      return undefined;
    }
  };
  /** Providers that failed with an auth problem: not retried for the rest of this router's life. */
  const disabled = new Map<AiProviderId, string>();
  let localApiSpend = 0;

  const apiSpendUsd = async (): Promise<number> =>
    usage ? usage.apiSpendUsd(monthKey(now(), timeZone), timeZone) : localApiSpend;

  /** The model a call is recorded under: codex without an explicit model is the catalog's `cli_default` (marked as such). */
  const attribute = (providerId: AiProviderId, reported: string | null, catalog: ModelsConfig | null): { model: string | null; source: AiModelSource | null } => {
    if (reported === null) return { model: null, source: null };
    if (providerId === "codex-cli" && reported === CODEX_DEFAULT_MODEL) {
      const fallback = catalog ? cliDefaultModel(catalog) : null;
      return fallback ? { model: fallback.id, source: "cli_default" } : { model: null, source: null };
    }
    return { model: reported, source: "call" };
  };

  const record = async (task: AiTask, provider: AiProvider, call: AiCallRecord, jobId: number | undefined, webSearchCostUsd = 0): Promise<number> => {
    const catalog = getCatalog();
    const { model, source } = attribute(provider.id, call.model, catalog);
    const { usage: tokens } = call;
    const reported = tokens.reported !== false;
    // an unreported reply has only placeholder counts: it costs 0 as far as the budget can tell
    const priced = estimateCostUsd(catalog, provider.id, model ?? "", reported ? tokens : { tokensIn: 0, tokensOut: 0 });
    // server-side web searches are billed per search, apart from the tokens (API providers only; a subscription costs 0)
    const searchCost = provider.kind === "api" ? (tokens.webSearches ?? 0) * webSearchCostUsd : 0;
    const actual = searchCost > 0 ? { ...priced, costUsd: priced.costUsd + searchCost } : priced;
    const failed = call.outcome === "failed";
    if (actual.priced === "fallback" && !failed) {
      logger?.warn("ai model not in catalog, priced at the provider's highest price", { provider: provider.id, model });
    }
    if (provider.kind === "api" && !reported && !failed) {
      logger?.warn("ai usage not reported by the provider, cost counted as 0", { provider: provider.id, model });
    }
    const equivalentUsd = failed ? null : estimateEquivalentUsd(catalog, provider.id, model ?? "", tokens, actual);
    if (provider.kind === "api") localApiSpend += actual.costUsd;
    logger?.info("ai call", {
      provider: provider.id,
      task,
      model,
      outcome: call.outcome,
      durationMs: call.durationMs,
      tokensIn: reported ? tokens.tokensIn : null,
      tokensOut: reported ? tokens.tokensOut : null,
      cachedIn: reported ? (tokens.cachedIn ?? null) : null,
      reasoningOut: reported ? (tokens.reasoningOut ?? null) : null,
      costUsd: actual.costUsd,
      equivalentUsd,
    });
    if (usage) {
      try {
        await usage.record({
          provider: provider.id,
          task,
          model,
          modelSource: source,
          tokensIn: reported ? tokens.tokensIn : null,
          tokensInCached: reported ? (tokens.cachedIn ?? null) : null,
          tokensInCacheWrite: reported ? (tokens.cacheWriteIn ?? null) : null,
          tokensOut: reported ? tokens.tokensOut : null,
          tokensOutReasoning: reported ? (tokens.reasoningOut ?? null) : null,
          durationMs: call.durationMs,
          outcome: call.outcome,
          errorKind: failed ? (call.errorKind ?? null) : null,
          costUsd: actual.costUsd,
          equivalentUsd,
          jobId: jobId ?? null,
          at: now(),
        });
      } catch (error) {
        // The answer is already paid for; losing one usage row must not lose the answer.
        logger?.error("ai usage could not be recorded", { provider: provider.id, error: error instanceof Error ? sanitize(error.message) : "unknown" });
      }
    }
    return actual.costUsd;
  };

  /** The model this task uses with `id`: the task's own choice, else the provider's configured model. */
  const modelFor = (id: AiProviderId, task: AiTask): string | undefined => {
    const chosen = config.tasks[task].models?.[id];
    if (chosen !== undefined) return chosen;
    switch (id) {
      case "claude-cli": return config.providers.claude_cli.model;
      case "codex-cli": return config.providers.codex_cli.model;
      case "anthropic": return config.providers.anthropic.model;
      case "deepseek": return config.providers.deepseek.model;
      case "mimo": return config.providers.mimo.model;
    }
  };

  /**
   * The usage cap of a subscription CLI: the rolling window (every origin) and this cycle's cap (`cycle` origin only).
   * Stores the window state when it changes. A count that cannot be read lets the call through (fail-open).
   */
  const quotaGate = async (id: AiProviderId): Promise<GateBlock | null> => {
    if (!quota || !isQuotaGuarded(id)) return null;
    const policy = quotaPolicy(config, id);
    if (!policy) return null;
    try {
      const at = now();
      const previous = await quota.getState(id);
      const rows = policy.hardRequests > 0 ? await quota.usageSince(id, new Date(at.getTime() - policy.windowHours * 3_600_000)) : [];
      const evaluation = evaluateQuota(rows, policy, at, previous);
      const next = nextQuotaState(previous, evaluation, at);
      if (quotaStateChanged(previous, next)) {
        await quota.setState(id, next);
        if (next.level !== (previous?.level ?? "ok")) {
          logger?.warn(next.level === "hard" ? "ai usage cap reached, provider paused" : "ai usage cap cleared, provider resumed", {
            provider: id,
            windowRequests: evaluation.windowRequests,
            hardRequests: policy.hardRequests,
            resumeAt: evaluation.resumeAt?.toISOString() ?? null,
          });
        }
      }
      if (evaluation.level === "hard") {
        const back = evaluation.resumeAt ? `; back around ${clock(evaluation.resumeAt, timeZone)}` : "";
        return {
          kind: "budget",
          message: `Job Radar's own usage cap reached (${evaluation.windowRequests} calls in ${policy.windowHours}h, cap ${policy.hardRequests})${back}`,
          guard: { reason: "window", resumeAt: evaluation.resumeAt?.toISOString() ?? null },
        };
      }
      if (origin === "cycle" && cycleStartedAt && policy.cycleRequestCap > 0) {
        const used = await quota.countSince(id, cycleStartedAt);
        if (used >= policy.cycleRequestCap) {
          return {
            kind: "budget",
            message: `Job Radar's per-cycle cap of ${policy.cycleRequestCap} calls reached (${used} this cycle); continues next cycle`,
            guard: { reason: "cycle_cap", resumeAt: null },
          };
        }
      }
    } catch (error) {
      logger?.warn("ai usage cap could not be checked, the call is allowed", { provider: id, error: error instanceof Error ? sanitize(error.message) : "unknown" });
    }
    return null;
  };

  /** Why `id` cannot be tried right now (not installed, turned off, cooling down, over its cap, out of budget); null = go ahead. */
  const gate = async (id: AiProviderId, task: AiTask): Promise<GateBlock | null> => {
    const provider = providers.get(id);
    if (!provider) return { kind: "not_configured", message: "provider not available" };
    const disabledReason = disabled.get(id);
    if (disabledReason !== undefined) return { kind: "auth", message: disabledReason };
    const policy = config.providers[POLICY_KEY[id]];
    if (!policy.enabled) return { kind: "not_configured", message: "turned off in ai.yaml (enabled: false)" };
    const state = await safely("read", (store) => store.get(id));
    if (state && isCoolingDown(state, now())) {
      const until = state.coolingUntil as Date;
      return {
        kind: "rate_limited",
        message: `cooling down until ${clock(until, timeZone)} (${state.lastErrorMessage ?? "limit reached"})`.slice(0, 400),
        // a limit the provider reported is the usage cap's third reason (it shows and alerts as such)
        ...(quota && isQuotaGuarded(id) ? { guard: { reason: "error", resumeAt: until.toISOString() } satisfies AiQuotaGuardMark } : {}),
      };
    }
    if (state && policy.daily_request_cap > 0 && requestsOn(state, healthDay(now(), timeZone)) >= policy.daily_request_cap) {
      return { kind: "budget", message: `daily request cap of ${policy.daily_request_cap} reached` };
    }
    const capped = await quotaGate(id);
    if (capped) return capped;
    const availability = provider.availability();
    if (!availability.available) return { kind: "not_configured", message: availability.reason ?? "not configured" };
    if (provider.kind === "api") {
      // the monthly budget needs a price for every call: no catalog or no price for the model to use = skip this provider
      const catalog = getCatalog();
      if (!catalog) return { kind: "not_configured", message: "models.yaml could not be read" };
      const model = modelFor(id, task);
      if (model !== undefined && !(findCatalogModel(catalog, id, model)?.model.price)) {
        return { kind: "not_configured", message: `no price for model "${model}" in models.yaml` };
      }
      const spent = await apiSpendUsd();
      if (spent >= config.monthly_api_budget_usd) {
        return { kind: "budget", message: `monthly API budget of $${config.monthly_api_budget_usd} reached ($${spent.toFixed(4)} spent)` };
      }
    }
    return null;
  };

  /** After the usage cap held a subscription CLI back, the paid API tier is not tried (`fallthrough_to_api: false`). */
  const apiClosed = (heldBack: boolean, id: AiProviderId): GateBlock | null =>
    heldBack && !config.quota_guard.fallthrough_to_api && providers.get(id)?.kind === "api"
      ? { kind: "budget", message: "not tried: Job Radar's usage cap held the subscription CLIs back and quota_guard.fallthrough_to_api is false" }
      : null;
  const holdsBack = (block: GateBlock | null): boolean => block?.guard?.reason === "window" || block?.guard?.reason === "cycle_cap";
  const toAttempt = (id: AiProviderId, block: GateBlock): AiAttempt => ({
    provider: id,
    outcome: "skipped",
    kind: block.kind,
    message: block.message,
    ...(block.guard ? { guard: block.guard } : {}),
  });

  return {
    plan: (task) => resolveProviderOrder(config, task),

    async usable(task) {
      const blocked: AiAttempt[] = [];
      let heldBack = false;
      for (const id of resolveProviderOrder(config, task)) {
        const reason = apiClosed(heldBack, id) ?? (await gate(id, task));
        if (!reason) return { usable: true, blocked };
        heldBack ||= holdsBack(reason);
        blocked.push(toAttempt(id, reason));
      }
      return { usable: false, blocked };
    },

    async run<T>(task: AiTask, prompt: AiPrompt, schema: ZodType<T>, opts: AiRunOptions = {}): Promise<AiResult<T>> {
      toJsonSchema(schema); // a schema that cannot be sent fails here, before any provider is blamed
      const attempts: AiAttempt[] = [];
      if (deadline && now().getTime() >= deadline.getTime()) {
        for (const id of resolveProviderOrder(config, task)) {
          const attempt: AiAttempt = { provider: id, outcome: "skipped", kind: "budget", message: "the AI time budget of this cycle is used up" };
          attempts.push(attempt);
          opts.onAttempt?.(attempt);
        }
        throw new AiUnavailableError(task, attempts);
      }
      let heldBack = false;
      for (const id of resolveProviderOrder(config, task)) {
        const provider = providers.get(id);
        const noteAttempt = (attempt: AiAttempt): void => {
          attempts.push(attempt);
          opts.onAttempt?.(attempt);
        };
        const skip = (kind: AiProviderError["kind"], message: string): void => {
          noteAttempt({ provider: id, outcome: "skipped", kind, message });
          logger?.debug("ai provider skipped", { provider: id, task, kind });
        };
        if (opts.skipProviders?.includes(id)) {
          skip("timeout", "skipped: it timed out or was rate limited a moment ago");
          continue;
        }
        if (opts.requireWeb && !webCapable(id)) {
          skip("not_configured", "cannot search the web (this task needs claude-cli, codex-cli or anthropic)");
          continue;
        }
        const blocked = apiClosed(heldBack, id) ?? (await gate(id, task));
        if (blocked || !provider) {
          if (blocked) {
            heldBack ||= holdsBack(blocked);
            noteAttempt(toAttempt(id, blocked));
            logger?.debug("ai provider skipped", { provider: id, task, kind: blocked.kind, ...(blocked.guard ? { guard: blocked.guard.reason } : {}) });
          }
          continue;
        }
        const today = healthDay(now(), timeZone);

        await safely("count", (store) => store.noteRequest(id, now(), today));
        const calls: AiCallRecord[] = [];
        const flush = async (): Promise<number> => {
          let cost = 0;
          for (const call of calls) cost += await record(task, provider, call, opts.jobId, opts.webSearchCostUsd);
          return cost;
        };
        try {
          const taskConfig = config.tasks[task];
          const taskModel = opts.model ?? taskConfig.models?.[id];
          // A task's own output cap and API timeout (ai.yaml tasks.<task>); a timeout the caller passes wins
          const maxOutputTokens = opts.maxOutputTokens ?? taskConfig.max_output_tokens;
          const apiTimeoutMs = provider.kind === "api" && taskConfig.api_timeout_seconds !== undefined ? taskConfig.api_timeout_seconds * 1000 : undefined;
          const timeoutMs = opts.timeoutMs ?? apiTimeoutMs;
          const result = await provider.run(task, prompt, schema, {
            ...opts,
            ...(taskModel !== undefined ? { model: taskModel } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            onCall: (call) => {
              calls.push(call);
              opts.onCall?.(call);
            },
          });
          const costUsd = await flush();
          await safely("success", (store) => store.noteSuccess(id, now()));
          // the same name ai_usage records: codex's "codex-default" placeholder becomes the catalog's cli_default model
          const shown = attribute(provider.id, result.model, getCatalog()).model ?? result.model;
          return { value: result.value, provider: result.provider, model: shown, usage: { ...result.usage, costUsd } };
        } catch (error) {
          await flush();
          if (!(error instanceof AiProviderError)) throw error;
          if (error.kind === "aborted") throw error;
          // Only the subscription CLIs get a cross-process cooldown: their limits last for hours and are shared with the user.
          const coolingUntil = error.kind === "rate_limited" && provider.kind === "cli" ? cooldownUntil(error.message, now(), config.cooldown) : null;
          await safely("failure", (store) => store.noteFailure(id, now(), { kind: error.kind, message: error.message, coolingUntil }));
          if (coolingUntil) logger?.warn("ai provider cooling down", { provider: id, until: coolingUntil.toISOString() });
          if (error.kind === "auth" || error.kind === "not_configured") disabled.set(id, error.message);
          noteAttempt({
            provider: id,
            outcome: "failed",
            kind: error.kind,
            message: error.message,
            ...(coolingUntil && quota && isQuotaGuarded(id) ? { guard: { reason: "error", resumeAt: coolingUntil.toISOString() } satisfies AiQuotaGuardMark } : {}),
          });
          logger?.warn("ai provider failed, trying the next one", { provider: id, task, kind: error.kind, error: error.message });
        }
      }
      throw new AiUnavailableError(task, attempts);
    },
  };
}
