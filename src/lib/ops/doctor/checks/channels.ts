/** Per-channel state (circuit, keys, budget, free allowance), the LinkedIn cascade and the paid budgets. */
import path from "node:path";

import { CHANNEL_REQUIRED_ENV } from "@/lib/sources/required-env";
import type { SourceCard } from "@/lib/sources/view";

import { fail, joinList, merge, ok, ratio, type Piece } from "../helpers";
import { loadSources } from "../shared";
import { type CheckOutcome, type DoctorCheck, type DoctorContext } from "../types";

export { CHANNEL_REQUIRED_ENV };

/** The variables of channel `id` that are not set; empty = nothing missing (or the channel needs none). */
export function missingEnv(ctx: DoctorContext, id: string): string[] {
  return (CHANNEL_REQUIRED_ENV[id] ?? []).filter((name) => (ctx.env[name] ?? "").trim() === "");
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

function budgetPiece(ctx: DoctorContext, label: string, used: number, limit: number): Piece | null {
  const { t } = ctx;
  const share = ratio(used, limit);
  if (share === null) return null;
  const thresholds = ctx.config.notify.alerts.budget_thresholds;
  const warnAt = Math.min(...thresholds);
  const detail = t("checks.channels.budget", { label, used: usd(used), limit: usd(limit), percent: Math.round(share * 100) });
  if (share >= 1) return { status: "fail", detail: t("checks.channels.budgetExhausted", { detail }), hint: t("checks.channels.budgetExhaustedHint") };
  if (share >= warnAt) return { status: "warn", detail, hint: t("checks.channels.budgetNear") };
  return { status: "ok", detail };
}

function channelResult(ctx: DoctorContext, card: SourceCard): CheckOutcome {
  const { t } = ctx;
  const spec = { id: `channels.${card.id}`, group: "channels", title: t("checks.channels.channelTitle", { id: card.id }) } as const;
  const pieces: Piece[] = [];

  const missing = missingEnv(ctx, card.id);
  if (missing.length > 0 || card.notConfigured) {
    const names = missing.length > 0 ? joinList(ctx, missing) : t("checks.channels.credentials");
    pieces.push({ status: "warn", detail: t("checks.channels.missingEnv", { names }), hint: t("checks.channels.missingEnvHint", { names }) });
  }
  if (!card.registered) {
    pieces.push({ status: "warn", detail: t("checks.channels.notRegistered"), hint: t("checks.channels.notRegisteredHint") });
  }
  if (card.circuit !== null) {
    if (card.circuit.state === "open") {
      const values = { failures: card.circuit.consecutiveFailures, error: card.circuit.lastErrorCode ?? t("common.unknown") };
      const detail = card.circuit.openUntil === null ? t("checks.channels.circuitOpen", values) : t("checks.channels.circuitOpenUntil", { ...values, until: card.circuit.openUntil.toISOString() });
      pieces.push({ status: "warn", detail, hint: t("checks.channels.circuitOpenHint") });
    } else if (card.circuit.state === "half_open") {
      pieces.push({ status: "ok", detail: t("checks.channels.halfOpen") });
    }
  }
  const latest = card.latestCycleRuns;
  if (latest !== null && latest.runs > 0 && latest.succeeded === 0 && latest.failed > 0) {
    pieces.push({ status: "warn", detail: t("checks.channels.lastCycleFailed", { count: latest.failed }), hint: t("checks.channels.lastCycleFailedHint") });
  }
  if (card.registered && card.lastSuccessAt === null && card.usage.activity.runs > 0) {
    pieces.push({ status: "warn", detail: t("checks.channels.neverSucceeded"), hint: t("checks.channels.neverSucceededHint") });
  }

  const money = budgetPiece(ctx, t("checks.channels.spentThisMonth"), card.usage.usd, card.usage.budgetUsd);
  if (money !== null) pieces.push(money);
  const free = card.usage.freeRecords;
  if (free > 0) {
    const share = card.usage.records / free;
    const detail = t("checks.channels.freeAllowance", { used: card.usage.records, free });
    if (share >= 1) pieces.push({ status: "warn", detail: t("checks.channels.freeUsedUp", { detail }), hint: t("checks.channels.freeUsedUpHint") });
    else if (share >= Math.min(...ctx.config.notify.alerts.budget_thresholds)) pieces.push({ status: "warn", detail: t("checks.channels.freeNear", { detail }), hint: t("checks.channels.freeNearHint") });
    else pieces.push({ status: "ok", detail });
  }
  const activity = card.usage.activity;
  if (activity.runs > 0) pieces.push({ status: "ok", detail: t("checks.channels.activity", { runs: activity.runs, fetched: activity.fetched, new: activity.newCount }) });
  if (pieces.length === 0) pieces.push({ status: "ok", detail: t("checks.channels.quiet") });
  return merge(ctx, spec, pieces);
}

export const channelsCheck: DoctorCheck = {
  id: "channels.each",
  group: "channels",
  async run(ctx) {
    const { t } = ctx;
    const sources = await loadSources(ctx);
    const enabled = sources.cards.filter((card) => card.enabled);
    const disabled = sources.cards.filter((card) => !card.enabled);
    const results: CheckOutcome[] = [];
    if (enabled.length === 0) {
      results.push(fail({ id: "channels.enabled", group: "channels" }, t("checks.channels.enabled.none"), t("checks.channels.enabled.noneHint")));
    }
    for (const card of enabled) results.push(channelResult(ctx, card));
    if (disabled.length > 0) {
      results.push(ok({ id: "channels.disabled", group: "channels" }, t("checks.channels.disabled.list", { count: disabled.length, ids: joinList(ctx, disabled.map((c) => c.id)) })));
    }
    return results;
  },
};

const linkedinSpec = { id: "channels.linkedin", group: "channels" } as const;

export const linkedinCheck: DoctorCheck = {
  ...linkedinSpec,
  async run(ctx) {
    const { t } = ctx;
    const sources = await loadSources(ctx);
    const entries = sources.cascade.entries;
    // set up = switched on and not missing a key; usable = set up, registered and not paused by its circuit breaker
    const setUp = entries.filter((entry) => entry.enabled && missingEnv(ctx, entry.id).length === 0 && !entry.notConfigured);
    const usable = setUp.filter((entry) => entry.circuit !== "open" && sources.cards.find((c) => c.id === entry.id)?.registered === true);
    const pieces: Piece[] = [];
    const order = entries.map((e) => e.id).join(" → ");
    if (setUp.length === 0) {
      // LinkedIn is optional: a new install has the paid channels on without keys and the scraping ones off.
      // The per-channel lines already name the missing keys; this is not a failure.
      pieces.push({ status: "ok", detail: t("checks.channels.linkedin.noneSetUp", { order }) });
    } else if (usable.length === 0) {
      pieces.push({ status: "fail", detail: t("checks.channels.linkedin.noneUsable", { order }), hint: t("checks.channels.linkedin.noneUsableHint") });
    } else {
      pieces.push({ status: "ok", detail: t("checks.channels.linkedin.usable", { order, usable: joinList(ctx, usable.map((e) => e.id)) }) });
    }
    const session = ctx.config.channels.linkedin.session;
    if (session.enabled) {
      const dir = path.resolve(ctx.appRoot, ctx.settings.linkedin_auth_dir);
      const names = ((await ctx.probes.listDir(dir)) ?? []).filter((name) => !name.startsWith("."));
      pieces.push(
        names.length > 0
          ? { status: "ok", detail: t("checks.channels.linkedin.sessionFiles", { dir: ctx.settings.linkedin_auth_dir, count: names.length }) }
          : { status: "warn", detail: t("checks.channels.linkedin.sessionMissing", { dir: ctx.settings.linkedin_auth_dir }), hint: t("checks.channels.linkedin.sessionMissingHint") },
      );
    } else {
      pieces.push({ status: "ok", detail: t("checks.channels.linkedin.sessionOff") });
    }
    return merge(ctx, linkedinSpec, pieces);
  },
};

const paidSpec = { id: "budget.paid", group: "channels" } as const;
const aiBudgetSpec = { id: "budget.ai_api", group: "channels" } as const;

export const budgetChecks: DoctorCheck = {
  id: "budget.all",
  group: "channels",
  async run(ctx) {
    const { t } = ctx;
    const sources = await loadSources(ctx);
    const results: CheckOutcome[] = [];
    const paid = budgetPiece(ctx, t("checks.budget.paid.label"), sources.paid.usedUsd, sources.paid.capUsd);
    results.push(
      merge(ctx, paidSpec, [
        paid ?? { status: sources.paid.usedUsd > 0 ? "fail" : "ok", detail: t("checks.budget.paid.notAllowed", { cap: usd(sources.paid.capUsd), used: usd(sources.paid.usedUsd) }), hint: t("checks.budget.paid.notAllowedHint") },
      ]),
    );
    const ai = budgetPiece(ctx, t("checks.budget.ai_api.label"), sources.ai.apiSpendUsd, sources.ai.budgetUsd);
    results.push(merge(ctx, aiBudgetSpec, [ai ?? { status: sources.ai.apiSpendUsd > 0 ? "fail" : "ok", detail: t("checks.budget.ai_api.notAllowed", { used: usd(sources.ai.apiSpendUsd) }), hint: t("checks.budget.ai_api.notAllowedHint") }]));
    return results;
  },
};

export const CHANNEL_CHECKS: readonly DoctorCheck[] = [channelsCheck, linkedinCheck, budgetChecks];
