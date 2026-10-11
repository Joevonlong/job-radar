"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useId, useState, useTransition } from "react";

import { syncSearchLocationsAction } from "@/app/me/actions";

import type { SalaryAxisScale } from "@/components/viz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { changedPaths } from "@/lib/draft-diff";
import type { SalaryMedian, StatedSalary } from "@/lib/profile/floor-preview";
import type { MarketView } from "@/lib/market/view";
import {
  CONTRACT_MODES,
  CONTRACT_OPTIONS,
  SENIORITY_OPTIONS,
  WORKPLACE_OPTIONS,
  type PreferencesDraft,
} from "@/lib/profile/draft";
import { sameLocations } from "@/lib/profile/same-locations";
import type { ProfileActionState } from "@/lib/profile/types";

import { Field, TagInput, describedBy, fieldErrorMap } from "./fields";
import { FloorPreview } from "./floor-preview";
import { FormCard } from "./form-card";
import { MarketFields, draftCountryName } from "./market-fields";
import { RemoteScopeField } from "./remote-scope-field";

interface PreferencesFormProps {
  initial: PreferencesDraft;
  hash: string;
  state: ProfileActionState;
  pending: boolean;
  onSave: (draft: PreferencesDraft) => void;
  /** This month's stated salaries and the axis scale (ui.yaml): the floor preview's material. */
  salaries: readonly StatedSalary[];
  axis: SalaryAxisScale;
  salaryMedian: SalaryMedian;
  /** The market (scope choices, currency, language). */
  market: MarketView;
  /** search.yaml `locations`: the cities that are searched; they do not follow `locations` of this form. */
  searchLocations: readonly string[];
}

export function PreferencesForm({ initial, hash, state, pending, onSave, salaries, axis, salaryMedian, market, searchLocations }: PreferencesFormProps) {
  const t = useTranslations("profile");
  const base = useId();
  const [draft, setDraft] = useState<PreferencesDraft>(initial);
  const errors = fieldErrorMap(state, "preferences", hash);
  const dirtyCount = changedPaths(draft, initial).length;
  const [searchCities, setSearchCities] = useState<readonly string[]>(searchLocations);
  const [syncing, startSync] = useTransition();
  const [syncResult, setSyncResult] = useState<"done" | "error" | null>(null);
  const searchDiffers = draft.locations.length > 0 && !sameLocations(draft.locations, searchCities);

  function patch(next: Partial<PreferencesDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  const ids = {
    titles: `${base}-titles`,
    locations: `${base}-locations`,
    workplace: `${base}-workplace`,
    remote: `${base}-remote`,
    seniority: `${base}-seniority`,
    salary: `${base}-salary`,
    contracts: `${base}-contracts`,
    companies: `${base}-companies`,
    keywords: `${base}-keywords`,
  };

  return (
    <FormCard
      kind="preferences"
      title={t("sections.preferences.title")}
      description={t("sections.preferences.description")}
      hash={hash}
      state={state}
      pending={pending}
      dirtyCount={dirtyCount}
      onSubmit={() => onSave(draft)}
      onReset={() => setDraft(initial)}
    >
      <MarketFields baseId={`${base}-market`} value={draft.market} saved={initial.market} onChange={(next) => patch({ market: next })} market={market} errors={errors} />

      <Field id={ids.titles} label={t("fields.target_titles.label")} hint={t("fields.target_titles.hint")} error={errors.get("target_titles")}>
        <TagInput
          id={ids.titles}
          values={draft.target_titles}
          onChange={(next) => patch({ target_titles: next })}
          invalid={errors.has("target_titles")}
          describedBy={describedBy(ids.titles, true, errors.get("target_titles"))}
        />
      </Field>

      <Field id={ids.locations} label={t("fields.locations.label")} error={errors.get("locations")}>
        <TagInput
          id={ids.locations}
          values={draft.locations}
          onChange={(next) => patch({ locations: next })}
          invalid={errors.has("locations")}
          describedBy={describedBy(ids.locations, false, errors.get("locations"))}
        />
      </Field>
      {searchDiffers || syncResult !== null ? (
        <div className="flex flex-col gap-2 text-body-sm" data-testid="search-cities-note">
          {searchDiffers ? (
            <>
              <p className="text-ink-2">{t("fields.searchCities.differs", { cities: searchCities.join(", ") })}</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  size="sm"
                  disabled={syncing}
                  data-testid="search-cities-sync"
                  onClick={() =>
                    startSync(async () => {
                      const result = await syncSearchLocationsAction(draft.locations);
                      if (result.status === "done") setSearchCities(result.locations);
                      setSyncResult(result.status === "done" ? "done" : "error");
                    })
                  }
                >
                  {t("fields.searchCities.sync")}
                </Button>
                <Link href="/settings?tab=search" className="font-bold underline decoration-2 underline-offset-4 hover:bg-hi">
                  {t("fields.searchCities.link")}
                </Link>
              </div>
            </>
          ) : null}
          {syncResult !== null ? (
            <p role="status" className={syncResult === "done" ? undefined : "text-bad font-bold"}>
              {syncResult === "done" ? t("fields.searchCities.done") : t("fields.searchCities.failed")}
            </p>
          ) : null}
        </div>
      ) : null}

      <Field id={ids.workplace} group label={t("fields.workplace.label")} error={errors.get("workplace")}>
        <div className="flex flex-wrap gap-2" data-testid="workplace-options">
          {WORKPLACE_OPTIONS.map((option) => {
            const on = draft.workplace.includes(option);
            return (
              <Button
                key={option}
                type="button"
                size="sm"
                aria-pressed={on}
                aria-invalid={errors.has("workplace") || undefined}
                onClick={() => patch({ workplace: on ? draft.workplace.filter((w) => w !== option) : [...draft.workplace, option] })}
              >
                {t(`options.workplace.${option}`)}
              </Button>
            );
          })}
        </div>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={ids.remote} label={t("fields.remote_scope.label")} error={errors.get("remote_scope")}>
          <RemoteScopeField
            id={ids.remote}
            value={draft.remote_scope}
            onChange={(next) => patch({ remote_scope: next })}
            options={market.scopeOptions}
            countryName={draftCountryName(market, draft.market)}
            invalid={errors.has("remote_scope")}
            describedBy={describedBy(ids.remote, false, errors.get("remote_scope"))}
            namespace="profile"
          />
        </Field>
        <Field id={ids.seniority} label={t("fields.seniority.label")} error={errors.get("seniority")}>
          <Select
            id={ids.seniority}
            value={draft.seniority}
            aria-invalid={errors.has("seniority") || undefined}
            aria-describedby={describedBy(ids.seniority, false, errors.get("seniority"))}
            onChange={(event) => patch({ seniority: event.target.value })}
          >
            {SENIORITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {t(`options.seniority.${option}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        id={ids.salary}
        label={t("fields.salary_floor_year.label", { currency: market.currency })}
        hint={t("fields.salary_floor_year.hint")}
        error={errors.get("salary_floor_year")}
      >
        <Input
          id={ids.salary}
          inputMode="numeric"
          className="max-w-56 font-mono tabular-nums"
          prefix={market.currencySymbol}
          suffix={t("units.perYear")}
          autoComplete="off"
          value={draft.salary_floor_year}
          aria-invalid={errors.has("salary_floor_year") || undefined}
          aria-describedby={describedBy(ids.salary, true, errors.get("salary_floor_year"))}
          onChange={(event) => patch({ salary_floor_year: event.target.value })}
        />
      </Field>
      <FloorPreview salaries={salaries} axis={axis} median={salaryMedian} floorText={draft.salary_floor_year} onFloorChange={(text) => patch({ salary_floor_year: text })} inputId={ids.salary} />

      <Field id={ids.contracts} group label={t("fields.contracts.label")} hint={t("fields.contracts.hint")} error={errors.get("contracts")}>
        <div className="grid gap-2 sm:grid-cols-2">
          {CONTRACT_OPTIONS.map((kind) => (
            <div key={kind} className="flex items-center justify-between gap-3">
              <label htmlFor={`${ids.contracts}-${kind}`} className="text-sm">
                {t(`options.contract.${kind}`)}
              </label>
              <div className="w-32 shrink-0">
                <Select
                  id={`${ids.contracts}-${kind}`}
                  value={draft.contracts[kind] ?? "none"}
                  onChange={(event) => patch({ contracts: { ...draft.contracts, [kind]: event.target.value } })}
                >
                  {CONTRACT_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`options.contractMode.${mode}`)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ))}
        </div>
      </Field>

      <div className="flex items-center gap-3">
        <Switch id={`${base}-student`} checked={draft.exclude_student_roles} onCheckedChange={(checked) => patch({ exclude_student_roles: checked })} />
        <label htmlFor={`${base}-student`} className="text-label cursor-pointer font-bold">
          {t("fields.exclude_student_roles.label")}
        </label>
      </div>

      <Field id={ids.companies} label={t("fields.exclude_companies.label")} error={errors.get("exclude_companies")}>
        <TagInput
          id={ids.companies}
          values={draft.exclude_companies}
          onChange={(next) => patch({ exclude_companies: next })}
          invalid={errors.has("exclude_companies")}
          describedBy={describedBy(ids.companies, false, errors.get("exclude_companies"))}
        />
      </Field>

      <Field id={ids.keywords} label={t("fields.exclude_keywords.label")} error={errors.get("exclude_keywords")}>
        <TagInput
          id={ids.keywords}
          values={draft.exclude_keywords}
          onChange={(next) => patch({ exclude_keywords: next })}
          invalid={errors.has("exclude_keywords")}
          describedBy={describedBy(ids.keywords, false, errors.get("exclude_keywords"))}
        />
      </Field>
    </FormCard>
  );
}
