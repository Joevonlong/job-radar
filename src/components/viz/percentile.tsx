import { useTranslations } from "next-intl";

import "./viz.css";
import { PlayOnView } from "./motion";
import { clamp, cssVars, cx, known, pctStyle } from "./util";

export interface PercentileProps {
  /** Share of disclosed jobs this one pays more than, 0-100. Null: not disclosed. */
  value: number | null | undefined;
  className?: string;
}

/** A bar and "高于 72% 已披露岗位". With no figure it says so instead of drawing an empty bar as 0. */
export function Percentile({ value, className }: PercentileProps) {
  const t = useTranslations("viz");
  if (!known(value)) {
    return (
      <span className={cx("jr jr-pctl", className)}>
        <span className="jr-pbar-track" aria-hidden style={{ borderStyle: "dashed" }} />
        <span>{t("percentile.none")}</span>
      </span>
    );
  }
  const shown = clamp(value, 0, 100);
  const text = t("percentile.above", { value: Math.round(shown) });
  return (
    <PlayOnView className={cx("jr-pctl", className)}>
      <span className="jr-pbar-track" role="meter" aria-label={text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown)} aria-valuetext={text}>
        <i className="jr-grow" style={cssVars({ width: pctStyle(shown) })} />
      </span>
      <span>{text}</span>
    </PlayOnView>
  );
}
