"use client";

import { useTranslations } from "next-intl";

import "@/components/viz/viz.css";
import { SalaryAxis, type SalaryAxisScale } from "@/components/viz";
import { useAppLocale } from "@/components/viz/intl";
import { cx } from "@/components/viz/util";
import { formatInteger, formatPercent, formatSalary } from "@/lib/format/numbers";
import { isBelowFloor, previewFloor, shownSalary, type SalaryMedian, type StatedSalary } from "@/lib/profile/floor-preview";

/** The slider moves in this many steps per axis tick (a tick is 20k by default: steps of 5k). */
const STEPS_PER_TICK = 4;

interface FloorPreviewProps {
  /** This month's stated salaries (`listMonthStatedSalaries`), sorted ascending. */
  salaries: readonly StatedSalary[];
  axis: SalaryAxisScale;
  /** The dashed median line: the detail page's definition (`summarizeMonthSalaries`), not a median of the strip below. */
  median: SalaryMedian;
  /** The floor as typed in the field (EUR a year); not a valid number = no preview, the slider rests at the axis start. */
  floorText: string;
  onFloorChange: (text: string) => void;
  /** Id of the salary input: the slider is for sighted pointer users, the field stays the way to type. */
  inputId: string;
}

function parseFloor(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Salary floor with a live consequence (design system `s-me`): a slider moves the red line on the salary
 * axis and says how many of this month's disclosed jobs the hard filter would drop at that floor; one cell per
 * disclosed job shows which ones. The count is `previewFloor`, the filter's own rule. Nothing is written here:
 * the slider only edits the draft, Save writes it.
 */
export function FloorPreview({ salaries, axis, median, floorText, onFloorChange, inputId }: FloorPreviewProps) {
  const t = useTranslations("profile.floorPreview");
  const locale = useAppLocale();
  const floor = parseFloor(floorText);
  // the block on the axis is the span of the local salaries; another region's pay is in the strip (and the count), not here
  const shown = salaries.filter((salary) => salary.otherRegion !== true).map(shownSalary);
  const otherRegionCount = salaries.length - shown.length;
  const low = shown.length > 0 ? Math.min(...shown) : null;
  const high = shown.length > 0 ? Math.max(...shown) : null;
  // what the yellow block is: the span of this month's stated salaries (many jobs), not one job's salary
  const currency = axis.currency ?? "";
  const spanText = low === null || high === null ? null : formatSalary({ min: low, max: high, currency }, { locale });
  const clipped = high !== null && high > axis.maxK * 1000;
  const preview = floor === null ? null : previewFloor(salaries, floor);
  const step = (axis.tickStepK * 1000) / STEPS_PER_TICK;

  const summary =
    preview === null
      ? t("noFloor")
      : preview.total === 0
        ? t("noJobs")
        : t("drops", { filtered: formatInteger(preview.filtered, locale), total: formatInteger(preview.total, locale), percent: formatPercent(preview.percent) });

  return (
    <div className="flex flex-col gap-3" data-testid="floor-preview">
      <b className="font-display text-num-m" data-testid="floor-value">
        {floor === null ? "—" : formatSalary({ min: floor, max: floor, currency }, { locale })}
      </b>
      <input
        type="range"
        className="accent-bad w-full cursor-pointer"
        aria-label={t("slider")}
        aria-controls={inputId}
        min={axis.minK * 1000}
        max={axis.maxK * 1000}
        step={step}
        value={floor === null ? axis.minK * 1000 : Math.min(Math.max(floor, axis.minK * 1000), axis.maxK * 1000)}
        onChange={(event) => onFloorChange(event.target.value)}
      />
      {/* two different numbers, two lines: what the floor does (line 1), and the month's median it is measured against (line 2, with its own scope) */}
      <div className="border-border flex flex-col gap-1.5 border-t-bw pt-3" data-testid="floor-summary">
        <p className="font-mono text-data" role="status" data-testid="floor-drop" data-filtered={preview?.filtered ?? ""} data-total={preview?.total ?? ""}>
          {preview !== null && preview.total > 0 ? (
            <>
              {t("dropsLead")} <b className="font-display text-num-s text-bad">{formatInteger(preview.filtered, locale)}</b> / {formatInteger(preview.total, locale)} {t("dropsTail", { percent: formatPercent(preview.percent) })}
            </>
          ) : (
            summary
          )}
        </p>
        <p className="text-ink-2 font-mono text-data" data-testid="floor-median" data-count={median.count}>
          {median.value === null
            ? t("medianFew", { count: formatInteger(median.count, locale), min: formatInteger(median.minSample, locale) })
            : t("median", { count: formatInteger(median.count, locale), amount: formatSalary({ min: median.value, max: median.value, currency }, { locale }) ?? "" })}
        </p>
      </div>
      <SalaryAxis min={low} max={high} axis={axis} floor={floor} median={median.value} {...(spanText === null ? {} : { ariaLabel: t("axisAria", { range: spanText }) })} />
      {spanText === null ? null : (
        <p className="text-ink-3 font-mono text-data-sm" data-testid="floor-axis-legend">
          {t("axisLegend", { range: spanText })}
          {clipped ? ` ${t("axisClipped", { max: axis.maxK })}` : ""}
        </p>
      )}
      {salaries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-0.5" role="img" aria-label={`${t("strip")}: ${summary}`} data-testid="floor-strip">
            {salaries.map((salary, index) => {
              const dropped = floor !== null && isBelowFloor(salary, floor);
              return (
                <i
                  key={index}
                  aria-hidden="true"
                  className={cx("jr-tip border-border h-4 w-[0.4375rem] rounded-cell border-[1.5px] transition-colors duration-base", dropped ? "bg-bad" : "bg-hi", salary.otherRegion === true && "jr-hatch")}
                  data-dropped={dropped ? "true" : "false"}
                  data-other-region={salary.otherRegion === true ? "true" : undefined}
                  data-tip={formatSalary({ min: salary.min, max: salary.max, currency }, { locale }) ?? ""}
                />
              );
            })}
          </div>
          <p className="text-ink-3 font-mono text-data-sm">{t("stripNote")}</p>
          {otherRegionCount > 0 ? (
            <p className="text-ink-3 font-mono text-data-sm" data-testid="floor-other-region">
              {t("otherRegion", { count: formatInteger(otherRegionCount, locale) })}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-ink-3 font-mono text-data-sm">{t("noJobs")}</p>
      )}
      <p className="text-ink-3 font-mono text-data-sm">{t("previewOnly")}</p>
    </div>
  );
}
