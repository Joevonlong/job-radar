"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Field, TagInput, describedBy } from "@/components/profile/fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { MarketView } from "@/lib/market/view";
import { CONTRACT_MODES, CONTRACT_OPTIONS, SENIORITY_OPTIONS, WORKPLACE_OPTIONS } from "@/lib/profile/draft";
import type { TargetsInput } from "@/lib/setup/inputs";
import { planKeywordGroups, TARGETS_GROUP } from "@/lib/setup/keywords";
import type { SetupView } from "@/lib/setup/view";

import { StepFrame } from "./step-frame";
import { useStep } from "./use-step";

/** The keyword groups search.yaml gets on save: shown before saving (the same function runs on the server). */
function KeywordPreview({ view, titles }: { view: SetupView["targets"]; titles: readonly string[] }) {
  const t = useTranslations("setup.targets");
  if (view.keywordGroups === null) return null;
  const plan = planKeywordGroups(view.keywordGroups, view.shippedKeywordGroups, titles);
  const kept = Object.keys(plan.groups).filter((id) => id !== TARGETS_GROUP);
  return (
    <section className="flex flex-col gap-sp-2 rounded-card border-bw border-dashed border-border p-sp-3" aria-labelledby="setup-keywords-title" data-testid="setup-keyword-preview" data-mode={plan.mode}>
      <h3 id="setup-keywords-title" className="text-label font-bold">
        {t("keywordsTitle")}
      </h3>
      <p className="text-body-sm text-ink-2" aria-live="polite">
        {plan.mode === "replace" ? t("keywordsReplace") : plan.mode === "merge" ? t("keywordsMerge") : t("keywordsNone")}
      </p>
      {plan.mode !== "none" ? (
        <p className="font-mono text-data break-words">
          <span className="font-semibold">{TARGETS_GROUP}:</span> {(plan.groups[TARGETS_GROUP] ?? []).join(" · ")}
        </p>
      ) : null}
      {plan.mode === "merge" && kept.length > 0 ? <p className="font-mono text-data-sm text-ink-2">{t("keywordsKept", { groups: kept.join(", ") })}</p> : null}
    </section>
  );
}

/** Step 4: titles, level, work modes, salary floor, contracts, exclusions (preferences.yaml) and the search keywords (search.yaml). */
export function StepTargets({ view, market }: { view: SetupView["targets"]; market: MarketView }) {
  const t = useTranslations("setup.targets");
  const tp = useTranslations("profile");
  const { pending, save, skip, errors, formError } = useStep("targets");
  const [draft, setDraft] = useState<TargetsInput | null>(view.draft);

  if (draft === null) {
    return (
      <StepFrame step="targets" pending={pending} formError={formError} onSkip={skip} onSubmit={() => undefined} disabled>
        <p role="alert" className="text-body-sm font-bold text-bad">
          {t("unreadable")}
        </p>
      </StepFrame>
    );
  }
  const patch = (next: Partial<TargetsInput>): void => setDraft({ ...draft, ...next });
  const ids = { titles: "setup-targets-titles", seniority: "setup-targets-seniority", salary: "setup-targets-salary", contracts: "setup-targets-contracts", companies: "setup-targets-companies", keywords: "setup-targets-keywords", student: "setup-targets-student" };
  const titlesError = errors.profile("target_titles");

  return (
    <StepFrame step="targets" pending={pending} formError={formError} onSkip={skip} onSubmit={() => save(draft)}>
      <Field id={ids.titles} label={tp("fields.target_titles.label")} hint={tp("fields.target_titles.hint")} error={titlesError} errorText={errors.text("target_titles")}>
        <TagInput id={ids.titles} values={draft.target_titles} onChange={(next) => patch({ target_titles: next })} invalid={errors.has("target_titles")} describedBy={describedBy(ids.titles, true, titlesError ?? errors.text("target_titles"))} />
      </Field>
      <KeywordPreview view={view} titles={draft.target_titles} />

      <div className="grid gap-sp-4 sm:grid-cols-2">
        <Field id={ids.seniority} label={tp("fields.seniority.label")} error={errors.profile("seniority")}>
          <Select id={ids.seniority} value={draft.seniority} aria-invalid={errors.has("seniority") || undefined} aria-describedby={describedBy(ids.seniority, false, errors.profile("seniority"))} onChange={(event) => patch({ seniority: event.target.value })}>
            {SENIORITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {tp(`options.seniority.${option}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={ids.salary} label={tp("fields.salary_floor_year.label", { currency: market.currency })} hint={tp("fields.salary_floor_year.hint")} error={errors.profile("salary_floor_year")}>
          <Input
            id={ids.salary}
            inputMode="numeric"
            className="max-w-56 font-mono tabular-nums"
            prefix={market.currencySymbol}
            suffix={tp("units.perYear")}
            autoComplete="off"
            value={draft.salary_floor_year}
            aria-invalid={errors.has("salary_floor_year") || undefined}
            aria-describedby={describedBy(ids.salary, true, errors.profile("salary_floor_year"))}
            onChange={(event) => patch({ salary_floor_year: event.target.value })}
          />
        </Field>
      </div>

      <Field id="setup-targets-workplace" group label={tp("fields.workplace.label")} error={errors.profile("workplace")}>
        <div className="flex flex-wrap gap-sp-2">
          {WORKPLACE_OPTIONS.map((option) => {
            const on = draft.workplace.includes(option);
            return (
              <Button key={option} type="button" size="sm" aria-pressed={on} aria-invalid={errors.has("workplace") || undefined} onClick={() => patch({ workplace: on ? draft.workplace.filter((w) => w !== option) : [...draft.workplace, option] })}>
                {tp(`options.workplace.${option}`)}
              </Button>
            );
          })}
        </div>
      </Field>

      <Field id={ids.contracts} group label={tp("fields.contracts.label")} hint={tp("fields.contracts.hint")} error={errors.profile("contracts")}>
        <div className="grid gap-sp-2 sm:grid-cols-2">
          {CONTRACT_OPTIONS.map((kind) => (
            <div key={kind} className="flex items-center justify-between gap-sp-3">
              <label htmlFor={`${ids.contracts}-${kind}`} className="text-body-sm">
                {tp(`options.contract.${kind}`)}
              </label>
              <div className="w-32 shrink-0">
                <Select id={`${ids.contracts}-${kind}`} value={draft.contracts[kind] ?? "none"} onChange={(event) => patch({ contracts: { ...draft.contracts, [kind]: event.target.value } })}>
                  {CONTRACT_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {tp(`options.contractMode.${mode}`)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ))}
        </div>
      </Field>

      <div className="flex items-center gap-sp-3">
        <Switch id={ids.student} checked={draft.exclude_student_roles} onCheckedChange={(checked) => patch({ exclude_student_roles: checked })} />
        <label htmlFor={ids.student} className="cursor-pointer text-label font-bold">
          {tp("fields.exclude_student_roles.label")}
        </label>
      </div>

      <div className="grid gap-sp-4 sm:grid-cols-2">
        <Field id={ids.companies} label={tp("fields.exclude_companies.label")} error={errors.profile("exclude_companies")}>
          <TagInput id={ids.companies} values={draft.exclude_companies} onChange={(next) => patch({ exclude_companies: next })} invalid={errors.has("exclude_companies")} describedBy={describedBy(ids.companies, false, errors.profile("exclude_companies"))} />
        </Field>
        <Field id={ids.keywords} label={tp("fields.exclude_keywords.label")} error={errors.profile("exclude_keywords")}>
          <TagInput id={ids.keywords} values={draft.exclude_keywords} onChange={(next) => patch({ exclude_keywords: next })} invalid={errors.has("exclude_keywords")} describedBy={describedBy(ids.keywords, false, errors.profile("exclude_keywords"))} />
        </Field>
      </div>
    </StepFrame>
  );
}
