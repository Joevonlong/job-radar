import { useTranslations } from "next-intl";

import { formatSalary } from "@/lib/format/numbers";

import "./viz.css";
import { useAppLocale } from "./intl";
import { PlayOnView } from "./motion";
import { axisPosition, axisTicks, freeGap, markerLabelPlan, salarySpan, salaryState, type SalaryAxisScale } from "./salary-shared";
import { cssVars, cx, known, pctStyle } from "./util";

export interface SalaryAxisProps {
  /** Stated salary bounds, EUR a year (converted figures included). Both null / missing: "未披露". */
  min?: number | null;
  max?: number | null;
  /** Scale from `ui.yaml` (see `salaryAxisScale`). */
  axis: SalaryAxisScale;
  /** The user's salary floor, EUR a year (`preferences.yaml: salary_floor_year`): the red line. */
  floor?: number | null;
  /** Median of the stated salaries, EUR a year: the dashed line. Omit to leave it out. */
  median?: number | null;
  /** The figure is probably another region's pay (hatched block). */
  otherRegion?: boolean;
  /** The amounts were converted (`≈`). */
  approx?: boolean;
  /** The posting's own wording of the figure (`$140–170k`), shown in the tooltip before the converted range. */
  figure?: string | null;
  /**
   * Accessible name of the block when it is not one job's yearly salary (the range of many jobs, `/me`): replaces "年薪 {range}"
   * (write the range into it). Where the block runs past the axis, and the floor and the median, are appended as usual.
   */
  ariaLabel?: string;
  className?: string;
}

/**
 * Salary axis of the detail page. Yellow block = stated range, red line = your floor, dashed line = median.
 * Four looks: stated, below the floor (grey), another region (hatched), not disclosed (dashed frame).
 */
export function SalaryAxis({ min, max, axis, floor, median, otherRegion = false, approx = false, figure, ariaLabel, className }: SalaryAxisProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const state = salaryState({ min, max, floor, otherRegion });
  const span = salarySpan(min, max, axis);
  const currency = axis.currency ?? "";
  const converted = formatSalary({ min, max, currency, approx: approx || otherRegion }, { locale });
  const tip = figure && converted ? t("salary.approxTip", { range: figure, approx: converted }) : (figure ?? converted ?? "");
  const floorK = known(floor) ? Math.round(floor / 100) / 10 : null;
  const medianK = known(median) ? Math.round(median / 100) / 10 : null;
  const ticks = axisTicks(axis);
  // labels that would collide (floor close to median) go on a second row above; a side keeps a label off the other marker's line and inside the box
  const floorAt = known(floor) ? axisPosition(floor, axis) : null;
  const medianAt = known(median) ? axisPosition(median, axis) : null;
  const { floorRow, medianRow, floorSide, medianSide } = markerLabelPlan(floorAt, medianAt);
  const labelRows = Math.max(floorRow, medianRow) + 1;
  const segments = (axis.maxK - axis.minK) / axis.tickStepK;

  // the "not disclosed" label stands in the widest gap between the markers, never on top of one
  const noneGap = state === "none" ? freeGap([floorAt, medianAt]) : null;
  const clipNote = span?.clip ? `${span.clip !== "end" ? t("salary.ariaClipStart", { value: axis.minK }) : ""}${span.clip !== "start" ? t("salary.ariaClipEnd", { value: axis.maxK }) : ""}` : "";

  const aria =
    state === "none"
      ? t("salary.ariaNone")
      : `${ariaLabel ?? t("salary.aria", { range: converted ?? "" })}${clipNote}${floorK !== null ? t("salary.ariaFloor", { value: floorK }) : ""}${medianK !== null ? t("salary.ariaMedian", { value: medianK }) : ""}`;

  return (
    <PlayOnView
      as="div"
      className={cx("jr-sax", state === "below_floor" && "jr-sax--muted", state === "other_region" && "jr-sax--other", state === "none" && "jr-sax--none", className)}
      data-label-rows={labelRows}
      style={cssVars({ "--jr-ticks": segments, "--jr-label-rows": labelRows })}
      role="img"
      aria-label={aria}
      data-salary-state={state}
    >
      <div className="jr-sax__t" />
      {span ? (
        <div
          className="jr-sax__r jr-grow jr-tip"
          data-tip={tip}
          {...(span.open ? { "data-open": span.open } : {})}
          {...(span.clip ? { "data-clip": span.clip } : {})}
          style={cssVars({ left: pctStyle(span.left), width: pctStyle(span.width), minWidth: "6px", "--o": span.open === "start" ? "right" : "left", "--k": 0.8 })}
        />
      ) : null}
      {floorK !== null && known(floor) ? (
        <span className="jr-sax__f jr-tip" style={cssVars({ left: pctStyle(axisPosition(floor, axis)), "--jr-row": floorRow })} data-label-row={floorRow} data-side={floorSide ?? undefined} data-l={t("salary.floor", { value: floorK })} data-tip={t("salary.floorTip")} />
      ) : null}
      {medianK !== null && known(median) ? (
        <span className="jr-sax__m jr-tip" style={cssVars({ left: pctStyle(axisPosition(median, axis)), "--jr-row": medianRow })} data-label-row={medianRow} data-side={medianSide ?? undefined} data-l={t("salary.median", { value: medianK })} data-tip={t("salary.medianTip")} />
      ) : null}
      {state === "none" && noneGap ? (
        <span className="jr-sax__none jr-tip" data-tip={t("salary.noneTip")} style={cssVars({ left: pctStyle(noneGap.center) })}>
          {t("salary.none")}
        </span>
      ) : null}
      {ticks.map((tick) => (
        <span key={tick} className="jr-sax__l" style={{ left: pctStyle(axisPosition(tick * 1000, axis)) }} aria-hidden>
          {tick}
        </span>
      ))}
    </PlayOnView>
  );
}
