"use client";

import { debounce, useQueryStates } from "nuqs";
import { ArrowDown, ArrowUp, Search, SlidersHorizontal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useLayoutEffect, useState, useTransition } from "react";

import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { Button } from "@/components/ui/button";
import { ActiveFilterChips } from "@/components/jobs/active-filter-chips";
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { SingleSelect } from "@/components/ui/single-select";
import { filterOptions } from "@/lib/applications/visibility";
import { knownContract, knownFamily } from "@/lib/dashboard/labels";
import { APPLICATION_FILTER_STATUSES, JOB_SORTS, JOB_STATUSES, type JobSort, JOB_WORKPLACES, MIN_SALARY_MAX, MIN_SCORE_MAX, GHOST_FILTERS, TRAP_FILTERS, VISA_FILTERS, type ApplicationFilterStatus } from "@/lib/jobs/constants";
import { FILTER_KEYS, SELECT_FILTER_KEYS, type FilterKey, type SelectFilterKey } from "@/lib/jobs/filter-keys";
import { cleanMultiValues } from "@/lib/jobs/filter-values";
import { countActiveFilters, hasActiveFilters, jobsSearchParsers, withLegacyKeys } from "@/lib/jobs/search-params";
import { dirParam, effectiveDir, flipDir } from "@/lib/jobs/sort";
import { cn } from "@/lib/utils";
import { useLocalLanguageName } from "@/components/base-currency";

/** How long typing in the search box (or a number box) waits before the URL (and so the server query) updates. */
const SEARCH_DEBOUNCE_MS = 300;
const NUMBER_DEBOUNCE_MS = 500;
/** A pick in a multi-select waits this long for the next one: several picks in a row make one query. */
const MULTI_DEBOUNCE_MS = 400;

export interface CityOption {
  /** The value in the URL and the label shown: the canonical city name. */
  key: string;
  /** A city of preferences.yaml `locations`: listed in its own group first. */
  target: boolean;
}

/** A company of the company drop-down: the display name (value and label) and its job count in the unfiltered list. */
export interface CompanyOption {
  name: string;
  jobCount: number;
}

export interface FilterBarOptions {
  families: string[];
  cities: CityOption[];
  /** The companies with most jobs, most first (ui.yaml `filters.company_options_max` of them at most). */
  companies?: CompanyOption[];
  /** More companies existed than the loaded list could hold. */
  companyOptionsCapped?: boolean;
  /** (ui.yaml `filters`) How many companies are listed before anything is typed. */
  companyOptionsVisible?: number;
  contracts: string[];
  /** Show the "AI traps" control (traps.yaml `enabled`). */
  traps?: boolean;
  /**
   * Show the "Visa" control (ui.yaml `job_checks.visa`, me.yaml `needs_visa_sponsorship`). Hidden: a `visa=` in the URL is
   * ignored but kept (no chip, not counted, "clear" leaves it), so it applies again once the control is back.
   */
  visa?: boolean;
  /** Show the "Ghost jobs" control (ui.yaml `job_checks.ghost.enabled`); hidden, a `ghost=` in the URL is ignored but kept, like `visa`. */
  ghost?: boolean;
  /** (ui.yaml `filters`) Values the lists do not offer (one that is selected in the URL still shows). */
  hiddenWorkplaces?: readonly string[];
  hiddenContracts?: readonly string[];
  /** Names of the high-value signal categories; empty = none, then the "high-value only" button is hidden. */
  highValueNames?: string[];
}

const labelClass = "text-muted-foreground flex min-w-0 flex-col gap-1 text-xs";
const inputClass = "border-input bg-background h-8 w-full min-w-0 rounded-md border px-2 text-sm shadow-xs";
const pillClass = "inline-flex h-8 items-center rounded-full border px-3 text-[13px] transition-colors";
/** The order of the sort drop-down (`JOB_SORTS` appends `salary`; here it sits next to the score). */
const SORT_MENU: readonly JobSort[] = ["rank", "salary", "first_seen", "posted"];

const pillState = (on: boolean) => (on ? "border-primary/50 bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground");

/**
 * Search, filters and sort of /jobs. The URL is the state (nuqs, `shallow: false`): every change
 * re-runs the server page, a reload keeps the filters, and any change returns to page 1.
 *
 * On a phone (< md) the filters are not on the page: a "Filters (n)" button opens them as a full-screen
 * sheet, so the first screen is the search box and the list. The same fields serve both layouts (one DOM
 * copy, CSS decides), so the test ids and the form state are never duplicated.
 */
export function FilterBar({ options }: { options: FilterBarOptions }) {
  const t = useTranslations("dashboard.jobs.filters");
  const ts = useTranslations("signals.filter");
  const languageName = useLocalLanguageName();
  const tc = useTranslations("dashboard");
  const tTrap = useTranslations("aiTraps.filter");
  const tVisa = useTranslations("visa.filter");
  const tGhost = useTranslations("ghostJobs.filter");
  const [pending, startTransition] = useTransition();
  const [params, setParams] = useQueryStates(jobsSearchParsers, { shallow: false, history: "replace", startTransition });
  const [open, setOpen] = useState(false);
  // the phone sheet unfolds the pick lists in place (one at a time); a desktop gets a popover
  const [phone, setPhone] = useState(false);
  const [expandedKey, setExpandedKey] = useState<SelectFilterKey | "sort" | null>(null);
  const panelId = useId();
  // `t12` is the old name of `high`: read as it, cleared whenever the URL is written
  const highOn = (params.high ?? params.t12) === true;
  const hideLangOn = (params.hideLang ?? params.hideGerman) === true;
  const highValueNames = options.highValueNames ?? [];
  const visibility: { ignore: readonly FilterKey[] } = { ignore: [...(options.visa === true ? [] : (["visa"] as const)), ...(options.ghost === true ? [] : (["ghost"] as const))] };
  const activeCount = countActiveFilters(withLegacyKeys(params), visibility);
  const apps = params.app ?? [];
  const hiddenStatuses = useHiddenStatuses();
  const sortDir = effectiveDir(params.sort, params.dir);

  useLayoutEffect(() => {
    // (no matchMedia, e.g. in jsdom: the width at mount decides)
    const query = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 767.98px)") : null;
    const sync = () => setPhone(query ? query.matches : window.innerWidth < 768);
    sync();
    query?.addEventListener("change", sync);
    return () => query?.removeEventListener("change", sync);
  }, []);

  // the phone sheet: Escape closes it, and the page behind it does not scroll
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    if (window.matchMedia?.("(max-width: 767px)").matches) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  const familyLabel = (family: string) => {
    const known = knownFamily(family);
    return known ? tc(`source.${known}`) : family;
  };
  const contractLabel = (contract: string) => {
    const known = knownContract(contract);
    return known ? tc(`contract.${known}`) : contract;
  };
  const appLabel = (status: ApplicationFilterStatus) => (status === "new" ? t("appNew") : tc(`status.${status}`));

  const targetCities = options.cities.filter((c) => c.target);
  const otherCities = options.cities.filter((c) => !c.target);
  // target cities get their own group only when there are others to tell them from
  const grouped = targetCities.length > 0 && otherCities.length > 0;
  const choices: Record<SelectFilterKey, MultiSelectOption[]> = {
    source: options.families.map((family) => ({ value: family, label: familyLabel(family) })),
    city: options.cities.map((city) => (grouped ? { value: city.key, label: city.key, group: city.target ? t("cityTargets") : t("cityOthers") } : { value: city.key, label: city.key })),
    company: (options.companies ?? []).map((company) => ({ value: company.name, label: company.name, count: company.jobCount })),
    workplace: filterOptions(JOB_WORKPLACES, options.hiddenWorkplaces ?? [], params.workplace).map((w) => ({ value: w, label: tc(`workplace.${w}`) })),
    contract: filterOptions(options.contracts, options.hiddenContracts ?? [], params.contract).map((contract) => ({ value: contract, label: contractLabel(contract) })),
    status: JOB_STATUSES.map((s) => ({ value: s, label: tc(`jobStatus.${s}`) })),
  };
  // a bookmarked value that no job has (any more) still shows as selected, and can be unticked
  const withStale = (key: SelectFilterKey): MultiSelectOption[] => {
    const known = new Set(choices[key].map((o) => o.value));
    const missing = params[key].filter((value) => !known.has(value)).map((value) => ({ value, label: value, stale: true }));
    return [...missing, ...choices[key]];
  };
  const layout = phone ? "inline" : "popover";
  // the company list is long: only the first ones are drawn until something is typed, and the note says what is left out
  const companyCount = options.companies?.length ?? 0;
  const companyVisible = options.companyOptionsVisible;
  const companyNote = options.companyOptionsCapped
    ? t("companyNoteCapped", { count: companyCount, shown: Math.min(companyVisible ?? companyCount, companyCount) })
    : companyVisible !== undefined && companyCount > companyVisible
      ? t("companyNoteSearch", { count: companyCount, shown: companyVisible })
      : undefined;
  const searchPlaceholders: Partial<Record<SelectFilterKey, string>> = { city: t("searchCities"), source: t("searchSources"), company: t("searchCompanies") };

  // a change rewrites an old `t12` as `high` and an old `hideGerman` as `hideLang`
  const legacy = {
    ...(params.t12 !== null ? { high: params.high ?? params.t12, t12: null } : {}),
    ...(params.hideGerman !== null ? { hideLang: params.hideLang ?? params.hideGerman, hideGerman: null } : {}),
  };
  const set = (values: Parameters<typeof setParams>[0]) => setParams({ ...legacy, ...values, page: null });
  const setMulti = (key: SelectFilterKey) => (next: string[]) => {
    const values = cleanMultiValues(key, next);
    void setParams({ [key]: values.length > 0 ? values : null, page: null }, { limitUrlUpdates: debounce(MULTI_DEBOUNCE_MS) });
  };
  /** The multi-select closed: the pending pick goes to the URL now. */
  const commitMulti = (key: SelectFilterKey) => () => {
    const values = params[key];
    void setParams({ [key]: values.length > 0 ? values : null, page: null }, { limitUrlUpdates: undefined });
  };
  const toggleApp = (status: ApplicationFilterStatus) => {
    const next = apps.includes(status) ? apps.filter((s) => s !== status) : APPLICATION_FILTER_STATUSES.filter((s) => s === status || apps.includes(s));
    set({ app: next.length > 0 ? next : null });
  };
  const number = (key: "minScore" | "minSalary", max: number) => (raw: string) => {
    const value = raw.trim() === "" ? null : Math.floor(Number(raw));
    if (value !== null && (!Number.isFinite(value) || value < 0)) return;
    void setParams({ [key]: value === null ? null : Math.min(value, max), page: null }, { limitUrlUpdates: debounce(NUMBER_DEBOUNCE_MS) });
  };
  const clear = () => {
    // every filter, from the filter table (sort stays)
    void setParams({ ...Object.fromEntries(FILTER_KEYS.filter((key) => key !== "filtered" && !visibility.ignore.includes(key)).map((key) => [key, null])), t12: null, hideGerman: null, page: null });
  };

  return (
    <form
      role="search"
      aria-label={t("label")}
      aria-busy={pending}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        // Enter applies the text right away instead of waiting for the debounce
        const text = params.q?.trim() ?? "";
        void setParams({ q: text === "" ? null : text, page: null }, { limitUrlUpdates: undefined });
      }}
      data-testid="jobs-filters"
    >
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <input
            type="search"
            name="q"
            value={params.q ?? ""}
            onChange={(event) => {
              // nuqs updates its state at once and the URL after the debounce, so the box never lags behind typing
              void setParams({ q: event.target.value.trim() === "" ? null : event.target.value, page: null }, { limitUrlUpdates: debounce(SEARCH_DEBOUNCE_MS) });
            }}
            placeholder={t("searchPlaceholder")}
            aria-label={t("search")}
            autoComplete="off"
            className="border-input bg-background placeholder:text-muted-foreground h-9 w-full rounded-md border pr-3 pl-8 text-sm shadow-xs"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          className="md:hidden"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(true)}
          data-testid="filter-toggle"
          data-count={activeCount}
        >
          <SlidersHorizontal aria-hidden /> {activeCount > 0 ? t("toggleCount", { count: activeCount }) : t("toggle")}
        </Button>
      </div>

      <ActiveFilterChips choices={choices} traps={options.traps === true} visa={options.visa === true} ghost={options.ghost === true} />

      <div
        id={panelId}
        data-testid="filter-panel"
        data-open={open}
        className={cn("flex-col gap-3 md:flex", open ? "max-md:bg-background max-md:fixed max-md:inset-0 max-md:z-50 max-md:flex" : "max-md:hidden")}
      >
        <div className="border-border flex items-center justify-between border-b px-4 py-3 md:hidden">
          <span className="font-medium">{t("sheetTitle")}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("close")} onClick={() => { setOpen(false); setExpandedKey(null); }} data-testid="filter-close">
            <X aria-hidden />
          </Button>
        </div>

        <div className="flex flex-col gap-3 max-md:flex-1 max-md:overflow-y-auto max-md:px-4 max-md:py-3">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-4 lg:grid-cols-6">
            {SELECT_FILTER_KEYS.map((key) => (
              <MultiSelect
                key={key}
                layout={layout}
                label={t(key)}
                options={withStale(key)}
                value={params[key]}
                onChange={setMulti(key)}
                onCommit={commitMulti(key)}
                searchable={key === "city" || key === "source" || key === "company"}
                {...(searchPlaceholders[key] ? { searchPlaceholder: searchPlaceholders[key] } : {})}
                {...(key === "company" ? { ...(companyVisible !== undefined ? { initialVisible: companyVisible } : {}), ...(companyNote ? { note: companyNote } : {}) } : {})}
                anyLabel={t("any")}
                hint={t("anyOf")}
                expanded={expandedKey === key}
                onExpandedChange={(next) => setExpandedKey(next ? key : null)}
                testId={`filter-${key}`}
                className={layout === "inline" ? "col-span-2" : undefined}
              />
            ))}
            {/* The drop-down and the direction button write the same `sort` / `dir` as the column heads; a new sort starts with its default direction */}
            <div className={cn("flex min-w-0 gap-1.5", layout === "inline" ? "col-span-2 items-start" : "items-end")}>
              <SingleSelect
                layout={layout}
                label={t("sort")}
                options={SORT_MENU.map((s) => ({ value: s, label: t(`sorts.${s}`) }))}
                value={params.sort}
                onChange={(next) => setParams({ sort: JOB_SORTS.find((s) => s === next) ?? "rank", dir: null, page: null })}
                expanded={expandedKey === "sort"}
                onExpandedChange={(next) => setExpandedKey(next ? "sort" : null)}
                testId="filter-sort"
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size={layout === "inline" ? "icon-lg" : "icon"}
                className="shrink-0"
                aria-label={t(sortDir === "asc" ? "dirAscLabel" : "dirDescLabel")}
                title={t(sortDir === "asc" ? "dirAscLabel" : "dirDescLabel")}
                data-testid="filter-sort-dir"
                data-dir={sortDir}
                onClick={() => setParams({ dir: dirParam(params.sort, flipDir(sortDir)), page: null })}
              >
                {sortDir === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <label className={cn(labelClass, "basis-24 md:w-24 md:flex-none")}>
              {t("minScore")}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MIN_SCORE_MAX}
                step={5}
                value={params.minScore ?? ""}
                placeholder="70"
                onChange={(e) => number("minScore", MIN_SCORE_MAX)(e.target.value)}
                data-testid="filter-min-score"
                className={inputClass}
              />
            </label>
            <label className={cn(labelClass, "basis-32 md:w-32 md:flex-none")}>
              {t("minSalary")}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MIN_SALARY_MAX}
                step={5000}
                value={params.minSalary ?? ""}
                placeholder="70000"
                title={t("minSalaryHint")}
                onChange={(e) => number("minSalary", MIN_SALARY_MAX)(e.target.value)}
                data-testid="filter-min-salary"
                className={inputClass}
              />
            </label>
            <label className={cn(labelClass, "flex-1 basis-36 md:max-w-44 md:flex-none")}>
              {t("from")}
              <input type="date" value={params.from ?? ""} max={params.to ?? undefined} onChange={(e) => set({ from: e.target.value === "" ? null : e.target.value })} data-testid="filter-from" className={`${inputClass} jb-filter-date`} />
            </label>
            <label className={cn(labelClass, "flex-1 basis-36 md:max-w-44 md:flex-none")}>
              {t("to")}
              <input type="date" value={params.to ?? ""} min={params.from ?? undefined} onChange={(e) => set({ to: e.target.value === "" ? null : e.target.value })} data-testid="filter-to" className={`${inputClass} jb-filter-date`} />
            </label>
          </div>

          <fieldset className="flex min-w-0 flex-col gap-1.5" data-testid="filter-app">
            <legend className="text-muted-foreground mb-1.5 text-xs">{t("appStatus")}</legend>
            <div className="flex flex-wrap gap-1.5">
              {filterOptions(APPLICATION_FILTER_STATUSES, hiddenStatuses, apps).map((status) => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={apps.includes(status)}
                  onClick={() => toggleApp(status)}
                  data-testid={`filter-app-${status}`}
                  className={cn(pillClass, "h-7 px-2.5", pillState(apps.includes(status)))}
                >
                  {appLabel(status)}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex min-h-ctl-sm flex-wrap items-center gap-x-2 gap-y-2">
            <button type="button" aria-pressed={params.salary === true} onClick={() => set({ salary: params.salary === true ? null : true })} data-testid="filter-salary" className={cn(pillClass, pillState(params.salary === true))}>
              {t("salaryDisclosed")}
            </button>
            {languageName !== null ? (
              <button type="button" aria-pressed={hideLangOn} onClick={() => set({ hideLang: hideLangOn ? null : true, hideGerman: null })} data-testid="filter-hide-german" className={cn(pillClass, pillState(hideLangOn))}>
                {t("hideGerman", { language: languageName })}
              </button>
            ) : null}
            {highValueNames.length > 0 ? (
              <button type="button" aria-pressed={highOn} title={ts("highTitle", { names: highValueNames.join(" / ") })} onClick={() => set({ high: highOn ? null : true, t12: null })} data-testid="filter-high" className={cn(pillClass, pillState(highOn))}>
                {ts("high")}
              </button>
            ) : null}
            {options.traps ? (
              // All / only with / hide jobs with an AI trap
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs" id={`${panelId}-trap`}>
                  {tTrap("label")}
                </span>
                <Segmented
                  aria-labelledby={`${panelId}-trap`}
                  value={params.trap ?? "all"}
                  onValueChange={(next) => set({ trap: TRAP_FILTERS.find((v) => v === next) ?? null })}
                  data-testid="filter-trap"
                >
                  <SegmentedItem value="all" data-testid="filter-trap-all">
                    {tTrap("all")}
                  </SegmentedItem>
                  {TRAP_FILTERS.map((value) => (
                    <SegmentedItem key={value} value={value} data-testid={`filter-trap-${value}`}>
                      {tTrap(value)}
                    </SegmentedItem>
                  ))}
                </Segmented>
              </span>
            ) : null}
            {options.visa ? (
              // All / support mentioned / not refused
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs" id={`${panelId}-visa`}>
                  {tVisa("label")}
                </span>
                <Segmented
                  aria-labelledby={`${panelId}-visa`}
                  value={params.visa ?? "all"}
                  onValueChange={(next) => set({ visa: VISA_FILTERS.find((v) => v === next) ?? null })}
                  data-testid="filter-visa"
                >
                  <SegmentedItem value="all" data-testid="filter-visa-all">
                    {tVisa("all")}
                  </SegmentedItem>
                  {VISA_FILTERS.map((value) => (
                    <SegmentedItem key={value} value={value} data-testid={`filter-visa-${value}`}>
                      {tVisa(value)}
                    </SegmentedItem>
                  ))}
                </Segmented>
              </span>
            ) : null}
            {options.ghost ? (
              // All / suspected only / hide the likely ones; "all" writes no parameter
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs" id={`${panelId}-ghost`}>
                  {tGhost("label")}
                </span>
                <Segmented
                  aria-labelledby={`${panelId}-ghost`}
                  value={params.ghost ?? "all"}
                  onValueChange={(next) => set({ ghost: GHOST_FILTERS.find((v) => v === next && v !== "all") ?? null })}
                  data-testid="filter-ghost"
                >
                  {GHOST_FILTERS.map((value) => (
                    <SegmentedItem key={value} value={value} data-testid={`filter-ghost-${value}`}>
                      {tGhost(value)}
                    </SegmentedItem>
                  ))}
                </Segmented>
              </span>
            ) : null}
            {hasActiveFilters(withLegacyKeys(params), visibility) ? (
              <Button type="button" variant="ghost" size="sm" data-testid="filter-clear" onClick={clear}>
                <X aria-hidden /> {t("clear")}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="border-border border-t px-4 py-3 md:hidden">
          <Button type="button" className="w-full" onClick={() => { setOpen(false); setExpandedKey(null); }} data-testid="filter-apply">
            {t("done")}
          </Button>
        </div>
      </div>
    </form>
  );
}
