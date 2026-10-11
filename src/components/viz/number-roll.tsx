"use client";

import NumberFlow, { type Format } from "@number-flow/react";
import type { Locale } from "@/i18n/locale";
import { COMPACT_OPTIONS, formatInteger, formatPercent, intlLocale, isCompact, PERCENT_FLOOR, UNKNOWN } from "@/lib/format/numbers";

import { useAppLocale } from "./intl";
import { usePlayOnView } from "./motion";
import { cx, known } from "./util";

export type NumberRollFormat = "integer" | "decimal" | "percent" | Format;

export interface NumberRollProps {
  /** Null / NaN: renders `—` (unknown is never 0). */
  value: number | null | undefined;
  /**
   * `integer` 1,284 · `decimal` one decimal · `percent` percentage points with the rule of tokens.md (>= 10 whole,
   * < 10 one decimal, below 0.1 `<0.1%`) · or any `Intl.NumberFormat` options.
   */
  format?: NumberRollFormat;
  /** Text before / after the digits (`€`, `/100`). Not part of the roll. */
  prefix?: string;
  suffix?: string;
  className?: string;
  /** Count up from 0 the first time the number scrolls into view (default). False: show the value at once, roll only on change. */
  playOnView?: boolean;
  /** Overrides the locale from next-intl (tests, stories). */
  locale?: Locale;
}

function resolveFormat(format: NumberRollFormat, value: number): { format: Format; suffix: string } {
  if (format === "integer") return { format: isCompact(value) ? COMPACT_OPTIONS : { maximumFractionDigits: 0 }, suffix: "" };
  if (format === "decimal") return { format: { minimumFractionDigits: 1, maximumFractionDigits: 1 }, suffix: "" };
  if (format === "percent") {
    const digits = Math.abs(value) < 10 ? 1 : 0;
    return { format: { minimumFractionDigits: digits, maximumFractionDigits: digits }, suffix: "%" };
  }
  return { format, suffix: "" };
}

/**
 * Every changing number of the interface. Each digit rolls on its own and only the digits that changed move
 * (NumberFlow); grouping, `%` and currency come from `Intl`. Reduced motion is handled by NumberFlow itself.
 */
export function NumberRoll({ value, format = "integer", prefix, suffix, className, playOnView = true, locale: localeOverride }: NumberRollProps) {
  const locale = useAppLocale(localeOverride);
  const { ref, played } = usePlayOnView<HTMLSpanElement>();

  if (!known(value)) {
    return (
      <span className={cx("jr jr-numroll", className)} data-unknown="true">
        {prefix}
        {UNKNOWN}
      </span>
    );
  }

  // A tiny percentage cannot roll: "<0.1%" is a statement, not a number.
  if (format === "percent" && value > 0 && value < PERCENT_FLOOR) {
    return (
      <span className={cx("jr jr-numroll", className)} data-value={value}>
        {prefix}
        {formatPercent(value)}
        {suffix}
      </span>
    );
  }

  const resolved = resolveFormat(format, value);
  // a 7+ digit count is written compact so it fits its card; the exact figure is the title and the sr text
  const compact = format === "integer" && isCompact(value);
  const shown = playOnView && !played ? 0 : value;
  const finalSuffix = `${resolved.suffix}${suffix ?? ""}`;
  const text = `${prefix ?? ""}${plainText(value, format, locale)}${suffix ?? ""}`;

  return (
    <span ref={ref} className={cx("jr jr-numroll", className)} data-value={value} data-played={played ? "true" : "false"} {...(compact ? { "data-compact": "true", title: text } : {})}>
      <span className="jr-sr">{text}</span>
      <NumberFlow
        aria-hidden
        value={shown}
        format={resolved.format}
        locales={intlLocale(locale)}
        {...(prefix ? { prefix } : {})}
        {...(finalSuffix ? { suffix: finalSuffix } : {})}
      />
    </span>
  );
}

/** The final text for assistive technology and for tests: what the roll ends on. */
function plainText(value: number, format: NumberRollFormat, locale: Locale): string {
  if (format === "percent") return formatPercent(value);
  if (format === "integer") return formatInteger(value, locale);
  if (format === "decimal") return new Intl.NumberFormat(intlLocale(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
  return new Intl.NumberFormat(intlLocale(locale), format as Intl.NumberFormatOptions).format(value);
}
