/**
 * The part of "may this provider be tried now?" that every process reads alike: the cooldown and request counter of
 * `runtime_state`, the usage window and the API spend. It says nothing about what this process can start (an installed CLI, a
 * key in its environment): the web and the runner have neither, yet must know whether the ai-worker would run a request.
 */
import { monthKey } from "@/lib/channels/budget";
import type { AiConfig } from "@/lib/config";
import { AI_PROVIDER_CONFIG_KEYS } from "@/lib/config/ai-options";

import type { AiProviderError, AiQuotaGuardMark } from "./errors";
import { healthDay, isCoolingDown, requestsOn, type AiHealthStore, type ProviderHealth } from "./health";
import { evaluateQuota, isQuotaGuarded, quotaPolicy, type AiQuotaStore, type QuotaEvaluation, type QuotaPolicy } from "./quota-guard";
import type { AiProviderId } from "./types";
import { API_PROVIDER_IDS } from "./usage";

export interface GateBlock {
  kind: AiProviderError["kind"];
  message: string;
  guard?: AiQuotaGuardMark;
}

export const gateClock = (at: Date, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }).format(at);

/** Cooling down after an error, or over the provider's daily request cap. */
export function healthBlock(config: AiConfig, id: AiProviderId, state: ProviderHealth | null, at: Date, timeZone: string, quotaActive: boolean): GateBlock | null {
  if (!state) return null;
  if (isCoolingDown(state, at)) {
    const until = state.coolingUntil as Date;
    return {
      kind: "rate_limited",
      message: `cooling down until ${gateClock(until, timeZone)} (${state.lastErrorMessage ?? "limit reached"})`.slice(0, 400),
      // a limit the provider reported is the usage cap's third reason (it shows and alerts as such)
      ...(quotaActive && isQuotaGuarded(id) ? { guard: { reason: "error", resumeAt: until.toISOString() } satisfies AiQuotaGuardMark } : {}),
    };
  }
  const cap = config.providers[AI_PROVIDER_CONFIG_KEYS[id]].daily_request_cap;
  if (cap > 0 && requestsOn(state, healthDay(at, timeZone)) >= cap) return { kind: "budget", message: `daily request cap of ${cap} reached` };
  return null;
}

export function windowBlock(evaluation: QuotaEvaluation, policy: QuotaPolicy, timeZone: string): GateBlock | null {
  if (evaluation.level !== "hard") return null;
  const back = evaluation.resumeAt ? `; back around ${gateClock(evaluation.resumeAt, timeZone)}` : "";
  return {
    kind: "budget",
    message: `Job Radar's own usage cap reached (${evaluation.windowRequests} calls in ${policy.windowHours}h, cap ${policy.hardRequests})${back}`,
    guard: { reason: "window", resumeAt: evaluation.resumeAt?.toISOString() ?? null },
  };
}

export function apiBudgetBlock(config: AiConfig, spent: number): GateBlock | null {
  return spent >= config.monthly_api_budget_usd ? { kind: "budget", message: `monthly API budget of $${config.monthly_api_budget_usd} reached ($${spent.toFixed(4)} spent)` } : null;
}

export interface SharedStateStores {
  health: Pick<AiHealthStore, "get">;
  quota: Pick<AiQuotaStore, "getState" | "usageSince">;
  usage: { apiSpendUsd(month: string, timeZone: string): Promise<number> };
}

/**
 * The shared-state checks of `id`, read only: nothing is written, and a value that cannot be read lets the provider through,
 * as in the router (the ai-worker decides in the end). Provider switched off is the caller's config check.
 */
export async function sharedStateGate(config: AiConfig, id: AiProviderId, stores: SharedStateStores, now: Date, timeZone: string): Promise<GateBlock | null> {
  const read = async <T>(load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load();
    } catch {
      return null;
    }
  };
  const blocked = healthBlock(config, id, await read(() => stores.health.get(id)), now, timeZone, true);
  if (blocked) return blocked;
  if (isQuotaGuarded(id)) {
    const policy = quotaPolicy(config, id);
    if (policy) {
      const evaluated = await read(async () => {
        const rows = policy.hardRequests > 0 ? await stores.quota.usageSince(id, new Date(now.getTime() - policy.windowHours * 3_600_000)) : [];
        return evaluateQuota(rows, policy, now, await stores.quota.getState(id));
      });
      const capped = evaluated && windowBlock(evaluated, policy, timeZone);
      if (capped) return capped;
    }
  }
  if (API_PROVIDER_IDS.includes(id)) {
    const spent = await read(() => stores.usage.apiSpendUsd(monthKey(now, timeZone), timeZone));
    if (spent !== null) return apiBudgetBlock(config, spent);
  }
  return null;
}

/**
 * Could any of `order` run now, as far as shared state says? Keeps the router's rule that once the usage cap held a subscription
 * CLI back, the paid API tier is not tried unless `quota_guard.fallthrough_to_api` allows it.
 */
export async function anyProviderOpen(config: AiConfig, order: readonly AiProviderId[], stores: SharedStateStores, now: Date, timeZone: string): Promise<boolean> {
  let heldBack = false;
  for (const id of order) {
    if (heldBack && !config.quota_guard.fallthrough_to_api && API_PROVIDER_IDS.includes(id)) continue;
    const block = await sharedStateGate(config, id, stores, now, timeZone);
    if (!block) return true;
    heldBack ||= block.guard?.reason === "window" || block.guard?.reason === "cycle_cap";
  }
  return false;
}
