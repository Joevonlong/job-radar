import { formatPercent } from "@/lib/format/numbers";

import "./viz.css";
import { PlayOnView } from "./motion";
import { PercentText } from "./percent";
import { clamp, cssVars, cx, known, toneVar, type VizTone, stepStyle } from "./util";

export interface WaffleProps {
  /** Percentage points, 0-100; one cell per percent. Null: all cells dashed and `—`. */
  value: number | null | undefined;
  /** `s` 6px cells · `m` 10px cells. */
  size?: "s" | "m";
  tone?: VizTone;
  /** Print the percentage next to the grid (default). */
  showValue?: boolean;
  /** Name of the meter. */
  ariaLabel?: string;
  className?: string;
}

/** 10 x 10 cells, one per percent, lit one after the other. The single-share chart you can count. */
export function Waffle({ value, size = "m", tone = "meter", showValue = true, ariaLabel, className }: WaffleProps) {
  const shown = known(value) ? clamp(value, 0, 100) : null;
  const lit = shown === null ? 0 : Math.round(shown);
  const name = ariaLabel ?? formatPercent(value);
  return (
    <PlayOnView className={cx("jr-waf-wrap", className)}>
      <span
        className={cx("jr-waf jr-tip", size === "s" && "jr-waf--s")}
        data-tip={formatPercent(value)}
        style={cssVars({ "--c": toneVar(tone) })}
        {...(shown === null
          ? { role: "img", "aria-label": `${name}: —` }
          : { role: "meter", "aria-label": name, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(shown * 10) / 10, "aria-valuetext": formatPercent(shown) })}
      >
        {Array.from({ length: 100 }, (_, index) => (
          <i key={index} className={cx(index < lit && "jr-on", shown === null && "jr-unk")} style={stepStyle(index)} />
        ))}
      </span>
      {showValue ? <PercentText value={value} size={size === "s" ? "m" : "l"} /> : null}
    </PlayOnView>
  );
}
