import { formatPercent } from "@/lib/format/numbers";

import "./viz.css";
import { PlayOnView } from "./motion";
import { clamp, cssVars, cx, known, toneVar, type VizTone } from "./util";

export type RingSize = "s" | "m" | "l";

/** Outer size in px of the three ring sizes (docs/design: S 48 · M 84 · L 110). */
const SIZE_PX: Record<RingSize, number> = { s: 48, m: 84, l: 110 };
const RADIUS = 30;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Free diameter inside the inner hairline, as a share of the ring size: (24 - 1) * 2 / 80, less a little air. */
const INNER_SPACE = 0.52;
/** Width of one character of the centre label in em (Archivo Black digits and the percent sign are wide). */
const GLYPH_EM = 0.85;
/** The centre label is at most this share of the ring size tall (docs/design: 22%). */
const LABEL_MAX = 0.22;

export interface RingProps {
  /** Percentage points, 0-100. Null: an empty ring with `—`. */
  value: number | null | undefined;
  size?: RingSize;
  tone?: VizTone;
  /** Numerator / denominator written next to the ring (`62/135`). */
  caption?: string;
  /** Name of the meter. */
  ariaLabel?: string;
  className?: string;
}

/** Thick ring between two ink hairlines; the percentage in the middle, the fraction next to it. For progress that ends at 100%. */
export function Ring({ value, size = "m", tone = "meter", caption, ariaLabel, className }: RingProps) {
  const shown = known(value) ? clamp(value, 0, 100) : null;
  const px = SIZE_PX[size];
  const offset = CIRCUMFERENCE * (1 - (shown ?? 0) / 100);
  const name = ariaLabel ?? formatPercent(value);
  const centre = formatPercent(value);
  // the label shrinks with its length so "100%" and "8.9%" stay inside the inner hairline (the design's "24%" keeps 22%)
  const labelScale = Math.min(LABEL_MAX, INNER_SPACE / (Math.max(centre.length, 1) * GLYPH_EM));
  return (
    <PlayOnView className={cx("jr-ring-wrap", className)}>
      <span
        className="jr-ring jr-tip"
        data-tip={formatPercent(value)}
        style={cssVars({ "--rs": `${px}px`, "--rl": labelScale.toFixed(3), "--circ": CIRCUMFERENCE.toFixed(1), "--off": offset.toFixed(1) })}
        {...(shown === null
          ? { role: "img", "aria-label": `${name}: —` }
          : { role: "meter", "aria-label": name, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(shown * 10) / 10, "aria-valuetext": formatPercent(shown) })}
      >
        <svg width={px} height={px} viewBox="0 0 80 80" aria-hidden>
          <circle cx="40" cy="40" r="36" fill="none" style={{ stroke: "var(--ink)" }} strokeWidth="2" />
          <circle cx="40" cy="40" r="24" fill="none" style={{ stroke: "var(--ink)" }} strokeWidth="2" />
          <circle cx="40" cy="40" r={RADIUS} fill="none" style={{ stroke: "var(--grid)" }} strokeWidth="10" />
          <circle
            className="jr-ring__arc"
            cx="40"
            cy="40"
            r={RADIUS}
            fill="none"
            style={{ stroke: toneVar(tone) }}
            strokeWidth="10"
            strokeDasharray={CIRCUMFERENCE.toFixed(1)}
            transform="rotate(-90 40 40)"
          />
        </svg>
        <b aria-hidden>{centre}</b>
      </span>
      {caption ? <span className="jr-ring__cap">{caption}</span> : null}
    </PlayOnView>
  );
}
