import { useTranslations } from "next-intl";
import { useAppLocale } from "@/components/viz/intl";

import { INK_LINK } from "@/components/ui/ink-link";
import { Percentile } from "@/components/viz/percentile";
import { SalaryAxis } from "@/components/viz/salary-axis";
import { salaryState, type SalaryAxisScale } from "@/components/viz/salary-shared";
import { isApproxAnnual } from "@/lib/dashboard/salary";
import { baseRangeIn } from "@/lib/domain/salary";
import { formatInteger, formatSalary } from "@/lib/format/numbers";
import type { JobSalary } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

import { Panel, PanelAside } from "./panel";

export interface SalaryCardProps {
  salary: JobSalary | null;
  /** `salary_json` exists (maybe unreadable). */
  salaryDisclosed: boolean;
  /** The posting's salary as text (`describeSalary`), for a salary that has no EUR figure to draw. */
  normalizedText: string | null;
  axis: SalaryAxisScale;
  /** `preferences.yaml: salary_floor_year`; null when it cannot be read. */
  floor: number | null;
  /** Median of this month's stated salaries; null below `ui.yaml: salary_stats.min_sample`. */
  median: number | null;
  /** Share of this month's other stated salaries this one is above; null when unknown. */
  percentile: number | null;
  /** How many stated salaries this month, and how many are needed (for the "not enough" note). */
  sample: { count: number; min: number };
  /** Where the salary panel with every source stands on the page; null when the page has no such panel. */
  panelHref?: string | null;
}

/**
 * "Salary" card of the detail page: the stated annual figure big, on the salary axis with your floor (red line) and the
 * month's median (dashed line), and where it stands among this month's stated salaries. No salary: "未披露", never 0.
 */
export function SalaryCard({ salary, salaryDisclosed, normalizedText, axis, floor, median, percentile, sample, panelHref = null }: SalaryCardProps) {
  const t = useTranslations("dashboard.detail.salary");
  const locale = useAppLocale();
  const currency = axis.currency ?? "";
  const range = salary && salary.qualityStatus !== "review" ? baseRangeIn(salary, currency) : null;
  const min = range?.min ?? null;
  const max = range?.max ?? null;
  const hasFigure = min !== null || max !== null;
  const otherRegion = Boolean(salary?.otherRegion);
  const approx = salary !== null && isApproxAnnual(salary, "base");
  const state = salaryState({ min, max, floor, otherRegion });
  const figure = hasFigure ? formatSalary({ min, max, currency, approx: approx || otherRegion }, { locale }) : null;
  const axisRange = formatSalary({ min: axis.minK * 1000, max: axis.maxK * 1000, currency }, { locale });

  return (
    <Panel id="h-salary" title={t("title")} aside={axisRange ? <PanelAside>{axisRange}</PanelAside> : undefined} bodyClassName="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-testid="salary-card-figure" data-salary-state={state}>
        {figure ? (
          <span
            className={cn(
              "font-display text-num-l w-fit max-w-full whitespace-nowrap",
              state === "stated" ? "border-bw border-border bg-hi text-hi-ink rounded-tag shadow-e2 px-2 py-0.5" : "text-ink-3",
            )}
          >
            {figure}
            <small className={cn("text-data ml-1 font-mono font-normal", state === "stated" ? "text-hi-ink" : "text-ink-3")}>{t("perYear")}</small>
          </span>
        ) : salary !== null || salaryDisclosed ? (
          <span className="text-body text-ink-2 font-mono" data-testid="salary-card-text">
            {normalizedText ?? t("unreadable")}
          </span>
        ) : (
          <span className="font-display text-h2 text-ink-3" data-testid="salary-card-undisclosed">
            {t("undisclosed")}
          </span>
        )}
      </div>
      <SalaryAxis min={min} max={max} axis={axis} floor={floor} median={median} otherRegion={otherRegion} approx={approx} />
      {median !== null ? (
        // what the dashed line is, and over how many jobs: the same wording as /me and /insights (scope + sample)
        <p className="text-ink-2 text-data font-mono" data-testid="salary-median">
          {t("median", { count: formatInteger(sample.count, locale), amount: formatSalary({ min: median, max: median, currency }, { locale }) ?? "" })}
        </p>
      ) : null}
      {salary !== null && !hasFigure && normalizedText !== null ? <p className="text-ink-3 text-body-sm">{t("noEur", { currency: salary.currency ?? "?" })}</p> : null}
      {state === "below_floor" ? <p className="text-ink-2 text-body-sm">{t("belowFloor")}</p> : null}
      {otherRegion ? <p className="text-ink-2 text-body-sm">{t("otherRegion")}</p> : null}
      {hasFigure && !otherRegion ? (
        percentile !== null ? (
          <Percentile value={percentile} />
        ) : (
          <p className="text-ink-3 text-body-sm" data-testid="salary-no-sample">
            {t("noSample", { count: sample.count, min: sample.min })}
          </p>
        )
      ) : null}
      {panelHref ? (
        <a href={panelHref} className={cn(INK_LINK, "text-body-sm w-fit")} data-testid="salary-card-panel-link">
          {t("panelLink")} <span aria-hidden>↓</span>
        </a>
      ) : null}
    </Panel>
  );
}
