/**
 * The two fingerprints the `signals` step compares with what a job was processed with.
 *
 * - `rulesFingerprint`: everything the rule signals depend on besides the JD. A job whose stored hash differs is scanned
 *   again (and its AI review starts over).
 * - `signalsPrompt`: the AI prompt version (`signal_scans.ai_prompt_version`); a job reviewed with another version is
 *   reviewed again.
 *
 * Both are compatible with the tiers T1-T4: a catalog that can still be written as the old `signals` block (the five
 * default categories, same ids, kinds and order) is hashed in exactly the old shape, and the default AI categories keep
 * the `signals-v1` prompt. Upgrading therefore rescans nothing and sends nothing to the AI again. Names, icons, colours,
 * weights, `high_value` and (for the rules) the AI definitions are never part of the rules fingerprint.
 */
import { createHash } from "node:crypto";

import { signalsPromptSpec, type PromptCategory, type SignalsPromptSpec } from "@/lib/ai/prompts/signals";
import type { AmountCategory, InterestsConfig, KeywordCategory, PipelineConfig, SignalCategory, TagCategory } from "@/lib/config";

import { buildCatalog } from "./catalog";

/** `signals.kind` the tiers T2-T4 always gave their rule hits; a keyword category with another one cannot be written as a tier. */
const LEGACY_KEYWORD_KIND: Readonly<Record<string, string>> = { T2: "equity", T3: "competitive_pay", T4: "bonus" };
const LEGACY_IDS = ["T1", "T2", "T3", "T4", "tag"] as const;

function sha32(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** The pipeline.yaml salary settings the rule scan depends on (valuation-only settings are hashed as absent / empty, see `revalueSignals`). */
function salaryPart(pipeline: PipelineConfig) {
  // The settings that moved (fx_to_eur -> fx_pivot + fx_rates) or came from the packs (currency tokens) are left
  // out like the rates were, and the object keeps the key order it had, so the hash of a German config is unchanged
  const { periods_per_year, assume_annual_from, plausible_annual, plausible_per_period, description_context_patterns, context_window_chars, negative_context_patterns, negative_context_window_chars } = pipeline.salary;
  return {
    periods_per_year,
    fx_to_eur: {},
    assume_annual_from,
    plausible_annual,
    plausible_per_period,
    description_context_patterns,
    context_window_chars,
    negative_context_patterns,
    negative_context_window_chars,
    local_currencies: undefined,
    other_region_patterns: undefined,
    variable_patterns: undefined,
  };
}

/**
 * The old `signals` and `limits` blocks (interests.yaml v1, keys in the order its schema produced them), or null when
 * the categories are not exactly the five defaults with the extraction settings the tiers could express.
 */
function legacyShape(interests: Pick<InterestsConfig, "signals" | "limits">, marketCurrency: string): { signals: unknown; limits: unknown } | null {
  const categories = interests.signals.categories;
  if (categories.length !== LEGACY_IDS.length || categories.some((category, index) => category.id !== LEGACY_IDS[index])) return null;
  const [t1, t2, t3, t4, tag] = categories as [SignalCategory, SignalCategory, SignalCategory, SignalCategory, SignalCategory];
  if (t1.kind !== "amount" || t1.ai_confirm_only === true || tag.kind !== "tag") return null;
  const keyword = [t2, t3, t4];
  if (!keyword.every((category): category is KeywordCategory => category.kind === "keyword" && (category.default_kind ?? category.id.toLowerCase()) === LEGACY_KEYWORD_KIND[category.id])) return null;
  const [k2, k3, k4] = keyword as [KeywordCategory, KeywordCategory, KeywordCategory];
  // only T4 could wait for the AI
  if (k2.ai_confirm_only === true || k3.ai_confirm_only === true) return null;
  const amount: AmountCategory = t1;
  const tags: TagCategory = tag;
  const words = (category: KeywordCategory) => ({ keywords: category.keywords, patterns: category.patterns, exclude: category.exclude });
  const { per_category_max, ...limits } = interests.limits;
  return {
    signals: {
      T1: {
        patterns: amount.patterns,
        min_annual_eur: amount.amount.min_annual,
        // `market` is hashed as the currency it stands for, so a German config keeps its hash
        assume_currency: amount.amount.assume_currency === "market" ? marketCurrency : amount.amount.assume_currency,
        bonus_requires_at_least: amount.amount.bonus_requires_at_least,
        rough_fx_to_eur: amount.amount.rough_fx,
        exclude: amount.exclude,
      },
      T2: words(k2),
      T3: words(k3),
      T4: { ...words(k4), ai_confirm_only: k4.ai_confirm_only === true },
      benefit_tags: tags.tags,
      benefit_patterns: tags.tag_patterns.map((entry) => ({ name: entry.name, pattern: entry.pattern })),
    },
    limits: {
      quote_max_chars: limits.quote_max_chars,
      per_tier_max: per_category_max,
      tags_max: limits.tags_max,
      exclude_lookbehind_chars: limits.exclude_lookbehind_chars,
      ai_max_jd_chars: limits.ai_max_jd_chars,
      ai_review_without_candidates: limits.ai_review_without_candidates,
      ai_stop_after_failures: limits.ai_stop_after_failures,
    },
  };
}

/** What the rule stage reads of one category (no names, colours, weights, `high_value` or AI definitions). */
function extractionPart(category: SignalCategory, marketCurrency: string): unknown {
  switch (category.kind) {
    case "amount": {
      // `min_annual_eur` / `rough_fx_to_eur`: hashed under the old names, so the rename rescans nothing
      const { other_region_weight: _otherRegionWeight, min_annual, rough_fx, ...rest } = category.amount;
      void _otherRegionWeight;
      const amount = { min_annual_eur: min_annual, ...rest, assume_currency: rest.assume_currency === "market" ? marketCurrency : rest.assume_currency, rough_fx_to_eur: rough_fx };
      return { id: category.id, kind: category.kind, ai_confirm_only: category.ai_confirm_only === true, patterns: category.patterns, exclude: category.exclude, amount };
    }
    case "keyword":
      return { id: category.id, kind: category.kind, ai_confirm_only: category.ai_confirm_only === true, keywords: category.keywords, patterns: category.patterns, exclude: category.exclude, default_kind: category.default_kind ?? null };
    case "tag":
      return { id: category.id, kind: category.kind, tags: category.tags, tag_patterns: category.tag_patterns };
  }
}

/**
 * Hash of everything the rule signals depend on besides the JD: the active categories' vocabulary and extraction
 * settings, the limits and the salary parsing config. Settings that only change what a found amount is worth or how it
 * is weighted (EUR rates, local currencies, other-region phrases, `other_region_weight`) are left out: a rescan would
 * throw away every AI review for them; `revalueSignals` updates the stored amounts in place instead.
 */
/** The limits that change what the rules extract: `preview_jobs` and `preview_time_budget_ms` (the /interests preview only) are left out, so they never trigger a rescan. */
function extractionLimits(limits: InterestsConfig["limits"]): Omit<InterestsConfig["limits"], "preview_jobs" | "preview_time_budget_ms"> {
  const { preview_jobs: previewJobs, preview_time_budget_ms: previewBudget, ...rest } = limits;
  void previewJobs;
  void previewBudget;
  return rest;
}

export function rulesFingerprint(interests: Pick<InterestsConfig, "signals" | "limits">, pipeline: PipelineConfig): string {
  const salary = salaryPart(pipeline);
  const legacy = legacyShape(interests, pipeline.market.currency);
  if (legacy) return sha32({ signals: legacy.signals, limits: legacy.limits, salary });
  return sha32({ version: 2, categories: interests.signals.categories.map((category) => extractionPart(category, pipeline.market.currency)), limits: extractionLimits(interests.limits), salary });
}

/** The AI categories (amount and keyword) as the prompt describes them. */
export function promptCategories(interests: Pick<InterestsConfig, "signals">): PromptCategory[] {
  return buildCatalog(interests).categories.flatMap((category): PromptCategory[] =>
    category.kind === "tag" ? [] : [{ id: category.id, kind: category.kind, definition: category.ai_definition, confirmOnly: category.ai_confirm_only === true }],
  );
}

/** Prompt version, system text and output schema for the current categories; null when no category goes to the AI. */
export function signalsPrompt(interests: Pick<InterestsConfig, "signals">): SignalsPromptSpec | null {
  return signalsPromptSpec(promptCategories(interests));
}
