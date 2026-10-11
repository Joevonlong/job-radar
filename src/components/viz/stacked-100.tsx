import { useTranslations } from "next-intl";

import { formatInteger, formatPercent, ratioPercent } from "@/lib/format/numbers";

import "./viz.css";
import { useAppLocale } from "./intl";
import { cssVars, cx, pctStyle, toneVar, type VizTone } from "./util";

/** Tones whose fill is dark in the paper theme: the label takes the light-on-solid ink there (and the dark ink in the terminal theme). */
const SOLID_INK_TONES: ReadonlySet<VizTone> = new Set<VizTone>(["good", "bad"]);

export interface Stacked100Part {
  key: string;
  label: string;
  /** Count (or any non-negative amount); the widths are shares of the sum. */
  value: number;
  tone: VizTone;
}

export interface Stacked100Props {
  parts: readonly Stacked100Part[];
  /** Show the legend under the bar (default; with two or more parts it is required by the design rules). */
  legend?: boolean;
  className?: string;
}

/** Parts that add up to the whole: application statuses, source mix. Each segment says its share; the legend names the colours. */
export function Stacked100({ parts, legend = true, className }: Stacked100Props) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const clean = parts.filter((part) => Number.isFinite(part.value) && part.value > 0);
  const sum = clean.reduce((total, part) => total + part.value, 0);

  if (sum <= 0) {
    return (
      <div className={cx("jr jr-s100", className)} role="img" aria-label={t("stacked.empty")}>
        <div className="jr-s100__bar jr-s100__bar--empty" style={{ borderStyle: "dashed" }}>
          —
        </div>
      </div>
    );
  }

  const summary = clean.map((part) => `${part.label} ${formatInteger(part.value, locale)} (${formatPercent(ratioPercent(part.value, sum))})`).join(", ");
  return (
    <div className={cx("jr jr-s100", className)}>
      <div className="jr-s100__bar" role="img" aria-label={t("stacked.aria", { parts: summary })}>
        {clean.map((part) => {
          const percent = ratioPercent(part.value, sum) ?? 0;
          const text = formatPercent(percent);
          return (
            <i
              key={part.key}
              className="jr-tip"
              data-tip={t("stacked.tip", { label: part.label, count: formatInteger(part.value, locale), percent: text })}
              style={cssVars({ "--c": toneVar(part.tone), "--seg-ink": SOLID_INK_TONES.has(part.tone) ? "var(--on-bad)" : undefined, width: pctStyle(percent) })}
            >
              <span className="jr-clip">{text}</span>
            </i>
          );
        })}
      </div>
      {legend ? (
        <div className="jr-legend">
          {clean.map((part) => (
            <span key={part.key} style={cssVars({ "--c": toneVar(part.tone) })}>
              <i />
              {part.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
