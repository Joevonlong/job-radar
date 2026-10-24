"use client";

import { ExternalLink, Pencil, Pin, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import { toastTone } from "@/lib/toast";

import { deleteViewAction, renameViewAction, setDefaultViewAction } from "@/app/interests/actions";
import { useBaseCurrency, useLocalLanguageName } from "@/components/base-currency";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/viz";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SavedView } from "@/lib/config/schemas/interests";
import type { InterestsActionState, InterestsFormError } from "@/lib/interests/types";
import { knownContract, knownFamily } from "@/lib/dashboard/labels";
import { activeFilterKeys, filterValues, viewFiltersToParams, type ViewFilterKey } from "@/lib/interests/view-filters";
import { APPLICATION_FILTER_STATUSES, JOB_STATUSES, JOB_WORKPLACES } from "@/lib/jobs/constants";
import { MULTI_FILTER_KEYS, type MultiFilterKey } from "@/lib/jobs/filter-keys";
import { currencyPrefix } from "@/lib/format/numbers";
import { jobsListHref } from "@/lib/jobs/search-params";

const MAX_NAME_CHARS = 60;

const isMultiKey = (key: ViewFilterKey): key is MultiFilterKey => (MULTI_FILTER_KEYS as readonly string[]).includes(key);

function FilterChips({ view }: { view: SavedView }) {
  const t = useTranslations("interests.filters");
  const tc = useTranslations("dashboard");
  const tj = useTranslations("dashboard.jobs.filters");
  const tTrap = useTranslations("aiTraps.filter");
  const tVisa = useTranslations("visa.filter");
  const tGhost = useTranslations("ghostJobs.filter");
  const currency = useBaseCurrency();
  const languageName = useLocalLanguageName();
  // The local-language filter names the market's language
  const keyLabel = (key: ViewFilterKey): string => (key === "hideLang" ? t("keys.hideLang", { language: languageName ?? t("localLanguage") }) : t(`keys.${key}`));
  const format = useFormatter();
  const keys = activeFilterKeys(view.filters);
  if (keys.length === 0) return <span className="text-ink-3 text-body-sm">{t("none")}</span>;
  /** One picked value as the /jobs filter bar names it. */
  const valueLabel = (key: MultiFilterKey, raw: string): string => {
    switch (key) {
      case "source": {
        const family = knownFamily(raw);
        return family ? tc(`source.${family}`) : raw;
      }
      case "contract": {
        const contract = knownContract(raw);
        return contract ? tc(`contract.${contract}`) : raw;
      }
      case "workplace": {
        const workplace = JOB_WORKPLACES.find((w) => w === raw);
        return workplace ? tc(`workplace.${workplace}`) : raw;
      }
      case "status": {
        const status = JOB_STATUSES.find((s) => s === raw);
        return status ? tc(`jobStatus.${status}`) : raw;
      }
      case "app": {
        if (raw === "new") return tj("appNew");
        const app = APPLICATION_FILTER_STATUSES.find((s) => s === raw);
        return app ? tc(`status.${app}`) : raw;
      }
      case "city":
      case "company":
        return raw;
    }
  };
  const value = (key: ViewFilterKey): string | null => {
    const raw = view.filters[key];
    if (typeof raw === "boolean" || raw === undefined) return null;
    if (typeof raw === "number") return key === "minSalary" ? `≥ ${currencyPrefix(currency)}${raw / 1000}k` : `≥ ${raw}`;
    if (key === "trap") return raw === "only" || raw === "hide" ? tTrap(raw) : String(raw);
    if (key === "visa") return raw === "offered" || raw === "not_denied" ? tVisa(raw) : String(raw);
    if (key === "ghost") return raw === "only" || raw === "hide" ? tGhost(raw) : String(raw);
    if (isMultiKey(key)) return format.list(filterValues(view.filters, key).map((v) => valueLabel(key, v)), { type: "disjunction" });
    return raw as string;
  };
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t("label")}>
      {keys.map((key) => {
        const text = value(key);
        return (
          <li key={key}>
            <Badge variant="secondary" className="font-mono">
              {text === null ? keyLabel(key) : t("pair", { key: keyLabel(key), value: text })}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function ViewRow({ view, trend, busy, run }: { view: SavedView; /** New jobs per day, oldest first; undefined = could not be counted. */ trend: number[] | undefined; busy: boolean; run: (task: () => Promise<InterestsActionState>, successToast?: string) => void }) {
  const t = useTranslations("interests.views");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(view.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(() => renameViewAction({ id: view.id, name }), t("renamedToast"));
    setEditing(false);
  }

  return (
    <li className="border-grid flex flex-col gap-2 rounded-card border-bw bg-card p-3" data-testid="view-row" data-view-id={view.id} data-default={view.default}>
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <form className="flex flex-1 items-center gap-2" onSubmit={submitRename} noValidate>
            <Input value={name} maxLength={MAX_NAME_CHARS} aria-label={t("renameLabel")} autoFocus onChange={(event) => setName(event.target.value)} className="max-w-xs" />
            <Button type="submit" size="sm" disabled={busy || name.trim() === ""}>
              {t("renameSave")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setName(view.name);
              }}
            >
              {t("cancel")}
            </Button>
          </form>
        ) : (
          <>
            <h3 className="text-title" data-testid="view-name">
              {view.name}
            </h3>
            {view.default ? (
              <Badge variant="outline" className="bg-hi text-hi-ink border-border gap-1">
                <Pin aria-hidden className="size-3 fill-current" /> {t("defaultBadge")}
              </Badge>
            ) : null}
            {trend && trend.length > 0 ? (
              <span className="ml-auto flex items-center gap-2" data-testid="view-trend" title={t("trendTip", { days: trend.length })}>
                <Sparkline values={trend} width={86} height={24} />
                <span className="font-mono text-data text-ink-2 text-right" data-testid="view-trend-label">
                  <b className="text-ink" data-testid="view-trend-today" aria-label={t("trendToday", { count: trend[trend.length - 1] ?? 0 })}>
                    {t("trendTodayShort", { count: trend[trend.length - 1] ?? 0 })}
                  </b>
                  {" · "}
                  <span data-testid="view-trend-total">{t("trendTotal", { days: trend.length, count: trend.reduce((sum, n) => sum + n, 0) })}</span>
                </span>
              </span>
            ) : null}
            <div className={trend && trend.length > 0 ? "flex flex-wrap items-center gap-1" : "ml-auto flex flex-wrap items-center gap-1"}>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(true)} aria-label={t("rename", { name: view.name })}>
                <Pencil aria-hidden /> {t("renameShort")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-pressed={view.default}
                data-testid="view-default"
                onClick={() => run(() => setDefaultViewAction({ id: view.id, value: !view.default }), view.default ? t("defaultOffToast", { name: view.name }) : t("defaultOnToast", { name: view.name }))}
              >
                <Pin aria-hidden className={view.default ? "fill-current" : undefined} /> {view.default ? t("unsetDefault") : t("setDefault")}
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={jobsListHref(viewFiltersToParams(view.filters))} aria-label={t("openInJobs", { name: view.name })}>
                  <ExternalLink aria-hidden /> {t("open")}
                </Link>
              </Button>
              {confirmDelete ? (
                <>
                  <Button type="button" variant="destructive" size="sm" disabled={busy} data-testid="view-delete-confirm" onClick={() => run(() => deleteViewAction({ id: view.id }), t("deletedToast", { name: view.name }))}>
                    {t("confirmDelete")}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    {t("cancel")}
                  </Button>
                </>
              ) : (
                <Button type="button" variant="ghost" size="sm" disabled={busy} data-testid="view-delete" onClick={() => setConfirmDelete(true)} aria-label={t("delete", { name: view.name })}>
                  <Trash2 aria-hidden /> {t("deleteShort")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      <FilterChips view={view} />
    </li>
  );
}

/** Saved views: rename, default for the Today page, delete, open in /jobs. New ones are made on /jobs ("save current filters"). */
export function ViewsPanel({ views, trends }: { views: SavedView[]; trends: Record<string, number[]> }) {
  const t = useTranslations("interests.views");
  const tErrors = useTranslations("interests.formErrors");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<InterestsFormError | null>(null);

  function run(task: () => Promise<InterestsActionState>, successToast?: string) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (result.status === "saved") {
        if (successToast) toastTone("success", successToast);
      } else if (result.status === "error") {
        setError(result.formError ?? "invalidPayload");
      }
    });
  }

  return (
    <Card className="gap-4 py-4" data-testid="views-card" id="views">
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 md:px-5">
        {views.length === 0 ? (
          <p className="text-ink-2 text-body" data-testid="views-empty">
            {t("empty")} <Link href="/jobs" className="font-bold underline decoration-2 underline-offset-4 hover:bg-hi">{t("emptyLink")}</Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={t("title")}>
            {views.map((view) => (
              <ViewRow key={`${view.id}-${view.name}-${view.default}`} view={view} trend={trends[view.id]} busy={pending} run={run} />
            ))}
          </ul>
        )}
        {error ? (
          <p role="alert" className="text-bad text-body-sm font-bold">
            {tErrors(error)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
