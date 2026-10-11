import type { InterestsConfig, PipelineConfig } from "@/lib/config";
import type { JobSalary } from "@/lib/domain/types";

import { normalizeAmount } from "./amount";
import { buildCatalog } from "./catalog";
import { locateQuote } from "./quote";
import { amountKind, type SignalAmount, type SignalDraft } from "./types";

/** Amount signals that only exist because of the job's normalized salary carry this in their value. */
export function isSalaryDerived(signal: { quoteSource?: string | undefined; value?: unknown }): boolean {
  if (signal.quoteSource === "structured") return true;
  const value = signal.value;
  return typeof value === "object" && value !== null && (value as { fromSalary?: unknown }).fromSalary === true;
}

/**
 * The amount signal of a job's normalized salary: the source's own field makes a
 * signal as well as a sentence of the JD. A salary from a channel field or the channel's salary text
 * is quoted with that text (`quoteSource: "structured"`, C7: the quote is the source's, not the JD's);
 * a salary read from the description is quoted from the description. A salary that needs review, has no
 * currency or period, or is below the amount category's `amount.min_annual` makes none; without an amount
 * category there is none either. The bonus floor is applied later, like for every amount (`signalBonus`).
 */
export function salaryDraft(salary: JobSalary | null, description: string, interests: Pick<InterestsConfig, "signals" | "limits">, pipeline: PipelineConfig): SignalDraft | null {
  const category = buildCatalog(interests).amount;
  if (!category) return null;
  if (!salary || salary.qualityStatus !== "valid" || salary.period === null || salary.currency === null) return null;
  const raw = salary.raw.trim();
  if (raw === "") return null;
  const amount = normalizeAmount(
    { min: salary.min, max: salary.max, period: salary.period, currency: salary.currency, periodAssumed: salary.periodAssumed },
    pipeline,
    { minAnnualEur: category.amount.min_annual, assumeCurrency: null, salaryContext: true, description },
    raw,
  );
  if (!amount) return null;
  const value: SignalAmount = { ...amount, fromSalary: true };
  const common = { tier: category.id, kind: amountKind(value), value, extractor: "rule" as const };
  if (salary.origin === "description") {
    const located = locateQuote(description, raw);
    return located ? { ...common, quote: located.quote, quoteOffset: located.offset, quoteSource: "description" } : null;
  }
  return { ...common, quote: raw.slice(0, interests.limits.quote_max_chars), quoteOffset: null, quoteSource: "structured" };
}

/** `inner` states nothing the salary range `outer` does not already state (same currency, every bound inside). */
function covers(outer: SignalAmount, inner: SignalAmount): boolean {
  if (outer.currency !== inner.currency) return false;
  const bounds = [inner.min, inner.max].filter((v): v is number => v !== null);
  if (bounds.length === 0) return false;
  return bounds.every((v) => (outer.min === null || v >= outer.min) && (outer.max === null || v <= outer.max));
}

const sameAmount = (a: SignalAmount, b: SignalAmount): boolean => a.currency === b.currency && a.min === b.min && a.max === b.max;

/** The amount of a draft (only amount signals carry one), or null. */
const amountOf = (draft: SignalDraft): SignalAmount | null => draft.value;

/**
 * The final signals of a job: the salary's amount signal first, then `others` without the amounts that say nothing
 * new (an amount inside the salary's range, or the same amount again: a job that names "up to
 * €70,000" in three places has one amount signal). Amounts that differ (an OTE the field does not
 * state) and every other category stay.
 */
export function withSalarySignal<T extends SignalDraft>(salarySignal: SignalDraft | null, others: readonly T[]): Array<SignalDraft | T> {
  const out: Array<SignalDraft | T> = salarySignal ? [salarySignal] : [];
  const kept: SignalAmount[] = salarySignal ? [amountOf(salarySignal)].filter((a): a is SignalAmount => a !== null) : [];
  const salaryAmount = kept[0];
  for (const draft of others) {
    const amount = amountOf(draft);
    if (amount) {
      const sameSentence =
        salarySignal?.quoteSource === "description" && salarySignal.quoteOffset !== null && draft.quoteOffset !== null && draft.quoteOffset < salarySignal.quoteOffset + salarySignal.quote.length && draft.quoteOffset + draft.quote.length > salarySignal.quoteOffset;
      if (sameSentence || (salaryAmount && covers(salaryAmount, amount)) || kept.some((k) => sameAmount(k, amount))) continue;
      kept.push(amount);
    }
    out.push(draft);
  }
  return out;
}
