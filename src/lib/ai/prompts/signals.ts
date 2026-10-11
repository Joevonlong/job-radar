import { createHash } from "node:crypto";

import { z } from "zod";

import type { AiPrompt } from "../types";

/**
 * The prompt is made from the signal categories of interests.yaml (their `ai_definition`s) and its output schema
 * names their ids. The five default categories (the tiers T1-T4 as they always were) keep the original text
 * `LEGACY_SYSTEM` and the version `signals-v1` word for word, so upgrading does not send every job to the AI again.
 * Any other set of AI categories gets `signals-v2-<hash>`: jobs reviewed with an older version are reviewed again
 * (`signal_scans.ai_prompt_version`), within the per-cycle limit.
 */
export const LEGACY_SIGNALS_PROMPT_VERSION = "signals-v1";

const AMOUNT_PERIODS = ["year", "month", "week", "day", "hour"] as const;

/** The figures of an amount signal exactly as the JD states them; the code converts periods and currencies. */
const amountSchema = z.object({
  /** Lower bound, number only ("90k" → 90000); null for "up to X". */
  min: z.number().nullable(),
  /** Upper bound; null for "from X". Equal to `min` for a single figure. */
  max: z.number().nullable(),
  /** ISO 4217 code as stated by the JD ("€" → EUR); null when the JD names no currency. */
  currency: z.string().nullable(),
  /** The period the figures are stated for; null when the JD names none. */
  period: z.enum(AMOUNT_PERIODS).nullable(),
});

/** The output schema for a set of AI categories (amount and keyword ids, in order): `tier` must be one of them. */
export function buildSignalsSchema(ids: readonly [string, ...string[]]) {
  const signalSchema = z.object({
    /** The category id. */
    tier: z.enum(ids),
    /** Short snake_case label, e.g. "salary_range", "equity", "competitive_pay", "signing_bonus". */
    kind: z.string(),
    /** Verbatim text copied from the JD. */
    quote: z.string(),
    /** Id of the candidate this signal confirms; null for a signal the rules did not find. */
    candidate: z.number().int().nullable(),
    /** Only for the amount category; null for the others. */
    amount: amountSchema.nullable(),
  });
  return z.object({
    /** Every real signal: the confirmed candidates and the ones you found yourself. */
    signals: z.array(signalSchema),
    /** Ids of the candidates that are NOT a pay signal. */
    rejected: z.array(z.number().int()),
  });
}

/** What the code reads from an answer, whatever the categories (the schema of the run checked `tier`). */
export interface AiSignal {
  tier: string;
  kind: string;
  quote: string;
  candidate: number | null;
  amount: z.infer<typeof amountSchema> | null;
}
export interface AiSignalsOutput {
  signals: AiSignal[];
  rejected: number[];
}

export interface PromptCandidate {
  id: number;
  /** Category id. */
  tier: string;
  quote: string;
  /** Amount category: what the rules read from the sentence, e.g. "80000-120000 EUR per year". */
  parsed: string | null;
}

/** An AI category as the prompt describes it. */
export interface PromptCategory {
  id: string;
  kind: "amount" | "keyword";
  /** `ai_definition` (English). */
  definition: string;
  /** `ai_confirm_only`: part of the version (it changes which candidates count), not of the text. */
  confirmOnly: boolean;
}

export interface SignalsPromptInput {
  title: string;
  description: string;
  candidates: readonly PromptCandidate[];
  /** Longest quote the code will accept. */
  quoteMaxChars: number;
  /** The JD is cut in the middle beyond this length. */
  maxJdChars: number;
}

/** The prompt the tiers T1-T4 always had. Kept word for word: see `signalsPromptSpec`. */
export const LEGACY_SYSTEM = `You extract compensation signals from one job description (JD) for a job seeker who wants to find well-paid jobs.

Signal tiers (only compensation offered to the person who gets hired):
- T1: a concrete salary figure or range for the role (base salary, "€85,000-105,000", "up to 120k", "€7,200 per month"). Not company revenue, funding, prices, perks worth a fixed sum (e.g. a pension contribution or a voucher), or referral/relocation payments.
- T2: equity-like compensation: stock options, ESOP/VSOP, RSUs, employee shares, virtual shares, employee participation programmes. Not "diversity, equity and inclusion", private equity, or investor names.
- T3: the JD says in words that pay is good: "competitive salary", "above-market pay", "attractive compensation", "überdurchschnittliche Vergütung". Not generic "competitive market" or "competitive benefits" without pay.
- T4: other money for the employee: bonus, signing bonus, 13th salary, profit sharing, variable pay. Not "bonus points if you know X", "a bonus if you have X", or referral bonuses.

Rules:
- The user message lists CANDIDATES found by keyword rules, each with an id. For each candidate decide: it is a real signal (include it in "signals" with its id in "candidate"), or it is not (put its id in "rejected"). You may change its tier.
- Also add signals the rules missed (candidate: null), using the same tiers and rules.
- "quote" must be copied character for character from the JD: one sentence or fragment that contains the evidence, at most the stated length. Never paraphrase, translate or fix it. A signal without an exact quote is discarded.
- T1 only: fill "amount" with the figures exactly as written, as plain numbers ("90k" → 90000, "85.000" → 85000), the currency as ISO code (€ → EUR) or null if none is written, and the period the figures are stated for ("per month" → month; "p.a." or annual → year) or null if not written. Use min and max for a range; "up to X" → min null, max X; "from X" → min X, max null; a single figure → min = max. Do NOT convert currencies or periods yourself and do not add up several figures ("€90k + equity" is T1 90000 and a separate T2 signal). If the JD gives several salary figures for different roles or countries, include each as its own T1 signal.
- For tiers other than T1 set "amount" to null.
- If the JD has no signals, return {"signals": [], "rejected": [...]}.
- Reply with the JSON object only.`;

/** The JD, cut in the middle when longer than `max` (pay information tends to sit at the start and the end). */
export function truncateJd(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... text omitted ...]\n${text.slice(text.length - tail)}`;
}

/** The ids, kinds and definitions of the five default categories, as `LEGACY_SYSTEM` lists them. */
const LEGACY_LINE = /^- (T[1-4]): (.*)$/;
const LEGACY_CATEGORIES: ReadonlyArray<Omit<PromptCategory, "confirmOnly">> = LEGACY_SYSTEM.split("\n").flatMap((line) => {
  const match = LEGACY_LINE.exec(line);
  return match ? [{ id: match[1] ?? "", kind: match[1] === "T1" ? ("amount" as const) : ("keyword" as const), definition: match[2] ?? "" }] : [];
});

/** The only tier that could wait for the AI before the signal categories (its switch never changed the prompt version). */
const LEGACY_CONFIRM_TIER = "T4";

/**
 * Whether a set of AI categories is the default one: same ids, kinds, definitions and order, and only T4 may wait for the
 * AI (as before the signal categories, where switching T4's `ai_confirm_only` did not change the version; it rescans, which reviews again anyway).
 */
export function isLegacyPromptCategories(categories: readonly PromptCategory[]): boolean {
  return (
    categories.length === LEGACY_CATEGORIES.length &&
    categories.every((category, index) => {
      const legacy = LEGACY_CATEGORIES[index];
      return legacy !== undefined && category.id === legacy.id && category.kind === legacy.kind && category.definition === legacy.definition && (!category.confirmOnly || category.id === LEGACY_CONFIRM_TIER);
    })
  );
}

/** The system prompt for any set of AI categories (`signalsPromptSpec` uses `LEGACY_SYSTEM` for the default set). */
export function buildSignalsSystem(categories: readonly PromptCategory[]): string {
  const amount = categories.find((category) => category.kind === "amount");
  const lines = categories.map((category) => `- ${category.id}: ${category.definition}`).join("\n");
  const amountRules = amount
    ? `- ${amount.id} only: fill "amount" with the figures exactly as written, as plain numbers ("90k" → 90000, "85.000" → 85000), the currency as ISO code (€ → EUR) or null if none is written, and the period the figures are stated for ("per month" → month; "p.a." or annual → year) or null if not written. Use min and max for a range; "up to X" → min null, max X; "from X" → min X, max null; a single figure → min = max. Do NOT convert currencies or periods yourself and do not add up several figures (a figure plus other pay is one ${amount.id} signal for the figure and separate signals for the rest). If the JD gives several salary figures for different roles or countries, include each as its own ${amount.id} signal.
- For categories other than ${amount.id} set "amount" to null.`
    : `- Set "amount" to null.`;
  return `You extract signals from one job description (JD) for a job seeker. A signal is something the JD offers the person who gets hired, in one of these categories ("tier" is the category id):
${lines}

Rules:
- The user message lists CANDIDATES found by keyword rules, each with an id. For each candidate decide: it is a real signal (include it in "signals" with its id in "candidate"), or it is not (put its id in "rejected"). You may change its category.
- Also add signals the rules missed (candidate: null), using the same categories and rules.
- "quote" must be copied character for character from the JD: one sentence or fragment that contains the evidence, at most the stated length. Never paraphrase, translate or fix it. A signal without an exact quote is discarded.
${amountRules}
- If the JD has no signals, return {"signals": [], "rejected": [...]}.
- Reply with the JSON object only.`;
}

export interface SignalsPromptSpec {
  /** Stored as `signal_scans.ai_prompt_version`. */
  version: string;
  system: string;
  schema: ReturnType<typeof buildSignalsSchema>;
}

/**
 * Version, system prompt and output schema for the AI categories of interests.yaml; null when there is none (nothing
 * to review). The default categories give `signals-v1` and `LEGACY_SYSTEM`; anything else `signals-v2-<12 hex>` of
 * what the AI sees and what the merge does (ids, kinds, definitions, order, `ai_confirm_only`). Names, colours, weights
 * and `high_value` are not part of it: changing them never sends a job to the AI again.
 */
export function signalsPromptSpec(categories: readonly PromptCategory[]): SignalsPromptSpec | null {
  const [first, ...rest] = categories;
  if (!first) return null;
  const schema = buildSignalsSchema([first.id, ...rest.map((category) => category.id)]);
  if (isLegacyPromptCategories(categories)) return { version: LEGACY_SIGNALS_PROMPT_VERSION, system: LEGACY_SYSTEM, schema };
  const system = buildSignalsSystem(categories);
  const hash = createHash("sha256")
    .update(JSON.stringify({ system, categories: categories.map((category) => ({ id: category.id, kind: category.kind, confirmOnly: category.confirmOnly })) }))
    .digest("hex")
    .slice(0, 12);
  return { version: `signals-v2-${hash}`, system, schema };
}

export function buildSignalsPrompt(input: SignalsPromptInput & { system: string }): AiPrompt {
  const candidates =
    input.candidates.length === 0
      ? "(none)"
      : input.candidates
          .map((c) => `[${c.id}] ${c.tier}${c.parsed ? ` (rules read: ${c.parsed})` : ""}: ${JSON.stringify(c.quote)}`)
          .join("\n");
  const user = `Quote length limit: ${input.quoteMaxChars} characters.

Job title: ${input.title}

CANDIDATES:
${candidates}

JD:
"""
${truncateJd(input.description, input.maxJdChars)}
"""`;
  return { system: input.system, user };
}
