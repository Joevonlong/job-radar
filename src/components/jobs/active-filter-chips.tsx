"use client";

import { useQueryStates } from "nuqs";
import { useTranslations } from "next-intl";

import { FilterChip } from "@/components/ui/badge";
import type { MultiSelectOption } from "@/components/ui/multi-select";
import { useWithinLabel } from "@/components/jobs/date-filter";
import { displayedDateField, effectiveDateRange } from "@/lib/jobs/date-range";
import { SELECT_FILTER_KEYS, type SelectFilterKey } from "@/lib/jobs/filter-keys";
import { jobsSearchParsers } from "@/lib/jobs/search-params";

/**
 * One chip per picked value of the drop-down filters ("City · Berlin ×"), under the search box on every screen size: on a
 * phone the values can be seen and removed without opening the filter sheet. The × removes that one value. (The
 * application statuses are pills that already show their state.)
 */
export function ActiveFilterChips({
  choices,
  traps = false,
  visa = false,
  ghost = false,
  onDateCleared,
}: {
  choices: Record<SelectFilterKey, readonly MultiSelectOption[]>;
  /** show the "AI traps" chip. */
  traps?: boolean;
  /** show the "Visa" chip (hidden: a `visa=` in the URL is ignored and kept). */
  visa?: boolean;
  /** show the "Ghost jobs" chip (hidden: a `ghost=` in the URL is ignored and kept; `ghost=all` is no filter, so no chip). */
  ghost?: boolean;
  /** The date chip's × cleared the date condition (the filter bar folds the empty "Custom…" boxes). */
  onDateCleared?: () => void;
}) {
  const t = useTranslations("dashboard.jobs.filters");
  const tTrap = useTranslations("aiTraps.filter");
  const tVisa = useTranslations("visa.filter");
  const tGhost = useTranslations("ghostJobs.filter");
  // same URL state as the filter bar (nuqs keeps all hooks of a page in sync)
  const [params, setParams] = useQueryStates(jobsSearchParsers, { shallow: false, history: "replace" });

  const chipKeys = SELECT_FILTER_KEYS;
  const chips = chipKeys.flatMap((key) =>
    params[key].map((value) => ({ key, value, label: choices[key].find((o) => o.value === value)?.label ?? value })),
  );
  const remove = (key: SelectFilterKey, value: string) => {
    const next = params[key].filter((v) => v !== value);
    void setParams({ [key]: next.length > 0 ? next : null, page: null });
  };

  // the date condition is one chip: what it compares and the range; its × clears the range, the dates and what they compare
  const withinLabel = useWithinLabel();
  const date = effectiveDateRange(params);
  const dateText = date.within
    ? withinLabel(date.within)
    : date.from && date.to
      ? t("chipSpan", { from: dateEnd(date.from, date.to), to: dateEnd(date.to, date.from) })
      : date.from
        ? t("chipSince", { from: date.from })
        : date.to
          ? t("chipUntil", { to: date.to })
          : null;
  const dateChip = dateText === null ? null : t(displayedDateField(params, "seen") === "posted" ? "chipPosted" : "chipSeen", { range: dateText });

  const trap = traps ? params.trap : null;
  const visaValue = visa ? params.visa : null;
  const ghostValue = ghost && params.ghost !== "all" ? params.ghost : null;

  // the slot keeps the height of one chip row whether or not there are chips, so ticking a filter never moves the list
  if (chips.length === 0 && !dateChip && !trap && !visaValue && !ghostValue) return <div className="min-h-[24.5px]" aria-hidden data-testid="filter-chips-slot" />;

  return (
    <ul className="flex min-h-[24.5px] flex-wrap gap-1.5" aria-label={t("chipsLabel")} data-testid="filter-chips">
      {chips.map(({ key, value, label }) => (
        <li key={`${key}:${value}`}>
          <FilterChip removeLabel={t("removeChip", { key: t(key), value: label })} onRemove={() => remove(key, value)} data-testid="filter-chip" data-key={key} data-value={value} className="max-w-full">
            <span className="min-w-0 truncate">{t("chip", { key: t(key), value: label })}</span>
          </FilterChip>
        </li>
      ))}
      {dateChip ? (
        <li>
          <FilterChip removeLabel={t("removeDateChip", { value: dateChip })} onRemove={() => {
              onDateCleared?.();
              void setParams({ within: null, from: null, to: null, dateBy: null, page: null });
            }} data-testid="filter-chip" data-key="date" data-value={dateChip} className="max-w-full">
            <span className="min-w-0 truncate">{dateChip}</span>
          </FilterChip>
        </li>
      ) : null}
      {trap ? (
        <li>
          <FilterChip removeLabel={tTrap("remove", { value: tTrap(trap) })} onRemove={() => void setParams({ trap: null, page: null })} data-testid="filter-chip" data-key="trap" data-value={trap} className="max-w-full">
            <span className="min-w-0 truncate">{tTrap("chip", { value: tTrap(trap) })}</span>
          </FilterChip>
        </li>
      ) : null}
      {visaValue ? (
        <li>
          <FilterChip removeLabel={tVisa("remove", { value: tVisa(visaValue) })} onRemove={() => void setParams({ visa: null, page: null })} data-testid="filter-chip" data-key="visa" data-value={visaValue} className="max-w-full">
            <span className="min-w-0 truncate">{tVisa("chip", { value: tVisa(visaValue) })}</span>
          </FilterChip>
        </li>
      ) : null}
      {ghostValue ? (
        <li>
          <FilterChip removeLabel={tGhost("remove", { value: tGhost(ghostValue) })} onRemove={() => void setParams({ ghost: null, page: null })} data-testid="filter-chip" data-key="ghost" data-value={ghostValue} className="max-w-full">
            <span className="min-w-0 truncate">{tGhost("chip", { value: tGhost(ghostValue) })}</span>
          </FilterChip>
        </li>
      ) : null}
    </ul>
  );
}

/** A date of a custom span as the chip shows it: month-day when both ends are in one year, else the whole date. */
function dateEnd(date: string, other: string): string {
  return date.slice(0, 4) === other.slice(0, 4) ? date.slice(5) : date;
}
