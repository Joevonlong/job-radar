"use client";

import { useTranslations } from "next-intl";
import { useId, useState, } from "react";


import type { SalaryAxisScale } from "@/components/viz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { changedPaths } from "@/lib/draft-diff";
import type { SalaryMedian, StatedSalary } from "@/lib/profile/floor-preview";
import { homeCityAbroad, placesBeyondSearchEntries, searchEntriesOutsidePlaces, type OldSearchEntries } from "@/lib/market/places";
import type { MarketView } from "@/lib/market/view";
import {
  CONTRACT_MODES,
  CONTRACT_OPTIONS,
  SENIORITY_OPTIONS,
  WORKPLACE_OPTIONS,
  type PreferencesDraft,
} from "@/lib/profile/draft";
import type { ProfileActionState } from "@/lib/profile/types";

import { DealBreakersCard } from "./deal-breakers-card";
import { Field, TagInput, describedBy, fieldErrorMap } from "./fields";
import { FloorPreview } from "./floor-preview";
import { FormCard } from "./form-card";
import { HomeCityField } from "./home-city-field";
import { MarketFields } from "./market-fields";
import { usePlaceGeo } from "./place-picker";
import { PlacesField } from "./places-field";


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
  /** What search.yaml's old keys still name; ignored, and warned about. */
  oldSearch: OldSearchEntries;
  /** The user's level of the market's local language in me.yaml ("B1", "native"), null = none listed: what a language gate compares. */
  userLanguageLevel: string | null;
  /** me.yaml `needs_visa_sponsorship` as saved; null = me.yaml cannot be read (a visa deal-breaker then does nothing). */
  needsVisaSponsorship: boolean | null;
}

export function PreferencesForm({ initial, hash, state, pending, onSave, salaries, axis, salaryMedian, market, oldSearch, userLanguageLevel, needsVisaSponsorship }: PreferencesFormProps) {
  const t = useTranslations("profile");
  const base = useId();
  const [draft, setDraft] = useState<PreferencesDraft>(initial);
  const errors = fieldErrorMap(state, "preferences", hash);
  const dirtyCount = changedPaths(draft, initial).length;
  const sameMarket = draft.market.pack === market.packId && market.error === null;
  const { geo, remember } = usePlaceGeo(market.placeGeo, market.placeRecords);
  const leftovers = sameMarket ? searchEntriesOutsidePlaces(oldSearch, draft, geo, { country: market.country, countryName: market.countryName }) : [];
  const added = sameMarket ? placesBeyondSearchEntries(oldSearch, draft, geo, { country: market.country, countryName: market.countryName }) : [];
  const abroad = sameMarket ? homeCityAbroad(draft.home_city, geo, market.country, draft.home_city_id ?? null) : null;

  function patch(next: Partial<PreferencesDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  const ids = {
    titles: `${base}-titles`,
    homeCity: `${base}-home-city`,
    places: `${base}-places`,
    workplace: `${base}-workplace`,
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

      <Field id={ids.homeCity} label={t("fields.home_city.label")} hint={t("fields.home_city.hint")} error={errors.get("home_city")}>
        <HomeCityField
          id={ids.homeCity}
          value={{ home_city: draft.home_city, home_city_id: draft.home_city_id ?? null }}
          onChange={(next) => patch(next)}
          geo={geo}
          onPick={remember}
          known={sameMarket}
          testId="home-city"
          invalid={errors.has("home_city")}
          describedBy={describedBy(ids.homeCity, true, errors.get("home_city"))}
        />
      </Field>
      <Field id={ids.places} label={t("fields.places.label")} hint={t("fields.places.hint")} error={errors.get("places")}>
        <PlacesField
          id={ids.places}
          value={draft.places}
          onChange={(places) => patch({ places })}
          geo={geo}
          onPick={remember}
          options={market.scopeOptions}
          known={sameMarket}
          search={{ homeCity: draft.home_city, homeCityId: draft.home_city_id ?? null, workplace: draft.workplace, home: { country: market.country, countryName: market.countryName } }}
          invalid={errors.has("places")}
          describedBy={describedBy(ids.places, true, errors.get("places"))}
        />
      </Field>
      {abroad !== null ? (
        <p role="status" className="text-body-sm font-bold" data-testid="home-city-abroad">
          {t("fields.homeCityAbroad", { city: draft.home_city.trim(), country: abroad.name, home: market.countryName })}
        </p>
      ) : null}
      {leftovers.length > 0 ? (
        <p role="status" className="text-body-sm font-bold" data-testid="search-leftovers">
          {t("fields.searchLeftovers", { names: leftovers.join(", ") })}
        </p>
      ) : null}
      {added.length > 0 ? (
        <p role="status" className="text-body-sm font-bold" data-testid="search-added">
          {t("fields.searchAdded", { names: added.join(", ") })}
        </p>
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

      <div id="exclude-companies" className="scroll-mt-24">
        <Field id={ids.companies} label={t("fields.exclude_companies.label")} error={errors.get("exclude_companies")}>
          <TagInput
            id={ids.companies}
            values={draft.exclude_companies}
            onChange={(next) => patch({ exclude_companies: next })}
            invalid={errors.has("exclude_companies")}
            describedBy={describedBy(ids.companies, false, errors.get("exclude_companies"))}
          />
        </Field>
      </div>

      <Field id={ids.keywords} label={t("fields.exclude_keywords.label")} error={errors.get("exclude_keywords")}>
        <TagInput
          id={ids.keywords}
          values={draft.exclude_keywords}
          onChange={(next) => patch({ exclude_keywords: next })}
          invalid={errors.has("exclude_keywords")}
          describedBy={describedBy(ids.keywords, false, errors.get("exclude_keywords"))}
        />
      </Field>

      <DealBreakersCard
        baseId={`${base}-deal-breakers`}
        rules={draft.deal_breakers}
        onChange={(next) => patch({ deal_breakers: next })}
        errors={errors}
        userLevel={userLanguageLevel}
        languageName={market.languageName}
        languageStep={market.languageStep}
        needsVisaSponsorship={needsVisaSponsorship}
      />
    </FormCard>
  );
}
