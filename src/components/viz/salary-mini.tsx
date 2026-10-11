import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { formatSalary } from "@/lib/format/numbers";

import "./viz.css";
import { useAppLocale } from "./intl";
import { PlayOnView } from "./motion";
import { axisPosition, salarySpan, salaryState, type SalaryAxisScale } from "./salary-shared";
import { cssVars, cx, known, pctStyle } from "./util";

export interface SalaryMiniProps {
  /** Stated salary bounds, EUR a year. Both missing: "未披露". */
  min?: number | null;
  max?: number | null;
  axis: SalaryAxisScale;
  floor?: number | null;
  otherRegion?: boolean;
  approx?: boolean;
  /** The posting's own wording of the figure (`$140–170k`). Default: the formatted EUR range. */
  figure?: string | null;
  /** Share of disclosed jobs this one pays more than, 0-100 ("高于 72% 已披露岗位"). */
  percentile?: number | null;
  /** Replaces the line under the axis. */
  note?: ReactNode;
  className?: string;
}

/** The figure, a thin axis with the floor as a red tick, and one line of context. For table rows. */
export function SalaryMini({ min, max, axis, floor, otherRegion = false, approx = false, figure, percentile, note, className }: SalaryMiniProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const state = salaryState({ min, max, floor, otherRegion });
  const span = salarySpan(min, max, axis);
  const currency = axis.currency ?? "";
  const converted = formatSalary({ min, max, currency, approx: approx || otherRegion }, { locale });
  const plain = formatSalary({ min, max, currency, approx }, { locale });
  const headline = state === "none" ? t("undisclosed") : (figure ?? plain ?? t("undisclosed"));
  const floorText = known(floor) ? formatSalary({ min: floor, max: floor, currency }, { locale }) : null;
  const tip = state === "none" ? t("salary.none") : `${headline}${floorText ? ` · ${t("salary.miniTip", { floor: floorText })}` : ""}`;

  let line: ReactNode = note;
  if (line === undefined) {
    if (state === "none") line = t("salary.noneShort");
    else if (state === "below_floor") line = t("salary.belowFloor");
    else if (state === "other_region") line = t("salary.otherRegion", { range: converted ?? "" });
    else if (known(percentile)) line = t("salary.percentile", { value: Math.round(percentile) });
    else line = null;
  }

  return (
    <PlayOnView
      as="div"
      className={cx("jr-salm jr-tip", state === "none" && "jr-salm--none", state === "below_floor" && "jr-salm--muted", state === "other_region" && "jr-salm--other", className)}
      data-tip={tip}
      data-salary-state={state}
    >
      <span className={cx("jr-salm__f", state !== "stated" && "jr-muted")}>{headline}</span>
      <div className="jr-salm__t" aria-hidden>
        {span ? <i className="jr-grow jr-grow--6" {...(span.open ? { "data-open": span.open } : {})} style={cssVars({ left: pctStyle(span.left), width: pctStyle(span.width), minWidth: "4px", "--o": span.open === "start" ? "right" : "left" })} /> : null}
        {known(floor) ? <u style={{ left: pctStyle(axisPosition(floor, axis)) }} /> : null}
      </div>
      {line ? <span className="jr-salm__n">{line}</span> : null}
    </PlayOnView>
  );
}
