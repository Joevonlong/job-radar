"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { DATE_FIELDS, dateRangeChoice, displayedDateField, formatWithin, parseWithin, type DateField, type DateParams, type WithinRange } from "@/lib/jobs/date-range";
import { cn } from "@/lib/utils";

const labelClass = "text-muted-foreground flex min-w-0 flex-col gap-1 text-xs";
const inputClass = "border-input bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm shadow-xs";

/** The text of a quick range ("Last 7 days", "This month"); 14 days reads "Last 2 weeks". */
export function useWithinLabel(): (range: WithinRange) => string {
  const t = useTranslations("dashboard.jobs.filters");
  return (range) => {
    if (range.kind === "month") return t("rangeMonth");
    return range.days === 14 ? t("rangeTwoWeeks") : t("rangeDays", { count: range.days });
  };
}

/** What the group writes to the URL: every key it owns, so one `set` keeps the date inputs consistent. */
export interface DateFilterChange {
  within?: WithinRange | null;
  dateBy?: DateField | null;
  from?: string | null;
  to?: string | null;
}

/**
 * The date filter of /jobs: which date to compare (`dateBy`), a quick range or a custom pair of dates. Two segmented groups
 * (radio groups: one pick, arrow keys move it); "Custom…" unfolds the two date boxes. A quick range and custom dates exclude each
 * other (picking one clears the other), and anything the group writes carries the date it compares, so a link says what it means.
 * "Custom…" with no dates yet is state the URL cannot hold, so the parent owns `customOpen` (and folds it when the condition is cleared elsewhere).
 * `quickRanges` are the tokens of ui.yaml `filters.date_quick_ranges`; an URL range that is not among them highlights nothing.
 */
export function DateFilter({ params, quickRanges, defaultField, onChange, customOpen, onCustomOpenChange, "data-testid": testId = "date-filter" }: { params: DateParams; quickRanges: readonly string[]; defaultField: DateField; onChange: (change: DateFilterChange) => void; customOpen: boolean; onCustomOpenChange: (open: boolean) => void; "data-testid"?: string }) {
  const t = useTranslations("dashboard.jobs.filters");
  const withinLabel = useWithinLabel();
  const id = useId();
  const field = displayedDateField(params, defaultField);
  const choice = dateRangeChoice(params);

  const ranges = quickRanges.flatMap((token) => {
    const range = parseWithin(token);
    return range ? [{ token: formatWithin(range), range }] : [];
  });
  const rangeValue = customOpen && choice.kind !== "within" ? "custom" : choice.kind === "within" ? (ranges.some((r) => r.token === formatWithin(choice.within)) ? formatWithin(choice.within) : "") : choice.kind === "custom" ? "custom" : "any";
  const showCustom = rangeValue === "custom";


  const pickRange = (value: string) => {
    if (value === "any") {
      onCustomOpenChange(false);
      onChange({ within: null, from: null, to: null, dateBy: null });
    } else if (value === "custom") {
      onCustomOpenChange(true);
      onChange({ within: null, dateBy: field });
    } else {
      onCustomOpenChange(false);
      onChange({ within: parseWithin(value), from: null, to: null, dateBy: field });
    }
  };

  const scrollRow = "max-w-full overflow-x-auto md:overflow-visible";
  const itemClass = "max-md:min-h-[44px]";

  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5 max-md:w-full" data-testid={testId}>
      <legend className="text-muted-foreground mb-1.5 text-xs">{t("dateGroup")}</legend>
      <div className="flex min-w-0 flex-col gap-x-sp-4 gap-y-2 md:flex-row md:flex-wrap md:items-center">
        <div className="flex min-w-0 flex-col gap-1 md:flex-row md:items-center md:gap-2">
          <span className="text-muted-foreground text-xs" id={`${id}-by`}>
            {t("dateBy")}
          </span>
          <div className={scrollRow}>
            <Segmented aria-labelledby={`${id}-by`} value={field} onValueChange={(next) => onChange({ dateBy: DATE_FIELDS.find((v) => v === next) ?? defaultField })} data-testid="date-filter-field">
              {DATE_FIELDS.map((value) => (
                <SegmentedItem key={value} value={value} className={itemClass} title={value === "posted" ? t("postedFallbackHint") : undefined} data-testid={`date-filter-field-${value}`}>
                  {t(value === "posted" ? "dateByPosted" : "dateBySeen")}
                </SegmentedItem>
              ))}
            </Segmented>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1 md:flex-row md:items-center md:gap-2">
          <span className="text-muted-foreground text-xs" id={`${id}-range`}>
            {t("dateRange")}
          </span>
          <div className={scrollRow}>
            <Segmented aria-labelledby={`${id}-range`} value={rangeValue} onValueChange={pickRange} data-testid="date-filter-range">
              <SegmentedItem value="any" className={itemClass} data-testid="date-filter-range-any">
                {t("rangeAny")}
              </SegmentedItem>
              {ranges.map(({ token, range }) => (
                <SegmentedItem key={token} value={token} className={itemClass} data-testid={`date-filter-range-${token}`}>
                  {withinLabel(range)}
                </SegmentedItem>
              ))}
              <SegmentedItem value="custom" className={itemClass} data-testid="date-filter-range-custom">
                {t("rangeCustom")}
              </SegmentedItem>
            </Segmented>
          </div>
        </div>
      </div>
      {showCustom ? (
        <div className={cn("flex min-w-0 flex-col gap-2 md:flex-row md:items-end md:gap-3")}>
          <label className={cn(labelClass, "md:w-44")}>
            {t("from")}
            <input type="date" value={params.from ?? ""} max={params.to ?? undefined} onChange={(e) => onChange({ from: e.target.value === "" ? null : e.target.value, within: null, dateBy: field })} data-testid="filter-from" className={`${inputClass} jb-filter-date`} />
          </label>
          <label className={cn(labelClass, "md:w-44")}>
            {t("to")}
            <input type="date" value={params.to ?? ""} min={params.from ?? undefined} onChange={(e) => onChange({ to: e.target.value === "" ? null : e.target.value, within: null, dateBy: field })} data-testid="filter-to" className={`${inputClass} jb-filter-date`} />
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}
