/**
 * Number formatting rules of docs/design/tokens.md "数字格式". Pure functions, no I/O: components, pages
 * and tests share them, so a rule lives in exactly one place. Unknown values (null / undefined / NaN) never
 * become 0 (C3): every function answers with `UNKNOWN` ("—") for them, and the caller says "未披露" next to it
 * where that is the right word.
 *
 * Locale: one per messages file. The `Intl` tag comes from its `meta`, the words ("up to", "and up", the period
 * suffixes) from its `format` namespace, both through the generated catalog. Every function takes the locale explicitly.
 */
import { FORMAT_LABELS, LOCALE_META, type Locale } from "@/i18n/locale";

/** What an unknown value renders as. */
export const UNKNOWN = "—";
/** The real minus sign (U+2212): `-` is a hyphen and breaks tabular alignment. */
export const MINUS = "−";

type Maybe = number | null | undefined;

function isKnown(value: Maybe): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The BCP 47 tag `Intl` should get for an app locale. */
export function intlLocale(locale: Locale): string {
  return LOCALE_META[locale].intl;
}

/** `1284` -> `1,284`. Fractions are rounded: this is for counts. */
export function formatInteger(value: Maybe, locale: Locale): string {
  if (!isKnown(value)) return UNKNOWN;
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0 }).format(Math.round(value));
}

/**
 * From this size a headline number is written compact (`1.95M`, `195.33万`) so it cannot outgrow its card.
 * The exact value stays in the title and the screen-reader text; below it the full grouped number is shown.
 */
export const COMPACT_FROM = 1_000_000;

/** `Intl` options for a compact headline number: two decimals at most (`1.95M`). */
export const COMPACT_OPTIONS = { notation: "compact", maximumFractionDigits: 2 } as const satisfies Intl.NumberFormatOptions;

/** True when a headline number should be written compact. */
export function isCompact(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) >= COMPACT_FROM;
}

/** Number followed by its unit, always one space between (`6 jobs`). The unit comes from the messages. */
export function formatCount(value: Maybe, unit: string, locale: Locale): string {
  if (!isKnown(value)) return UNKNOWN;
  return `${formatInteger(value, locale)} ${unit}`;
}

// ------------------------------------------------------------------ money

/**
 * USD as `$1.20`; a sub-dollar amount keeps four decimals (`$0.0123`) so small AI costs do not all read as `$0.00`.
 * A plain `$` in every locale: `Intl` writes `US$` in zh. `format` is any `number` formatter (next-intl's or one built on `Intl`).
 */
export function formatUsdAmount(format: { number: (value: number, options: { minimumFractionDigits: number; maximumFractionDigits: number }) => string }, usd: number): string {
  return `$${format.number(usd, { minimumFractionDigits: 2, maximumFractionDigits: usd > 0 && usd < 1 ? 4 : 2 })}`;
}

// ------------------------------------------------------------------ percentages

/** Digits of a percentage: >= 10 whole, < 10 one decimal. `value` is in percentage points (41.37 means 41.37%). */
function percentDigits(abs: number): string {
  const one = Math.round(abs * 10) / 10;
  // 9.96 rounds to 10.0 at one decimal: it is a two-digit number now, so it is shown whole.
  if (abs >= 10 || one >= 10) return String(Math.round(abs));
  return one.toFixed(1);
}

/** Smaller than this (but not 0) is written `<0.1%`: a rounded 0.0% would claim there is nothing. */
export const PERCENT_FLOOR = 0.1;

export interface PercentParts {
  /** `41`, `2.6`, `0`, `<0.1`, or `—`. */
  text: string;
  /** `%`, or empty for an unknown value. */
  unit: string;
}

/** Number and unit of a percentage apart, for the big-number style (`24` with a smaller `%`). */
export function percentParts(value: Maybe): PercentParts {
  if (!isKnown(value)) return { text: UNKNOWN, unit: "" };
  const abs = Math.abs(value);
  const sign = value < 0 ? MINUS : "";
  if (abs === 0) return { text: "0", unit: "%" };
  if (abs < PERCENT_FLOOR) return { text: `${sign}<${PERCENT_FLOOR}`, unit: "%" };
  return { text: `${sign}${percentDigits(abs)}`, unit: "%" };
}

/** `41.37` -> `41%`, `2.64` -> `2.6%`, `0.04` -> `<0.1%`, `0` -> `0%`. */
export function formatPercent(value: Maybe): string {
  const { text, unit } = percentParts(value);
  return `${text}${unit}`;
}

/** Size of a change in a quantity, with its sign: `+18%`, `−3.2%`, `0%`. */
export function formatPercentChange(value: Maybe): string {
  if (!isKnown(value)) return UNKNOWN;
  if (value === 0) return "0%";
  const sign = value > 0 ? "+" : MINUS;
  return `${sign}${percentParts(Math.abs(value)).text}%`;
}

/** Change of a ratio, in percentage points: `+2pt`, `−1.5pt`. A whole number carries no decimal. */
export function formatPercentagePoints(value: Maybe): string {
  if (!isKnown(value)) return UNKNOWN;
  const abs = Math.abs(value);
  if (abs === 0) return "0pt";
  const sign = value > 0 ? "+" : MINUS;
  if (abs < PERCENT_FLOOR) return `${sign}<${PERCENT_FLOOR}pt`;
  const text = percentDigits(abs).replace(/\.0$/, "");
  return `${sign}${text}pt`;
}

/** A share as a percentage: `part` of `whole`. Unknown when the whole is missing or 0. */
export function ratioPercent(part: Maybe, whole: Maybe): number | null {
  if (!isKnown(part) || !isKnown(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

// ------------------------------------------------------------------ scores, fractions, changes

/** The score itself, rounded and kept inside the scale: `88`. Unknown is `—`, never 0. */
export function formatScoreValue(score: Maybe, max = 100): string {
  if (!isKnown(score)) return UNKNOWN;
  return String(Math.min(max, Math.max(0, Math.round(score))));
}

/** `88/100`; an unscored job is `—` (the denominator would make it look like a score). */
export function formatScore(score: Maybe, max = 100): string {
  if (!isKnown(score)) return UNKNOWN;
  return `${formatScoreValue(score, max)}/${max}`;
}

/** `62/135 · 46%`. An unknown part or a missing / empty whole is `—`; a zero part of a known whole is `0/135 · 0%`. */
export function formatFraction(part: Maybe, whole: Maybe, locale: Locale): string {
  if (!isKnown(part) || !isKnown(whole)) return UNKNOWN;
  const base = `${formatInteger(part, locale)}/${formatInteger(whole, locale)}`;
  const percent = ratioPercent(part, whole);
  return percent === null ? base : `${base} · ${formatPercent(percent)}`;
}

export type DeltaDirection = "up" | "down" | "flat";

export interface DeltaParts {
  direction: DeltaDirection;
  /** `▲`, `▼`, `■`. */
  symbol: string;
  /** Sign and size, `+12`, `−3`, `0`. */
  text: string;
  /** Symbol and text together: `▲ +12`. */
  full: string;
}

/** Digits of a change: whole numbers stay whole, fractions get one decimal, from 10 on the fraction is dropped (`−10.5pt` -> `−11pt`, like percentages). */
function deltaDigits(abs: number, locale: Locale): string {
  if (Number.isInteger(abs) || abs >= 10) return formatInteger(abs, locale);
  return new Intl.NumberFormat(intlLocale(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(abs);
}

/**
 * Change against the previous round: `▲ +12`, `▼ −3`, `■ 0`. Arrow, sign and number say the same thing
 * (colour is a fourth cue, never the only one). `unit` is appended as is (`pt`, `%`). Unknown: null.
 */
export function formatDelta(value: Maybe, unit = "", locale: Locale): DeltaParts | null {
  if (!isKnown(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return { direction: "flat", symbol: "■", text: `0${unit}`, full: `■ 0${unit}` };
  const direction: DeltaDirection = rounded > 0 ? "up" : "down";
  const symbol = direction === "up" ? "▲" : "▼";
  const text = `${direction === "up" ? "+" : MINUS}${deltaDigits(Math.abs(rounded), locale)}${unit}`;
  return { direction, symbol, text, full: `${symbol} ${text}` };
}

// ------------------------------------------------------------------ salary

export type SalaryPeriod = "year" | "month" | "week" | "day" | "hour";

export interface SalaryInput {
  /** Lower bound, whole currency units for the period (95000 for €95k a year). */
  min?: Maybe;
  max?: Maybe;
  /**
   * ISO code; a currency with a symbol of its own ("€", "$", "£", "¥") gets it, anything else is written as the code. Pages pass
   * the market's base currency for base figures (`useBaseCurrency`); without one no currency is written.
   */
  currency?: string;
  /** Converted from another period or currency: the figure gets a leading `≈`. */
  approx?: boolean;
}


const symbols = new Map<string, string>();

/** "€", "$", "£" for a currency whose narrow symbol is a sign; "CHF ", "PLN " for one written with letters; "" without a currency. */
export function currencyPrefix(currency: string): string {
  const code = currency.toUpperCase();
  if (code === "") return "";
  let prefix = symbols.get(code);
  if (prefix === undefined) {
    let narrow: string | undefined;
    try {
      narrow = new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((part) => part.type === "currency")?.value;
    } catch {
      narrow = undefined;
    }
    prefix = narrow !== undefined && narrow !== "" && !/\p{L}/u.test(narrow) ? narrow : `${code} `;
    symbols.set(code, prefix);
  }
  return prefix;
}

/**
 * A range this much narrower than 10k keeps one decimal in k (`€92.5–100k`, a 7.5k wide range would lose its shape in
 * whole k); a wider one, and the converted figure of another currency, reads in whole k (`≈ €139–163k`, not `€139.3–163.4k`).
 * One bound alone has no width: it keeps its decimal (`€86.4k`). A converted figure (`approx`: another currency, a monthly or hourly
 * rate times its factor) is an estimate: whole k always (`≈ €86k`), a decimal would claim a precision it does not have.
 */
export const SALARY_WHOLE_K_FROM = 10_000;

/** Decimals in k for a salary spanning `low` to `high` (see `SALARY_WHOLE_K_FROM`). */
export function salaryKDecimals(low: number, high: number): 0 | 1 {
  return Math.abs(high - low) >= SALARY_WHOLE_K_FROM ? 0 : 1;
}

/** 95000 -> "95", 92500 -> "92.5" (thousands, `decimals` at most). Below 1,000 the amount is written as is. */
function thousands(amount: number, abbreviate: boolean, locale: Locale, decimals: 0 | 1): string {
  const value = abbreviate ? amount / 1000 : amount;
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: abbreviate ? decimals : 0 }).format(value);
}

export interface SalaryFormatOptions {
  locale: Locale;
  /** Append the period (`/yr`, `/mo` …) after the figure. Off by default: tables and axes already say it is a year. */
  period?: SalaryPeriod;
}

/**
 * `€95–120k` · `up to €120k` · `€90k and up` · `≈ €129–156k` (the words from the locale's `format.salary`). Whole k, except a range narrower than 10k (`€92.5–100k`).
 * Null when neither bound is known (the caller shows
 * "未披露": an undisclosed salary is not a salary of 0).
 */
export function formatSalary(input: SalaryInput, options: SalaryFormatOptions): string | null {
  const locale = options.locale;
  const min = isKnown(input.min) ? input.min : null;
  const max = isKnown(input.max) ? input.max : null;
  if (min === null && max === null) return null;
  const prefix = currencyPrefix(input.currency ?? "");
  const abbreviate = Math.max(min ?? 0, max ?? 0) >= 1000;
  const unit = abbreviate ? "k" : "";
  const words = FORMAT_LABELS[locale].salary;
  // a single bound keeps one decimal, unless it is converted (an estimate: whole k)
  const single: 0 | 1 = input.approx ? 0 : 1;
  let figure: string;
  if (min !== null && max !== null && min !== max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const decimals = input.approx ? 0 : salaryKDecimals(lo, hi);
    figure = `${prefix}${thousands(lo, abbreviate, locale, decimals)}–${thousands(hi, abbreviate, locale, decimals)}${unit}`;
  } else if (min !== null && max !== null) {
    figure = `${prefix}${thousands(min, abbreviate, locale, single)}${unit}`;
  } else if (max !== null) {
    figure = `${words.upTo} ${prefix}${thousands(max, abbreviate, locale, single)}${unit}`;
  } else {
    figure = `${prefix}${thousands(min as number, abbreviate, locale, single)}${unit} ${words.from}`;
  }
  if (input.approx) figure = `≈ ${figure}`;
  return options.period ? `${figure} ${FORMAT_LABELS[locale].salaryPeriod[options.period]}` : figure;
}
