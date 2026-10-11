import type { AiSignal, AiSignalsOutput, PromptCandidate } from "@/lib/ai/prompts/signals";
import type { InterestsConfig, PipelineConfig } from "@/lib/config";
import { compileRules } from "@/lib/pipeline/rules";
import { parseNumberToken } from "@/lib/pipeline/salary";

import { SIGNAL_KIND_PATTERN } from "@/lib/config/schemas/interests";

import { normalizeAmount } from "./amount";
import { buildCatalog } from "./catalog";
import { locateQuote } from "./quote";
import type { RuleCandidate } from "./rules";
import { amountKind, type SignalAmount, type SignalDraft } from "./types";

/** A candidate as the AI sees it: the rule candidates of the AI categories (amount and keyword) numbered from 1. */
export interface NumberedCandidate {
  id: number;
  candidate: RuleCandidate;
}

export function numberCandidates(candidates: readonly RuleCandidate[]): NumberedCandidate[] {
  return candidates.filter((c) => c.isTag !== true).map((candidate, index) => ({ id: index + 1, candidate }));
}

function describeAmount(amount: NonNullable<RuleCandidate["value"]>): string {
  const low = amount.min === null ? "" : String(amount.min);
  const high = amount.max === null ? "" : String(amount.max);
  const range = low !== "" && high !== "" && low !== high ? `${low}-${high}` : low !== "" && high !== "" ? low : high !== "" ? `up to ${high}` : `from ${low}`;
  return `${range} ${amount.currency} per year`;
}

export function toPromptCandidates(numbered: readonly NumberedCandidate[]): PromptCandidate[] {
  return numbered.map(({ id, candidate }) => ({
    id,
    tier: candidate.tier,
    quote: candidate.quote,
    parsed: candidate.value ? describeAmount(candidate.value) : null,
  }));
}

export interface ReviewStats {
  /** Candidates the AI kept (`ai_confirm_only` candidates that became signals count here too). */
  confirmed: number;
  rejected: number;
  /** Signals the AI found that the rules did not. */
  added: number;
  /** Rule candidates the AI did not mention; they stay as the rules found them (`ai_confirm_only` candidates: dropped). */
  unreviewed: number;
  /** Dropped because the quote is not in the JD (C7) or is too long. */
  droppedQuote: number;
  /** Amount signals dropped because the amount is missing, not found in the quote, or not a plausible salary. */
  droppedAmount: number;
}

/** A signal of the JD text: its quote has a place in the JD. */
export type DescriptionDraft = SignalDraft & { quoteOffset: number };

export interface ReviewResult {
  signals: DescriptionDraft[];
  stats: ReviewStats;
}

/** Every number a text states, as written and with a thousand factor ("90k" → 90 and 90000). */
function numbersIn(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(/\d[\d.,'  ]*\d|\d/gu)) {
    for (const hasK of [false, true]) {
      const value = parseNumberToken(match[0], hasK);
      if (value !== null) values.push(value, value * 1000);
    }
  }
  return values;
}

/** The AI's amount is accepted only when its figures can be read from the quote itself (no invented numbers, C3). */
function figuresAppearIn(quote: string, amount: { min: number | null; max: number | null }): boolean {
  const available = numbersIn(quote);
  return [amount.min, amount.max].every((v) => v === null || available.some((n) => Math.abs(n - v) < 0.5));
}

function sameAmount(a: SignalAmount | null, b: SignalAmount | null): boolean {
  return a !== null && b !== null && a.min === b.min && a.max === b.max && a.currency === b.currency;
}

/**
 * Merge the AI's answer into the rule candidates of one JD:
 * - a rejected candidate is dropped; a confirmed one stays (an amount gets the AI's normalized amount);
 * - a candidate the AI does not mention stays as the rules found it, except `ai_confirm_only` ones;
 * - the AI's own signals are added only if their quote is verbatim in the JD (a whitespace-flexible
 *   match is rewritten to the JD's own text) and, for the amount category, the figures appear in the quote and the
 *   amount is a plausible salary.
 * Signals of a category that is not an active AI category are ignored (the run's schema already refuses them).
 * Pure: no database, no AI. Tags are not part of this (the caller keeps the rule tags).
 */
export function mergeAiReview(args: {
  description: string;
  candidates: readonly NumberedCandidate[];
  output: AiSignalsOutput;
  interests: Pick<InterestsConfig, "signals" | "limits">;
  pipeline: PipelineConfig;
}): ReviewResult {
  const { description, candidates, output, interests, pipeline } = args;
  const catalog = buildCatalog(interests);
  const amountCategory = catalog.amount;
  const aiIds = new Set(catalog.aiIds);
  const salaryContext = compileRules(pipeline).salaryContext;
  const maxChars = interests.limits.quote_max_chars;
  const stats: ReviewStats = { confirmed: 0, rejected: 0, added: 0, unreviewed: 0, droppedQuote: 0, droppedAmount: 0 };
  const byId = new Map(candidates.map((c) => [c.id, c.candidate]));
  const rejected = new Set(output.rejected.filter((id) => byId.has(id)));
  stats.rejected = rejected.size;
  const mentioned = new Set<number>();
  /** Drafts keyed by "category:offset" so one sentence yields one signal per category. */
  const drafts = new Map<string, DescriptionDraft>();
  const put = (draft: DescriptionDraft): boolean => {
    const key = `${draft.tier}:${draft.quoteOffset}`;
    if (drafts.has(key)) return false;
    drafts.set(key, draft);
    return true;
  };
  const overlaps = (tier: string, offset: number, length: number): boolean =>
    [...drafts.values()].some((d) => d.tier === tier && offset < d.quoteOffset + d.quote.length && offset + length > d.quoteOffset);

  const amountOf = (signal: AiSignal, quote: string): SignalAmount | null => {
    const stated = signal.amount;
    if (!amountCategory || !stated || (stated.min === null && stated.max === null)) return null;
    if (!figuresAppearIn(quote, stated)) return null;
    const currency = stated.currency && /^[A-Za-z]{3}$/.test(stated.currency) ? stated.currency.toUpperCase() : null;
    return normalizeAmount(
      { min: stated.min, max: stated.max, period: stated.period, currency, periodAssumed: false },
      pipeline,
      {
        minAnnualEur: amountCategory.amount.min_annual,
        assumeCurrency: amountCategory.amount.assume_currency,
        salaryContext: salaryContext.some((p) => p.test(quote)),
      },
      quote,
    );
  };

  // 1. the AI's signals
  const replaced = new Set<number>();
  for (const signal of output.signals) {
    if (!aiIds.has(signal.tier)) continue;
    const isAmount = signal.tier === amountCategory?.id;
    const candidate = signal.candidate === null ? undefined : byId.get(signal.candidate);
    if (signal.candidate !== null && rejected.has(signal.candidate)) continue; // contradictory answer: rejected wins
    const sameTier = candidate !== undefined && candidate.tier === signal.tier;

    let quote: string;
    let offset: number;
    if (candidate && sameTier) {
      quote = candidate.quote;
      offset = candidate.quoteOffset;
    } else {
      const located = locateQuote(description, signal.quote);
      if (!located || located.quote.length > maxChars) {
        stats.droppedQuote += 1;
        continue; // a candidate it pointed to stays as the rules found it
      }
      quote = located.quote;
      offset = located.offset;
    }

    let value: SignalAmount | null = null;
    if (isAmount) {
      value = amountOf(signal, quote);
      if (value === null) {
        // a confirmed amount candidate keeps the amount the rules read; a new amount signal needs a usable amount
        if (candidate && sameTier && candidate.value) value = candidate.value;
        else {
          stats.droppedAmount += 1;
          continue;
        }
      }
    }

    // kinds the AI may name for a keyword category ("signing_bonus"); anything else falls back to the category default
    const aiKind = SIGNAL_KIND_PATTERN.test(signal.kind) ? signal.kind : null;
    const kind = value ? amountKind(value) : (aiKind ?? catalog.kindOf(signal.tier));
    const asRules = candidate !== undefined && sameTier && !candidate.aiConfirmOnly && (!isAmount || sameAmount(candidate.value, value));
    const draft: DescriptionDraft = {
      tier: signal.tier,
      kind: asRules && candidate ? candidate.kind : kind,
      value,
      quote,
      quoteOffset: offset,
      extractor: asRules ? "rule" : "ai",
    };

    if (candidate && signal.candidate !== null) {
      mentioned.add(signal.candidate);
      if (!sameTier) replaced.add(signal.candidate);
    } else if (overlaps(signal.tier, offset, quote.length)) {
      continue; // the rules found this text already
    }
    if (put(draft)) {
      if (candidate && sameTier) stats.confirmed += 1;
      else stats.added += 1;
    }
  }

  // 2. rule candidates the AI did not decide on stay as the rules found them (the broad ones need the AI's yes)
  for (const { id, candidate } of candidates) {
    if (rejected.has(id) || replaced.has(id) || candidate.aiConfirmOnly) continue;
    if (!mentioned.has(id)) stats.unreviewed += 1;
    put({ tier: candidate.tier, kind: candidate.kind, value: candidate.value, quote: candidate.quote, quoteOffset: candidate.quoteOffset, extractor: "rule" });
  }

  const perCategory = new Map<string, number>();
  const signals = [...drafts.values()]
    .sort((a, b) => catalog.order(a.tier) - catalog.order(b.tier) || a.quoteOffset - b.quoteOffset)
    .filter((d) => {
      const n = (perCategory.get(d.tier) ?? 0) + 1;
      perCategory.set(d.tier, n);
      return n <= interests.limits.per_category_max;
    });
  return { signals, stats };
}
