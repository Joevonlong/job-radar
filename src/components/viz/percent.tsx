import { useTranslations } from "next-intl";

import { formatFraction, formatInteger, formatPercent, percentParts, ratioPercent, UNKNOWN } from "@/lib/format/numbers";

import "./viz.css";
import { useAppLocale } from "./intl";
import { PlayOnView } from "./motion";
import { NumberRoll } from "./number-roll";
import { clamp, cssVars, cx, known, pctStyle, toneVar, type VizTone } from "./util";

// ---------------------------------------------------------------- big percentage

export type PercentTextSize = "xl" | "l" | "m";

export interface PercentTextProps {
  /** Percentage points (24 = 24%). Null: `—`. */
  value: number | null | undefined;
  /** `xl` 44 · `l` 32 · `m` 22 (type scale tokens). */
  size?: PercentTextSize;
  /** Roll the digits (a client component); off keeps it a plain server-rendered text. */
  roll?: boolean;
  className?: string;
}

/** The big number style: `24` with a smaller `%`. ≥ 10 whole, < 10 one decimal, below 0.1 `<0.1%`. */
export function PercentText({ value, size = "l", roll = false, className }: PercentTextProps) {
  const parts = percentParts(value);
  const unknown = !known(value);
  if (roll && known(value) && value >= 0.1) {
    return (
      <span className={cx("jr jr-ptext", `jr-ptext--${size}`, className)}>
        <NumberRoll value={value} format={{ minimumFractionDigits: value < 10 ? 1 : 0, maximumFractionDigits: value < 10 ? 1 : 0 }} />
        <small>%</small>
      </span>
    );
  }
  return (
    <span className={cx("jr jr-ptext", `jr-ptext--${size}`, unknown && "jr-ptext--unknown", className)}>
      {parts.text}
      {parts.unit ? <small>{parts.unit}</small> : null}
    </span>
  );
}

// ---------------------------------------------------------------- ratio bar

export type PercentBarSize = "sm" | "md" | "lg";

export interface PercentBarProps {
  /** Percentage points, 0-100 (above 100 fills the bar and still prints the real number). Null: dashed empty bar and `—`. */
  value: number | null | undefined;
  size?: PercentBarSize;
  tone?: VizTone;
  /** Text next to the bar. Default: the percentage. `false`: none (give `ariaLabel` then). */
  label?: string | false;
  /** Name of the meter for assistive technology. */
  ariaLabel?: string;
  /** A line across the bar (alert level), same scale. */
  threshold?: number | null;
  className?: string;
}

export function PercentBar({ value, size = "md", tone = "ink", label, ariaLabel, threshold, className }: PercentBarProps) {
  const t = useTranslations("viz");
  const text = label === false ? null : (label ?? formatPercent(value));
  const name = ariaLabel ?? (typeof text === "string" && text !== UNKNOWN ? text : t("percent.label"));
  if (!known(value)) {
    return (
      <span className={cx("jr jr-ratio", `jr-ratio--${size}`, className)}>
        <span className="jr-pbar-track" role="img" aria-label={`${name}: ${UNKNOWN}`} style={{ borderStyle: "dashed" }} />
        {text === null ? null : <b>{text}</b>}
      </span>
    );
  }
  const shown = clamp(value, 0, 100);
  return (
    <PlayOnView className={cx("jr-ratio", `jr-ratio--${size}`, className)}>
      <span className="jr-pbar-wrap">
        <span
          className="jr-pbar-track"
          role="meter"
          aria-label={name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(shown * 10) / 10}
          aria-valuetext={formatPercent(value)}
          style={cssVars({ "--c": toneVar(tone) })}
        >
          <i className="jr-grow" style={{ width: pctStyle(shown) }} />
        </span>
        {known(threshold) ? <span className="jr-pbar-tick" aria-hidden style={{ left: pctStyle(clamp(threshold, 0, 100)) }} /> : null}
      </span>
      {text === null ? null : <b>{text}</b>}
    </PlayOnView>
  );
}

// ---------------------------------------------------------------- fraction

export interface FractionProps {
  /** Done / used so far. */
  part: number | null | undefined;
  /** Total / quota. Missing or 0: the share is unknown and no bar is drawn. */
  whole: number | null | undefined;
  /** Unit after the whole (`条`, `页`); the app adds the space. */
  unit?: string;
  tone?: VizTone;
  /** Draw the ratio bar under the numbers (default). */
  bar?: boolean;
  /** Name of the meter. */
  ariaLabel?: string;
  /** A line across the bar (alert level), in percent. */
  threshold?: number | null;
  className?: string;
}

/** `62` big, `/ 135 条 · 46%` next to it, a ratio bar under it. */
export function Fraction({ part, whole, unit, tone = "meter", bar = true, ariaLabel, threshold, className }: FractionProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const percent = ratioPercent(part, whole);
  const wholeText = formatInteger(whole, locale);
  const unitText = unit ? ` ${unit}` : "";
  const summary = formatFraction(part, whole, locale);
  return (
    <div className={cx("jr jr-frac", className)} data-fraction={summary}>
      <span className="jr-frac__n">
        <b>
          <NumberRoll value={part} />
        </b>
        <span>
          {whole === null || whole === undefined || !Number.isFinite(whole) ? `/ ${UNKNOWN}` : `/ ${wholeText}${unitText}`}
          {percent === null ? "" : ` · ${formatPercent(percent)}`}
        </span>
      </span>
      {bar ? <PercentBar value={percent} tone={tone} label={false} ariaLabel={ariaLabel ?? t("fraction.aria", { part: formatInteger(part, locale), whole: wholeText, percent: formatPercent(percent) })} threshold={threshold} /> : null}
    </div>
  );
}
