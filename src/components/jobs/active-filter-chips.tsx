"use client";

import { useQueryStates } from "nuqs";
import { useTranslations } from "next-intl";

import { FilterChip } from "@/components/ui/badge";
import type { MultiSelectOption } from "@/components/ui/multi-select";
import { SELECT_FILTER_KEYS, type SelectFilterKey } from "@/lib/jobs/filter-keys";
import { jobsSearchParsers } from "@/lib/jobs/search-params";

/**
 * One chip per picked value of the drop-down filters ("City · Berlin ×"), under the search box on every screen size: on a
 * phone the values can be seen and removed without opening the filter sheet. The × removes that one value. (The
 * application statuses are pills that already show their state.)
 */
export function ActiveFilterChips({ choices, traps = false }: { choices: Record<SelectFilterKey, readonly MultiSelectOption[]>; /** show the "AI traps" chip. */ traps?: boolean }) {
  const t = useTranslations("dashboard.jobs.filters");
  const tTrap = useTranslations("aiTraps.filter");
  // same URL state as the filter bar (nuqs keeps all hooks of a page in sync)
  const [params, setParams] = useQueryStates(jobsSearchParsers, { shallow: false, history: "replace" });

  const chips = SELECT_FILTER_KEYS.flatMap((key) =>
    params[key].map((value) => ({ key, value, label: choices[key].find((o) => o.value === value)?.label ?? value })),
  );
  const remove = (key: SelectFilterKey, value: string) => {
    const next = params[key].filter((v) => v !== value);
    void setParams({ [key]: next.length > 0 ? next : null, page: null });
  };

  const trap = traps ? params.trap : null;

  // the slot keeps the height of one chip row whether or not there are chips, so ticking a filter never moves the list
  if (chips.length === 0 && !trap) return <div className="min-h-[24.5px]" aria-hidden data-testid="filter-chips-slot" />;

  return (
    <ul className="flex min-h-[24.5px] flex-wrap gap-1.5" aria-label={t("chipsLabel")} data-testid="filter-chips">
      {chips.map(({ key, value, label }) => (
        <li key={`${key}:${value}`}>
          <FilterChip removeLabel={t("removeChip", { key: t(key), value: label })} onRemove={() => remove(key, value)} data-testid="filter-chip" data-key={key} data-value={value} className="max-w-full">
            <span className="min-w-0 truncate">{t("chip", { key: t(key), value: label })}</span>
          </FilterChip>
        </li>
      ))}
      {trap ? (
        <li>
          <FilterChip removeLabel={tTrap("remove", { value: tTrap(trap) })} onRemove={() => void setParams({ trap: null, page: null })} data-testid="filter-chip" data-key="trap" data-value={trap} className="max-w-full">
            <span className="min-w-0 truncate">{tTrap("chip", { value: tTrap(trap) })}</span>
          </FilterChip>
        </li>
      ) : null}
    </ul>
  );
}
