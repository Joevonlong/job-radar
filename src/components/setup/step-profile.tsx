"use client";

import { Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { ErrorText, Field, describedBy } from "@/components/profile/fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CEFR_LEVELS, LevelScale, SegBlocks, type CefrLevel } from "@/components/viz";
import { LANGUAGE_LEVEL_OPTIONS, type MeDraft } from "@/lib/profile/draft";
import type { SetupView } from "@/lib/setup/view";

import { StepFrame } from "./step-frame";
import { useStep } from "./use-step";

const NEW_SKILL = { name: "", years: "" } as const;
/** The local language row added before the first save starts at the lowest level: the user raises it (a too-high level would hide requirements). */
const LOCAL_LANGUAGE_LEVEL = "A1";
const SKILL_CELLS = 10;

function cefrOf(level: string): CefrLevel | null {
  if (level === "native") return "C2";
  return CEFR_LEVELS.find((candidate) => candidate === level) ?? null;
}

function yearsShare(text: string): number | null {
  const years = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(years) && years >= 0 ? Math.min(years, SKILL_CELLS) * (100 / SKILL_CELLS) : null;
}

function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The draft the step starts from: me.yaml, plus a row for the market's local language before the step was saved once. */
function startDraft(view: SetupView["profile"], done: boolean): { draft: MeDraft; added: string | null } | null {
  if (view.draft === null) return null;
  const local = view.localLanguage;
  if (done || local === null || view.draft.languages.some((row) => row.code.trim().toLowerCase() === local)) return { draft: view.draft, added: null };
  return { draft: { ...view.draft, languages: [...view.draft.languages, { code: local, level: LOCAL_LANGUAGE_LEVEL }] }, added: local };
}

/** Step 3: about me (me.yaml): summary for the AI, skills, languages with levels, experience, visa, city. */
export function StepProfile({ view, done }: { view: SetupView["profile"]; done: boolean }) {
  const t = useTranslations("setup.profile");
  const tp = useTranslations("profile");
  const locale = useLocale();
  const { pending, save, skip, errors, formError } = useStep("profile");
  const [start] = useState(() => startDraft(view, done));
  const [draft, setDraft] = useState<MeDraft | null>(start?.draft ?? null);

  if (draft === null) {
    return (
      <StepFrame step="profile" pending={pending} formError={formError} onSkip={skip} onSubmit={() => undefined} disabled>
        <p role="alert" className="text-body-sm font-bold text-bad">
          {t("unreadable")}
        </p>
      </StepFrame>
    );
  }
  const patch = (next: Partial<MeDraft>): void => setDraft({ ...draft, ...next });
  const ids = { summary: "setup-profile-summary", years: "setup-profile-years", city: "setup-profile-city", visa: "setup-profile-visa" };

  return (
    <StepFrame step="profile" pending={pending} formError={formError} onSkip={skip} onSubmit={() => save(draft)}>
      <p className="flex items-start gap-sp-2 rounded-card border-bw border-dashed border-border bg-soft px-sp-3 py-sp-2 text-body-sm" data-testid="setup-profile-privacy">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t("privacy")}
      </p>

      <Field id={ids.summary} label={tp("fields.summary.label")} hint={tp("fields.summary.hint")} error={errors.profile("summary")}>
        <Textarea
          id={ids.summary}
          rows={4}
          value={draft.summary}
          aria-invalid={errors.has("summary") || undefined}
          aria-describedby={describedBy(ids.summary, true, errors.profile("summary"))}
          onChange={(event) => patch({ summary: event.target.value })}
        />
      </Field>

      <Field id="setup-profile-skills" group label={tp("fields.skills.label")}>
        <div className="flex flex-col gap-sp-2">
          {draft.skills.length === 0 ? <p className="text-body-sm text-ink-2">{tp("fields.skills.empty")}</p> : null}
          {draft.skills.map((row, index) => {
            const nameError = errors.profile(`skills.${index}.name`);
            const yearsError = errors.profile(`skills.${index}.years`);
            const rowId = `setup-skill-${index}`;
            return (
              <div key={index} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-sp-2">
                  <Input
                    className="min-w-0 flex-1 basis-40"
                    aria-label={tp("fields.skills.name")}
                    placeholder={tp("fields.skills.name")}
                    aria-invalid={nameError ? true : undefined}
                    aria-describedby={nameError ? `${rowId}-name-msg` : undefined}
                    autoComplete="off"
                    value={row.name}
                    onChange={(event) => patch({ skills: draft.skills.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)) })}
                  />
                  <SegBlocks value={yearsShare(row.years)} cells={SKILL_CELLS} label={false} ariaLabel={tp("skillScale.aria", { name: row.name || tp("fields.skills.name"), years: row.years || "—" })} className="shrink-0" />
                  <Input
                    className="w-24 shrink-0 font-mono tabular-nums"
                    suffix={tp("units.years")}
                    inputMode="decimal"
                    aria-label={tp("fields.skills.years")}
                    aria-invalid={yearsError ? true : undefined}
                    aria-describedby={yearsError ? `${rowId}-years-msg` : undefined}
                    autoComplete="off"
                    value={row.years}
                    onChange={(event) => patch({ skills: draft.skills.map((r, i) => (i === index ? { ...r, years: event.target.value } : r)) })}
                  />
                  <Button type="button" variant="ghost" size="icon" aria-label={tp("actions.removeRow")} onClick={() => patch({ skills: draft.skills.filter((_, i) => i !== index) })}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <ErrorText id={`${rowId}-name-msg`} error={nameError} />
                <ErrorText id={`${rowId}-years-msg`} error={yearsError} />
              </div>
            );
          })}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => patch({ skills: [...draft.skills, { ...NEW_SKILL }] })} data-testid="setup-add-skill">
            <Plus aria-hidden />
            {tp("fields.skills.add")}
          </Button>
        </div>
      </Field>

      <Field id="setup-profile-languages" group label={tp("fields.languages.label")} hint={tp("fields.languages.hint")}>
        <div className="flex flex-col gap-sp-2">
          {start?.added ? <p className="text-body-sm text-ink-2">{t("localLanguageAdded", { language: languageName(start.added, locale) })}</p> : null}
          {draft.languages.map((row, index) => {
            const error = errors.profile(`languages.${index}`);
            const rowId = `setup-lang-${index}`;
            return (
              <div key={index} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-sp-2">
                  <Input
                    className="w-20 shrink-0 font-mono"
                    aria-label={tp("fields.languages.code")}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${rowId}-msg` : undefined}
                    maxLength={3}
                    autoComplete="off"
                    value={row.code}
                    onChange={(event) => patch({ languages: draft.languages.map((r, i) => (i === index ? { ...r, code: event.target.value } : r)) })}
                  />
                  <div className="w-44 shrink-0">
                    <Select
                      aria-label={tp("fields.languages.level")}
                      aria-invalid={error ? true : undefined}
                      value={row.level}
                      onChange={(event) => patch({ languages: draft.languages.map((r, i) => (i === index ? { ...r, level: event.target.value } : r)) })}
                    >
                      {LANGUAGE_LEVEL_OPTIONS.map((level) => (
                        <option key={level} value={level}>
                          {tp(`options.level.${level}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <LevelScale mine={cefrOf(row.level)} className="shrink-0" />
                  <Button type="button" variant="ghost" size="icon" aria-label={tp("actions.removeRow")} onClick={() => patch({ languages: draft.languages.filter((_, i) => i !== index) })}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <ErrorText id={`${rowId}-msg`} error={error} />
              </div>
            );
          })}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => patch({ languages: [...draft.languages, { code: "", level: "B1" }] })}>
            <Plus aria-hidden />
            {tp("fields.languages.add")}
          </Button>
        </div>
      </Field>

      <div className="grid gap-sp-4 sm:grid-cols-2">
        <Field id={ids.years} label={tp("fields.years_experience.label")} hint={tp("fields.years_experience.hint")} error={errors.profile("years_experience")}>
          <Input
            id={ids.years}
            inputMode="decimal"
            className="font-mono tabular-nums"
            suffix={tp("units.years")}
            autoComplete="off"
            value={draft.years_experience}
            aria-invalid={errors.has("years_experience") || undefined}
            aria-describedby={describedBy(ids.years, true, errors.profile("years_experience"))}
            onChange={(event) => patch({ years_experience: event.target.value })}
          />
        </Field>
        <Field id={ids.city} label={tp("fields.city.label")} error={errors.profile("city")}>
          <Input
            id={ids.city}
            autoComplete="off"
            value={draft.city}
            aria-invalid={errors.has("city") || undefined}
            aria-describedby={describedBy(ids.city, false, errors.profile("city"))}
            onChange={(event) => patch({ city: event.target.value })}
          />
        </Field>
      </div>

      <div className="flex items-center gap-sp-3">
        <Switch id={ids.visa} checked={draft.needs_visa_sponsorship} onCheckedChange={(checked) => patch({ needs_visa_sponsorship: checked })} />
        <label htmlFor={ids.visa} className="cursor-pointer text-label font-bold">
          {tp("fields.needs_visa_sponsorship.label")}
        </label>
      </div>
    </StepFrame>
  );
}
