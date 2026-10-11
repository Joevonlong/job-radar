import { formatPercent } from "@/lib/format/numbers";

import "./viz.css";
import { PlayOnView } from "./motion";
import { clamp, cssVars, cx, known, toneVar, type VizTone, stepStyle } from "./util";

export interface SegBlocksProps {
  /** Percentage points, 0-100. Null: empty dashed cells and `—`. */
  value: number | null | undefined;
  /** Number of cells (default 10: each is 10%). */
  cells?: number;
  tone?: VizTone;
  /** Text next to the cells. Default: the percentage. `false`: none (then give `ariaLabel`). */
  label?: string | false;
  ariaLabel?: string;
  className?: string;
}

/** 10 cells for a rough share where there is no room for a bar: card corners, phones. */
export function SegBlocks({ value, cells = 10, tone = "ink", label, ariaLabel, className }: SegBlocksProps) {
  const isKnown = known(value);
  const shown = isKnown ? clamp(value, 0, 100) : null;
  const lit = shown === null ? 0 : Math.round(shown / (100 / cells));
  const text = label === false ? null : (label ?? formatPercent(value));
  const name = ariaLabel ?? (typeof text === "string" ? text : "%");
  const items = Array.from({ length: cells }, (_, index) => <i key={index} className={cx(index < lit && "jr-on", shown === null && "jr-unk")} style={stepStyle(index)} />);
  return (
    <PlayOnView className={cx("jr-ratio", className)} style={{ width: "auto" }}>
      <span
        className="jr-cells"
        {...(shown === null
          ? { role: "img", "aria-label": `${name}: —` }
          : { role: "meter", "aria-label": name, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(shown * 10) / 10, "aria-valuetext": formatPercent(shown) })}
        style={cssVars({ "--c": toneVar(tone) })}
      >
        {items}
      </span>
      {text === null ? null : <b>{text}</b>}
    </PlayOnView>
  );
}
