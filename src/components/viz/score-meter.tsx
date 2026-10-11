import { useTranslations } from "next-intl";

import { scoreTone } from "@/lib/dashboard/score";
import { formatScoreValue } from "@/lib/format/numbers";

import "./viz.css";
import { NumberRoll } from "./number-roll";
import { PlayOnView } from "./motion";
import { clamp, cssVars, cx, known, pctStyle, stepStyle } from "./util";

export type ScoreMeterSize = "sm" | "md" | "xl";

export interface ScoreMeterProps {
  /** The rank value: 0-100 for a match score, up to 100 + the bonus cap with signals. The number shows it as it is (106 stays 106); the cells stop at full and mark the overflow. Null = not scored yet: shows `—` and "等待打分", never 0. */
  value: number | null | undefined;
  /** Score at which a job is pushed (`notify.yaml: push_min_score`). Drawn as the red triangle. */
  pushLine: number;
  /** `sm`: 10 cells (lists, phones) · `md`: 20 cells · `xl`: 20 big cells and the 72px number (detail page, once per page). */
  size?: ScoreMeterSize;
  /** AI match score and signal bonus, shown after the band name (`· 78+10`). Not shown at `sm`. */
  match?: number | null;
  bonus?: number | null;
  /** Largest value the rank can reach (`100 + interests.yaml: bonus_cap`): `aria-valuemax`. Default 100; a value above it raises it, so the meter never reports a value past its own maximum. */
  max?: number;
  className?: string;
}

const CELLS: Record<ScoreMeterSize, number> = { sm: 10, md: 20, xl: 20 };

/**
 * Rank value: the number with `/100`, a row of 20 (or 10) cells, 5 points (10) per cell, and the band name next
 * to it. The cells are one colour (`--meter`): the band is written, not coloured. The red triangle is the push line.
 */
export function ScoreMeter({ value, pushLine, size = "md", match, bonus, max = 100, className }: ScoreMeterProps) {
  const t = useTranslations("viz");
  const cells = CELLS[size];
  const isKnown = known(value);
  // C3: the number is the real value (never cut at 100); only the cells stop at full
  const shown = isKnown ? Math.max(0, value) : null;
  const perCell = 100 / cells;
  const lit = shown === null ? 0 : Math.round(clamp(shown, 0, 100) / perCell);
  const over = shown === null ? 0 : Math.max(0, Math.round(shown) - 100);
  const cut = Math.round(clamp(pushLine, 0, 100) / perCell);
  const band = shown === null ? t("band.pending") : t(`band.${scoreTone(shown)}`);
  const showSplit = shown !== null && size !== "sm" && known(match) && known(bonus);
  const bandText = showSplit ? `${band} · ${formatScoreValue(match)}+${formatScoreValue(bonus)}` : band;
  const valueNow = shown === null ? null : Math.round(shown);
  const valueText =
    shown === null || valueNow === null
      ? t("score.pending")
      : showSplit
        ? t("score.valueTextSplit", { value: valueNow, band, match: formatScoreValue(match), bonus: formatScoreValue(bonus) })
        : `${t("score.valueText", { value: valueNow })}, ${band}`;
  const tip = shown === null ? t("score.tipPending", { line: pushLine }) : t("score.tip", { value: valueNow ?? 0, line: pushLine });

  const cellsView = Array.from({ length: cells }, (_, index) => <i key={index} className={cx(index < lit && "jr-on", over > 0 && index === cells - 1 && "jr-over")} style={stepStyle(index)} />);
  const meterProps =
    shown === null
      ? ({ role: "img", "aria-label": `${t("score.label")}: ${t("score.pending")}` } as const)
      : ({ role: "meter", "aria-label": t("score.label"), "aria-valuemin": 0, "aria-valuemax": Math.max(max, valueNow ?? 0), "aria-valuenow": valueNow ?? 0, "aria-valuetext": valueText } as const);

  return (
    <PlayOnView className={cx("jr-score", `jr-score--${size}`, shown === null && "jr-score--pending", className)} data-score={shown === null ? "pending" : "set"}>
      <span className="jr-score__n">
        {shown === null ? (
          <span aria-hidden>—</span>
        ) : (
          <>
            <NumberRoll value={Math.round(shown)} />
            {/* "/100" and the overflow chip are one group on the number's baseline, right next to it */}
            <span className="jr-score__x">
              <small className="jr-score__d">/100</small>
              {over > 0 ? (
                <small className="jr-score__o" data-over={over} aria-hidden>
                  +{over}
                </small>
              ) : null}
            </span>
          </>
        )}
      </span>
      <span className="jr-score__t">
        <span {...meterProps} className={cx("jr-segm jr-tip", `jr-segm--${size}`, shown === null && "jr-segm--pending")} style={cssVars({ "--cut": pctStyle((cut / cells) * 100) })} data-tip={tip}>
          {cellsView}
        </span>
        <span className="jr-score__b">{bandText}</span>
      </span>
    </PlayOnView>
  );
}
