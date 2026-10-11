import { useTranslations } from "next-intl";

import { formatScoreValue } from "@/lib/format/numbers";

import "./viz.css";
import { PlayOnView } from "./motion";
import { clamp, cssVars, cx, known, pctStyle } from "./util";

export interface ScoreCompositionProps {
  /** AI match score (0-100). Null = not scored: a hatched bar saying so. */
  match: number | null | undefined;
  /** Signal bonus, already capped or not (it is capped at `bonusCap` here). */
  bonus: number | null | undefined;
  /** Largest signal bonus (`interests.yaml` cap); the bar spans `100 + bonusCap` points. */
  bonusCap: number;
  /** Push line, marked on the scale. */
  pushLine: number;
  className?: string;
}

/**
 * A segment narrower than this share of the bar cannot hold its number ("+10" needs about 35 px with its padding, the bar is 250 px or more
 * wide): the number stands above the segment instead of being cut ("+1").
 */
const NARROW_SEGMENT_PERCENT = 14;

/**
 * Stacked bar of the rank value: ink = AI match score, gold = signal bonus, on a 0 to 100 + cap scale.
 * The numbers are written inside the segments (above them when a segment is too narrow to hold one); the scale underneath names the push line.
 */
export function ScoreComposition({ match, bonus, bonusCap, pushLine, className }: ScoreCompositionProps) {
  const t = useTranslations("viz");
  const scale = 100 + Math.max(0, bonusCap);

  if (!known(match)) {
    return (
      <div className={cx("jr jr-comp", className)} role="img" aria-label={t("composition.ariaPending")}>
        <div className="jr-comp__bar">
          <i className="jr-comp__x jr-hatch" style={{ width: "100%" }}>
            <span className="jr-clip">{t("composition.pending")}</span>
          </i>
        </div>
      </div>
    );
  }

  const matchValue = clamp(match, 0, 100);
  const bonusValue = clamp(known(bonus) ? bonus : 0, 0, Math.max(0, bonusCap));
  const matchWidth = (matchValue / scale) * 100;
  const bonusWidth = (bonusValue / scale) * 100;
  const matchText = formatScoreValue(matchValue);
  const bonusText = formatScoreValue(bonusValue);
  const matchOut = matchWidth < NARROW_SEGMENT_PERCENT;
  const bonusOut = bonusValue > 0 && bonusWidth < NARROW_SEGMENT_PERCENT;

  return (
    <PlayOnView as="div" className={cx("jr-comp", className)} role="img" aria-label={t("composition.aria", { match: matchText, bonus: bonusText })}>
      {matchOut || bonusOut ? (
        // the label of a segment too narrow for it: above the bar, its colour square says which segment it belongs to; it ends where the segment ends (at the end of the bar when both labels are out: they would meet)
        <div className="jr-comp__out" aria-hidden data-testid="comp-out">
          {matchOut ? (
            <span data-seg="m" style={{ left: 0 }}>
              {t("composition.match", { value: matchText })}
            </span>
          ) : null}
          {bonusOut ? (
            <span data-seg="b" style={{ right: matchOut ? 0 : pctStyle(100 - matchWidth - bonusWidth) }}>
              {t("composition.bonus", { value: bonusText })}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="jr-comp__bar">
        <i className="jr-comp__m jr-grow jr-tip" data-tip={t("composition.matchTip", { value: matchText })} style={{ width: pctStyle(matchWidth) }}>
          {matchOut ? null : <span className="jr-clip">{t("composition.match", { value: matchText })}</span>}
        </i>
        {bonusValue > 0 ? (
          <i className="jr-comp__b jr-grow jr-tip" data-tip={t("composition.bonusTip", { value: bonusText, cap: bonusCap })} style={cssVars({ "--k": 1, width: pctStyle(bonusWidth) })}>
            {bonusOut ? null : <span className="jr-clip">{t("composition.bonus", { value: bonusText })}</span>}
          </i>
        ) : null}
        <i className="jr-comp__x" style={{ flex: 1 }} />
      </div>
      <div className="jr-comp__lg" aria-hidden>
        <span style={{ left: 0 }}>0</span>
        <span data-line style={{ left: pctStyle((clamp(pushLine, 0, scale) / scale) * 100) }}>
          {t("composition.pushLine", { value: pushLine })}
        </span>
        <span style={{ left: pctStyle((100 / scale) * 100) }}>100</span>
        <span style={{ left: "100%" }}>{scale}</span>
      </div>
    </PlayOnView>
  );
}
