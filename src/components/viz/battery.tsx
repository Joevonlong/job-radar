import { useTranslations } from "next-intl";

import { formatPercent } from "@/lib/format/numbers";

import "./viz.css";
import { PlayOnView } from "./motion";
import { clamp, cssVars, cx, known, toneVar, type VizTone, stepStyle } from "./util";

export interface BatteryProps {
  /** Share used, 0-100. Null: empty cells and `—`. */
  value: number | null | undefined;
  /** Alert level in percent (`sources.yaml` budget alert, `notify.yaml: alerts.budget_thresholds`): the red line. At or past it the whole block turns red. */
  threshold: number;
  /** Colour below the threshold (default green). */
  tone?: VizTone;
  /** Name of the meter. */
  ariaLabel?: string;
  className?: string;
}

const CELLS = 10;

/** 10 cells for a use-up quota (budget, free tier, disk). Red line = alert level; past it the lit cells are red. The percentage is written next to it. */
export function Battery({ value, threshold, tone = "good", ariaLabel, className }: BatteryProps) {
  const t = useTranslations("viz");
  const shown = known(value) ? clamp(value, 0, 100) : null;
  const lit = shown === null ? 0 : Math.round(shown / (100 / CELLS));
  const over = shown !== null && shown >= threshold;
  const color = over ? toneVar("bad") : toneVar(tone);
  const percent = formatPercent(value);
  const name = ariaLabel ?? percent;
  const tip = t("battery.tip", { value: percent, threshold: formatPercent(threshold) });
  return (
    <PlayOnView className={cx("jr-bat", className)} data-over={over ? "true" : "false"}>
      <span
        className="jr-bat__body jr-tip"
        data-tip={tip}
        style={cssVars({ "--c": color })}
        {...(shown === null
          ? { role: "img", "aria-label": `${name}: —` }
          : { role: "meter", "aria-label": name, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(shown * 10) / 10, "aria-valuetext": `${t("battery.aria", { value: percent, threshold: formatPercent(threshold) })}${over ? `, ${t("battery.over")}` : ""}` })}
      >
        {Array.from({ length: CELLS }, (_, index) => (
          <i key={index} className={index < lit ? "jr-on" : undefined} style={stepStyle(index)} />
        ))}
        <span className="jr-bat__th" aria-hidden style={cssVars({ "--th": clamp(threshold, 0, 100) })} />
      </span>
      <span className="jr-bat__nub" aria-hidden />
      <b className="jr-bat__v">{percent}</b>
    </PlayOnView>
  );
}
