import type { PipelineConfig } from "@/lib/config";
import type { NormalizedPostingDraft } from "@/lib/channels/types";
import { LEGACY_BASE_CURRENCY, type JobSalary, type OtherRegionReason } from "@/lib/domain/types";
import { fxFactor } from "@/lib/market/currency";

import { compileRules } from "./rules";

type Period = NonNullable<JobSalary["period"]>;

/**
 * Bump when the salary parsing changes in a way the config does not show (a new rule in this file):
 * the pipeline step then reads every job's raw postings again and corrects the stored salary.
 */
export const SALARY_PARSER_VERSION = 4;

/** What the pipeline writes: the figures in the posting's currency, per year, and per year in the base currency. */
export type BuiltSalary = Omit<JobSalary, "eurPerYear" | "basePerYear" | "baseCurrency"> & {
  basePerYear: JobSalary["basePerYear"];
  baseCurrency: string;
  eurPerYear: JobSalary["eurPerYear"];
};

/** Reason codes that make a salary "review" (not trusted for comparison). `PERIOD_ASSUMED_YEAR` only informs. */
export const SALARY_REVIEW_CODES = [
  "SALARY_UNPARSED",
  "SALARY_MIN_EXCEEDS_MAX",
  "SALARY_AMOUNT_NON_POSITIVE",
  "SALARY_CURRENCY_UNKNOWN",
  "SALARY_PERIOD_UNKNOWN",
  "ANNUAL_AMOUNT_IMPLAUSIBLY_LOW",
  "ANNUAL_AMOUNT_IMPLAUSIBLY_HIGH",
  "AMOUNT_IMPLAUSIBLE_FOR_PERIOD",
] as const;

// ---------------------------------------------------------------- number and currency tokens

const NUM = String.raw`(?:\d{1,3}(?:[.,  ' ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?)`;
/**
 * The currency tokens of the packs (generic `rules.yaml` `salary.currencies`; was a table here) compiled: the
 * alternation of all tokens (`cur`), the amount pattern built around it, and a whole-token test per currency.
 */
interface CurrencyParser {
  cur: string;
  amountSource: string;
  codes: ReadonlyArray<readonly [RegExp, string]>;
}

const parsers = new WeakMap<PipelineConfig["salary"]["currencies"], CurrencyParser>();

function currencyParser(config: PipelineConfig): CurrencyParser {
  const table = config.salary.currencies;
  const hit = parsers.get(table);
  if (hit) return hit;
  // A word token stands alone ("ils" is no currency inside "Details"); a symbol that starts with a letter ("S$") is not the tail of a longer word ("US$")
  const tokens = (entry: (typeof table)[number]): string[] => [
    ...entry.symbols.map((symbol) => (/^\p{L}/u.test(symbol) ? `(?<![\\p{L}])${symbol}` : symbol)),
    ...entry.words.map((word) => `(?<![\\p{L}])${word}(?![\\p{L}])`),
  ];
  const all = table.flatMap(tokens);
  const cur = all.length > 0 ? `(?:${all.join("|")})` : "(?!)";
  const parser: CurrencyParser = {
    cur,
    amountSource: String.raw`(?<![\p{L}\p{N}.,])(?:(${cur})\s*)?(${NUM})(\s*k(?![\p{L}\p{N}]))?(?:\s*(${cur}))?`,
    codes: table.map((entry) => [new RegExp(`^(?:${[...entry.symbols, ...entry.words].join("|")})$`, "iu"), entry.code] as const),
  };
  parsers.set(table, parser);
  return parser;
}
/** A period or tax word that may follow the first amount of a range: "€75,000/yr - €100,000/yr", "75k p.a. – 100k p.a.", "70.000 € brutto bis ...". */
const UNIT_AFTER_AMOUNT = String.raw`(?:/\s*\p{L}+\.?|p\.\s?[am]\.|(?:per|pro|a|im|je)\s+\p{L}+|annual(?:ly)?|yearly|monthly|jährlich|monatlich|gross|brutto|netto|net)`;
const RANGE_SEPARATOR = new RegExp(String.raw`^\s*(?:${UNIT_AFTER_AMOUNT}\s*){0,2}(?:–|—|‒|-|bis(?:\s+zu)?|to|up to|und|and)\s*$`, "iu");
const MAX_RANGE_GAP_CHARS = 40;
/** Units and tax words that belong to an amount and end its quote. */
const TRAILING_UNITS = new RegExp(String.raw`^(?:\s*(?:${UNIT_AFTER_AMOUNT}|(?:jahr|year|month|monat|week|woche|day|tag|hour|stunde)\p{L}*))+`, "iu");
const UPPER_BOUND_BEFORE = /(?<![\p{L}])(?:up\s*to|bis\s+zu|bis|max(?:imum|imal)?\.?|höchstens|upto)\s*$/iu;
const LOWER_BOUND_BEFORE = /(?<![\p{L}])(?:from|ab|mindestens|minimum|min\.?|starting\s+(?:at|from)|über)\s*$/iu;

/** Either kind of bound word right before an amount, with the space after it ("up to ", "bis zu ", "ab "). */
const BOUND_WORD_BEFORE = /(?<![\p{L}])(?:up\s*to|bis\s+zu|bis|max(?:imum|imal)?\.?|höchstens|upto|from|ab|mindestens|minimum|min\.?|starting\s+(?:at|from)|über)\s*$/iu;

interface AmountMatch {
  start: number;
  end: number;
  value: number;
  hasK: boolean;
  currency: string | null;
  /** The match ends with a currency symbol after one in front ("$184,050 $": the trailing one opens the next amount). */
  endsWithNextCurrency: boolean;
}

function currencyCode(token: string | undefined, parser: CurrencyParser): string | null {
  if (!token) return null;
  const trimmed = token.trim();
  for (const [pattern, code] of parser.codes) if (pattern.test(trimmed)) return code;
  return null;
}

/** "85.000" (de), "85,000" (en), "85 000", "45,5", "45.50", "85.5" with a k suffix ... -> a number, or null. */
export function parseNumberToken(token: string, hasK: boolean): number | null {
  const t = token.replace(/[  ' ]/g, "");
  const dots = (t.match(/\./g) ?? []).length;
  const commas = (t.match(/,/g) ?? []).length;
  let normalized: string;
  if (dots > 0 && commas > 0) {
    const last = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
    normalized = `${t.slice(0, last).replace(/[.,]/g, "")}.${t.slice(last + 1)}`;
  } else if (dots > 1 || commas > 1) {
    normalized = t.replace(/[.,]/g, "");
  } else if (dots + commas === 1) {
    const index = Math.max(t.indexOf("."), t.indexOf(","));
    const after = t.length - index - 1;
    const before = index;
    // exactly three digits after the only separator: a thousands separator ("85.000", "85,000")
    normalized = after === 3 && !hasK && before >= 1 && before <= 3 ? t.replace(/[.,]/g, "") : t.replace(",", ".");
  } else {
    normalized = t;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function findAmounts(text: string, parser: CurrencyParser): AmountMatch[] {
  const matches: AmountMatch[] = [];
  for (const m of text.matchAll(new RegExp(parser.amountSource, "giu"))) {
    const numberToken = m[2];
    if (numberToken === undefined) continue;
    const hasK = m[3] !== undefined;
    const value = parseNumberToken(numberToken, hasK);
    if (value === null) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      value: hasK ? value * 1000 : value,
      hasK,
      currency: currencyCode(m[1], parser) ?? currencyCode(m[4], parser),
      endsWithNextCurrency: m[1] !== undefined && m[4] !== undefined && currencyCode(m[1], parser) === currencyCode(m[4], parser) && /^\d/u.test(text.slice(m.index + m[0].length)),
    });
  }
  return matches;
}

// ---------------------------------------------------------------- period

const PERIOD_PATTERNS: ReadonlyArray<readonly [Period, RegExp]> = [
  ["hour", /per\s+hour|hourly|an\s+hour|\/\s*(?:hour|hr|h|std|stunde)(?![\p{L}])|pro\s+stunde|stündlich|stundenlohn|stundensatz/iu],
  ["day", /per\s+day|daily|\/\s*(?:day|tag)(?![\p{L}])|pro\s+tag|täglich|tagessatz|day\s+rate/iu],
  ["week", /per\s+week|weekly|\/\s*(?:week|wk|woche)(?![\p{L}])|pro\s+woche|wöchentlich/iu],
  ["month", /per\s+month|monthly|a\s+month|\/\s*(?:month|mo|monat)(?![\p{L}])|pro\s+monat|monatlich|monatsgehalt|monatsbrutto|im\s+monat|(?<![\p{L}])p\.\s?m\./iu],
  ["year", /per\s+(?:year|annum)|a\s+year|annual|\/\s*(?:year|yr|jahr|j)(?![\p{L}])|pro\s+jahr|jährlich|jahresgehalt|jahresbrutto|jahresbruttogehalt|im\s+jahr|(?<![\p{L}])p\.\s?a\.|(?<![\p{L}])yr(?![\p{L}])/iu],
];

/** The period named closest to the amounts (`anchor` = their span in `window`), if any. */
function detectPeriod(window: string, anchor: { start: number; end: number }): Period | null {
  let best: { period: Period; distance: number } | null = null;
  for (const [period, pattern] of PERIOD_PATTERNS) {
    const m = pattern.exec(window);
    if (!m) continue;
    const end = m.index + m[0].length;
    const distance = m.index >= anchor.end ? m.index - anchor.end : end <= anchor.start ? anchor.start - end : 0;
    if (best === null || distance < best.distance) best = { period, distance };
  }
  return best?.period ?? null;
}

// ---------------------------------------------------------------- parsing

export interface ParsedSalaryText {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: Period | null;
  periodAssumed: boolean;
}

export interface ParseSalaryOptions {
  /** Only accept text with explicit money evidence (a currency, or a `k` amount). For free text. */
  requireCurrency: boolean;
}

/**
 * Salary text -> amounts as stated. Handles German (85.000 €, 85.000,00 EUR) and English (85,000)
 * number formats, `k` notation, ranges (–, -, to, bis, und), "up to" / "bis zu" (max only) and
 * "from" / "ab" (min only). Never invents: no currency means `currency: null`, no named period means
 * `period: null` unless the amount is big enough to only be annual (`assume_annual_from`).
 */
export function parseSalaryText(text: string, config: PipelineConfig, options: ParseSalaryOptions): ParsedSalaryText | null {
  const parser = currencyParser(config);
  const amounts = findAmounts(text, parser);
  const index = amounts.findIndex((a) => !options.requireCurrency || a.currency !== null || a.hasK || currencyNear(text, a.start, a.end, parser) !== null);
  const read = index < 0 ? null : readAmountsFrom(text, amounts, index, config, options);
  if (!read) return null;
  const { spanEnd: _spanEnd, ...parsed } = read;
  void _spanEnd;
  return parsed;
}

/** The amount at `index` and, when a range separator links it to the next one, the upper end. */
function readAmountsFrom(
  text: string,
  amounts: readonly AmountMatch[],
  index: number,
  config: PipelineConfig,
  options: ParseSalaryOptions,
): (ParsedSalaryText & { spanEnd: number }) | null {
  const low = amounts[index];
  if (!low) return null;

  let high: AmountMatch | null = null;
  const next = amounts[index + 1];
  if (next && next.start - low.end <= MAX_RANGE_GAP_CHARS) {
    const gap = text.slice(low.end, next.start);
    // "$184,050 $262,928": two amounts of one currency side by side are a range
    const adjacent = /^\s*$/u.test(gap) && low.endsWithNextCurrency && next.currency === null;
    if (RANGE_SEPARATOR.test(gap) || adjacent) high = next;
  }

  let min: number | null;
  let max: number | null;
  if (high) {
    let lowValue = low.value;
    let highValue = high.value;
    // "85-105k": the k belongs to both ends
    if (high.hasK && !low.hasK && lowValue < 1000) lowValue *= 1000;
    if (low.hasK && !high.hasK && highValue < 1000) highValue *= 1000;
    min = lowValue;
    max = highValue;
  } else {
    const before = text.slice(Math.max(0, low.start - 20), low.start);
    if (UPPER_BOUND_BEFORE.test(before)) {
      min = null;
      max = low.value;
    } else if (LOWER_BOUND_BEFORE.test(before)) {
      min = low.value;
      max = null;
    } else {
      min = low.value;
      max = low.value;
    }
  }

  const spanEnd = (high ?? low).end;
  const currency = low.currency ?? high?.currency ?? currencyNear(text, low.start, spanEnd, currencyParser(config));
  if (options.requireCurrency && currency === null) return null;

  const windowStart = Math.max(0, low.start - 30);
  const window = text.slice(windowStart, Math.min(text.length, spanEnd + 40));
  let period = detectPeriod(window, { start: low.start - windowStart, end: spanEnd - windowStart });
  let periodAssumed = false;
  if (period === null) {
    const biggest = Math.max(min ?? 0, max ?? 0);
    if (biggest >= config.salary.assume_annual_from) {
      period = "year";
      periodAssumed = true;
    }
  }
  return { min, max, currency, period, periodAssumed, spanEnd };
}

function currencyNear(text: string, start: number, end: number, parser: CurrencyParser): string | null {
  const window = text.slice(Math.max(0, start - 25), Math.min(text.length, end + 25));
  const m = new RegExp(parser.cur, "iu").exec(window);
  return currencyCode(m?.[0], parser);
}

// ---------------------------------------------------------------- conversion and quality

const roundAmount = (value: number): number => Math.round(value * 100) / 100;

function convert(value: number | null, factor: number): number | null {
  return value === null ? null : Math.round(value * factor);
}

function assess(
  salary: Pick<JobSalary, "currency" | "period" | "min" | "max" | "perYear" | "basePerYear" | "periodAssumed">,
  config: PipelineConfig,
  unparsed: boolean,
): string[] {
  const codes: string[] = [];
  if (unparsed) codes.push("SALARY_UNPARSED");
  const stated = [salary.min, salary.max].filter((v): v is number => v !== null);
  if (salary.min !== null && salary.max !== null && salary.min > salary.max) codes.push("SALARY_MIN_EXCEEDS_MAX");
  if (stated.some((v) => v <= 0)) codes.push("SALARY_AMOUNT_NON_POSITIVE");
  if (!unparsed && salary.currency === null) codes.push("SALARY_CURRENCY_UNKNOWN");
  if (!unparsed && salary.period === null) codes.push("SALARY_PERIOD_UNKNOWN");
  const annual = salary.basePerYear ?? salary.perYear;
  const annualValues = annual ? [annual.min, annual.max].filter((v): v is number => v !== null) : [];
  if (annualValues.length > 0) {
    if (Math.max(...annualValues) < config.salary.plausible_annual.min) codes.push("ANNUAL_AMOUNT_IMPLAUSIBLY_LOW");
    if (Math.max(...annualValues) > config.salary.plausible_annual.max) codes.push("ANNUAL_AMOUNT_IMPLAUSIBLY_HIGH");
  }
  if (salary.period !== null) {
    const range = config.salary.plausible_per_period[salary.period];
    if (stated.some((v) => v > 0 && (v < range.min || v > range.max))) codes.push("AMOUNT_IMPLAUSIBLE_FOR_PERIOD");
  }
  if (salary.periodAssumed) codes.push("PERIOD_ASSUMED_YEAR");
  return codes;
}

export interface SalaryParts {
  raw: string;
  currency: string | null;
  period: Period | null;
  min: number | null;
  max: number | null;
  periodAssumed: boolean;
  origin: JobSalary["origin"];
}

/**
 * Whether a stated amount is possibly another region's pay: a currency that is not local
 * (pipeline.yaml `salary.local_currencies`), or a JD that says the range is for another location
 * (`salary.other_region_patterns`). Null when nothing says so.
 */
export function otherRegionOf(currency: string | null, description: string | null, config: PipelineConfig): OtherRegionReason | null {
  if (currency !== null && !config.salary.local_currencies.includes(currency)) return "currency";
  if (description && compileRules(config).salaryOtherRegion.some((p) => p.test(description))) return "description";
  return null;
}

/**
 * Stated amounts -> `JobSalary` with per-year and EUR-per-year figures, the quality verdict and the
 * "possibly another region's pay" mark (`description`: the JD the salary belongs to, for that mark).
 */
export function buildSalary(parts: SalaryParts, config: PipelineConfig, options: { unparsed?: boolean; description?: string | null } = {}): BuiltSalary {
  const factor = parts.period === null ? null : config.salary.periods_per_year[parts.period];
  const perYear = factor === null ? null : { min: convert(parts.min, factor), max: convert(parts.max, factor) };
  // Per year in the market's base currency (through the pivot of fx_rates); kept as EUR too while the base is EUR
  const baseCurrency = config.market.currency;
  let basePerYear: JobSalary["basePerYear"] = null;
  if (perYear && parts.currency !== null) {
    if (parts.currency === baseCurrency) basePerYear = perYear;
    else {
      const rate = fxFactor(parts.currency, baseCurrency, config.salary);
      if (rate !== null) basePerYear = { min: convert(perYear.min, rate), max: convert(perYear.max, rate) };
    }
  }
  const base = {
    currency: parts.currency,
    period: parts.period,
    min: parts.min === null ? null : roundAmount(parts.min),
    max: parts.max === null ? null : roundAmount(parts.max),
    perYear,
    basePerYear,
    baseCurrency,
    eurPerYear: baseCurrency === LEGACY_BASE_CURRENCY ? basePerYear : null,
    periodAssumed: parts.periodAssumed,
  };
  const reasonCodes = assess(base, config, options.unparsed ?? false);
  const status = reasonCodes.some((c) => (SALARY_REVIEW_CODES as readonly string[]).includes(c)) ? "review" : "valid";
  const otherRegion = otherRegionOf(parts.currency, options.description ?? null, config);
  const includesVariable = compileRules(config).salaryVariable.some((p) => p.test(parts.raw) || (options.description ? p.test(options.description) : false));
  return { raw: parts.raw, ...base, origin: parts.origin, qualityStatus: status, reasonCodes, ...(otherRegion ? { otherRegion } : {}), ...(includesVariable ? { includesVariable } : {}) };
}

// ---------------------------------------------------------------- salary context in free text

export interface Span {
  start: number;
  end: number;
}

const globalCopies = new WeakMap<RegExp, RegExp>();
const globalOf = (pattern: RegExp): RegExp => {
  let copy = globalCopies.get(pattern);
  if (!copy) {
    copy = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    globalCopies.set(pattern, copy);
  }
  return copy;
};

/** Characters between `span` and the nearest match of `patterns` within `window` characters of it (0 = overlapping); null = none. */
function nearestGap(text: string, span: Span, patterns: readonly RegExp[], window: number): { gap: number; start: number } | null {
  const from = Math.max(0, span.start - window);
  const slice = text.slice(from, Math.min(text.length, span.end + window));
  let best: { gap: number; start: number } | null = null;
  for (const pattern of patterns) {
    for (const m of slice.matchAll(globalOf(pattern))) {
      if (m[0] === "" || m.index === undefined) continue;
      const start = from + m.index;
      const end = start + m[0].length;
      const gap = end <= span.start ? span.start - end : start >= span.end ? start - span.end : 0;
      if (best === null || gap < best.gap) best = { gap, start };
    }
  }
  return best;
}

export type AmountContext = "salary" | "benefit" | "none";

/**
 * What the words around an amount say it is (pipeline.yaml `salary.*context*`): "benefit" when a
 * negative word (relocation, learning budget, phone allowance ...) is at least as near as any salary
 * word, "salary" when a salary word is within `context_window_chars` and nothing negative is nearer,
 * "none" when no salary word is close.
 */
export function classifyAmountContext(text: string, span: Span, config: PipelineConfig): AmountContext {
  const rules = compileRules(config);
  const negative = nearestGap(text, span, rules.salaryNegative, config.salary.negative_context_window_chars);
  const salaryWord = nearestGap(text, span, rules.salaryContext, config.salary.context_window_chars);
  if (negative !== null && (salaryWord === null || negative.gap <= salaryWord.gap)) return "benefit";
  return salaryWord === null ? "none" : "salary";
}

/** Whether a negative word (benefit, funding ...) is nearer to the amount than any salary word. */
export function isBenefitAmount(text: string, span: Span, config: PipelineConfig): boolean {
  return classifyAmountContext(text, span, config) === "benefit";
}

export interface DescriptionSalary extends ParsedSalaryText {
  /** Verbatim clause of the description that states the salary (salary word included when it precedes the amount). */
  raw: string;
}

/**
 * The first amount of a description that is a salary: money evidence (a currency), a salary word
 * within `context_window_chars` (or a range with its period named, or a rate with its own currency and
 * a period shorter than a year) and no benefit word nearer, and
 * figures that are plausible for the period. Benefit numbers ("Relocation support: up to €2,500", "€60/month phone allowance") never
 * pass; nothing is guessed (C3).
 */
export function findDescriptionSalary(description: string, config: PipelineConfig): DescriptionSalary | null {
  const parser = currencyParser(config);
  const amounts = findAmounts(description, parser);
  for (let i = 0; i < amounts.length; i += 1) {
    const amount = amounts[i];
    if (!amount) continue;
    if (amount.currency === null && !amount.hasK && currencyNear(description, amount.start, amount.end, parser) === null) continue;
    const parsed = readAmountsFrom(description, amounts, i, config, { requireCurrency: true });
    if (!parsed || parsed.currency === null) continue;
    const { spanEnd, ...figures } = parsed;
    const span: Span = { start: amount.start, end: spanEnd };
    const context = classifyAmountContext(description, span, config);
    // no salary word, but a range with its period named ("€80,000 - €120,000 gross a year"): nothing else is written like that
    const namedRange = figures.min !== null && figures.max !== null && figures.min !== figures.max && figures.period !== null && !figures.periodAssumed;
    // or an hourly / daily / weekly / monthly rate with its own currency ("Rate: 18 USD per hour"): pay, unless a benefit word is nearer
    const namedRate = amount.currency !== null && figures.period !== null && figures.period !== "year" && !figures.periodAssumed;
    // or a range whose two ends both carry a currency and are annual-sized ("Germany: €148000 - €151000 (EUR)"): years, IDs and postcodes have no currency sign
    const moneyRange = !benefitBefore(description, span.start, config) && amount.currency !== null && figures.min !== null && figures.max !== null && figures.min !== figures.max && rangeEndsHaveCurrency(amounts, i, description, spanEnd, parser) && Math.min(figures.min, figures.max) >= config.salary.assume_annual_from;
    // a "benefits" word after the range ("… (EUR) + 20% bonus target + equity + benefits") must not turn it into a benefit amount
    if ((context === "benefit" && !moneyRange) || (context === "none" && !namedRange && !namedRate && !moneyRange)) continue;
    if (buildSalary({ raw: "", ...figures, origin: "description" }, config).qualityStatus !== "valid") continue;
    return { ...figures, raw: clauseAround(description, span, config) };
  }
  return null;
}

/** Whether a benefit word stands before the amount on its own line ("Relocation: €20000 - €25000"). */
function benefitBefore(text: string, start: number, config: PipelineConfig): boolean {
  const line = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
  const rules = compileRules(config);
  return nearestGap(line, { start: line.length, end: line.length }, rules.salaryNegative, config.salary.negative_context_window_chars) !== null;
}

/** Whether the amount at `index` and the one that ends the range at `spanEnd` each carry a currency of their own. */
function rangeEndsHaveCurrency(amounts: readonly AmountMatch[], index: number, text: string, spanEnd: number, parser: CurrencyParser): boolean {
  const low = amounts[index];
  const high = amounts.find((a) => a.end === spanEnd);
  if (!low || !high || high === low) return false;
  return low.currency !== null && (high.currency !== null || currencyNear(text, high.start, high.end, parser) !== null);
}

/** The text of the line from the nearest salary word before the amount to the end of its unit words: a verbatim substring. */
function clauseAround(text: string, span: Span, config: PipelineConfig): string {
  const lineStart = text.lastIndexOf("\n", span.start - 1) + 1;
  const lineEndAt = text.indexOf("\n", span.end);
  const lineEnd = lineEndAt === -1 ? text.length : lineEndAt;
  // keep the bound word of "up to €120k" / "bis zu 70.000 €" in the quote
  const bound = BOUND_WORD_BEFORE.exec(text.slice(Math.max(lineStart, span.start - 20), span.start));
  let start = span.start - (bound ? bound[0].length : 0);
  const word = nearestGap(text.slice(0, start), { start, end: start }, compileRules(config).salaryContext, config.salary.context_window_chars);
  if (word !== null && word.start >= lineStart) start = word.start;
  const unit = TRAILING_UNITS.exec(text.slice(span.end, lineEnd));
  return text.slice(start, span.end + (unit ? unit[0].length : 0)).trim();
}

/**
 * The salary of a posting: the channel's structured figures win, then its salary text, then an
 * amount of the description that is a salary by its surrounding words (see `findDescriptionSalary`).
 * No salary stated anywhere: null (C3).
 */
export function normalizeSalary(draft: NormalizedPostingDraft, config: PipelineConfig): BuiltSalary | null {
  if (draft.salary) {
    const s = draft.salary;
    return buildSalary(
      { raw: s.raw, currency: s.currency, period: s.period, min: s.min, max: s.max, periodAssumed: false, origin: "channel" },
      config,
      { description: draft.description },
    );
  }

  const text = draft.salaryText?.trim();
  if (text) {
    const parsed = parseSalaryText(text, config, { requireCurrency: false });
    if (parsed) return buildSalary({ raw: text, ...parsed, origin: "text" }, config, { description: draft.description });
    return buildSalary(
      { raw: text, currency: null, period: null, min: null, max: null, periodAssumed: false, origin: "text" },
      config,
      { unparsed: true },
    );
  }

  const found = findDescriptionSalary(draft.description, config);
  if (!found) return null;
  const { raw, ...parsed } = found;
  return buildSalary({ raw, ...parsed, origin: "description" }, config, { description: draft.description });
}
