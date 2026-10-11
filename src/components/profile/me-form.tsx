"use client";

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { LevelScale, SegBlocks, CEFR_LEVELS, type CefrLevel } from "@/components/viz";
import { changedPaths } from "@/lib/draft-diff";
import { LANGUAGE_LEVEL_OPTIONS, type MeDraft } from "@/lib/profile/draft";
import type { ProfileActionState } from "@/lib/profile/types";

import { ErrorText, Field, describedBy, fieldErrorMap } from "./fields";
import { FormCard } from "./form-card";

interface MeFormProps {
  initial: MeDraft;
  hash: string;
  state: ProfileActionState;
  pending: boolean;
  onSave: (draft: MeDraft) => void;
}

/** New language rows start with a sensible level so the row is valid once a code is typed. */
const NEW_LANGUAGE = { code: "", level: "B1" } as const;
const NEW_SKILL = { name: "", years: "" } as const;

/** Cells of the skill-years bar: one per year, ten at most. */
const SKILL_CELLS = 10;

/** The CEFR step a language level stands for on the scale; `native` is the top step. */
function cefrOf(level: string): CefrLevel | null {
  if (level === "native") return "C2";
  return CEFR_LEVELS.find((candidate) => candidate === level) ?? null;
}

/** Skill years as the share the 10-cell bar shows (one cell per year); text that is not a number draws nothing. */
function yearsShare(text: string): number | null {
  const years = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(years) && years >= 0 ? Math.min(years, SKILL_CELLS) * (100 / SKILL_CELLS) : null;
}

export function MeForm({ initial, hash, state, pending, onSave }: MeFormProps) {
  const t = useTranslations("profile");
  const base = useId();
  const [draft, setDraft] = useState<MeDraft>(initial);
  const errors = fieldErrorMap(state, "me", hash);
  const dirtyCount = changedPaths(draft, initial).length;

  function patch(next: Partial<MeDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  const yearsId = `${base}-years`;
  const cityId = `${base}-city`;
  const summaryId = `${base}-summary`;

  return (
    <FormCard
      kind="me"
      title={t("sections.me.title")}
      description={t("sections.me.description")}
      hash={hash}
      state={state}
      pending={pending}
      dirtyCount={dirtyCount}
      onSubmit={() => onSave(draft)}
      onReset={() => setDraft(initial)}
    >
      <Field id={`${base}-languages`} group label={t("fields.languages.label")} hint={t("fields.languages.hint")}>
        <div className="flex flex-col gap-2">
          {draft.languages.length === 0 ? <p className="text-ink-2 text-body-sm">{t("fields.languages.empty")}</p> : null}
          {draft.languages.map((row, index) => {
            const error = errors.get(`languages.${index}`);
            const rowId = `${base}-lang-${index}`;
            return (
              <div key={index} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="w-20 shrink-0 font-mono"
                    aria-label={t("fields.languages.code")}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${rowId}-msg` : undefined}
                    maxLength={3}
                    autoComplete="off"
                    value={row.code}
                    onChange={(event) =>
                      patch({ languages: draft.languages.map((r, i) => (i === index ? { ...r, code: event.target.value } : r)) })
                    }
                  />
                  <div className="w-44 shrink-0">
                  <Select
                    aria-label={t("fields.languages.level")}
                    aria-invalid={error ? true : undefined}
                    value={row.level}
                    onChange={(event) =>
                      patch({ languages: draft.languages.map((r, i) => (i === index ? { ...r, level: event.target.value } : r)) })
                    }
                  >
                    {LANGUAGE_LEVEL_OPTIONS.map((level) => (
                      <option key={level} value={level}>
                        {t(`options.level.${level}`)}
                      </option>
                    ))}
                  </Select>
                  </div>
                  <LevelScale mine={cefrOf(row.level)} className="shrink-0" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("actions.removeRow")}
                    onClick={() => patch({ languages: draft.languages.filter((_, i) => i !== index) })}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <ErrorText id={`${rowId}-msg`} error={error} />
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => patch({ languages: [...draft.languages, { ...NEW_LANGUAGE }] })}
          >
            <Plus aria-hidden />
            {t("fields.languages.add")}
          </Button>
        </div>
      </Field>

      <Field id={`${base}-skills`} group label={t("fields.skills.label")}>
        <div className="flex flex-col gap-2">
          {draft.skills.length === 0 ? <p className="text-ink-2 text-body-sm">{t("fields.skills.empty")}</p> : null}
          {draft.skills.map((row, index) => {
            const nameError = errors.get(`skills.${index}.name`);
            const yearsError = errors.get(`skills.${index}.years`);
            const rowId = `${base}-skill-${index}`;
            return (
              <div key={index} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="min-w-0 flex-1 basis-40"
                    aria-label={t("fields.skills.name")}
                    placeholder={t("fields.skills.name")}
                    aria-invalid={nameError ? true : undefined}
                    aria-describedby={nameError ? `${rowId}-name-msg` : undefined}
                    autoComplete="off"
                    value={row.name}
                    onChange={(event) =>
                      patch({ skills: draft.skills.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)) })
                    }
                  />
                  <SegBlocks value={yearsShare(row.years)} cells={SKILL_CELLS} label={false} ariaLabel={t("skillScale.aria", { name: row.name || t("fields.skills.name"), years: row.years || "—" })} className="shrink-0" />
                  <Input
                    className="w-24 shrink-0 font-mono tabular-nums"
                    suffix={t("units.years")}
                    inputMode="decimal"
                    aria-label={t("fields.skills.years")}
                    placeholder={t("fields.skills.years")}
                    aria-invalid={yearsError ? true : undefined}
                    aria-describedby={yearsError ? `${rowId}-years-msg` : undefined}
                    autoComplete="off"
                    value={row.years}
                    onChange={(event) =>
                      patch({ skills: draft.skills.map((r, i) => (i === index ? { ...r, years: event.target.value } : r)) })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("actions.removeRow")}
                    onClick={() => patch({ skills: draft.skills.filter((_, i) => i !== index) })}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <ErrorText id={`${rowId}-name-msg`} error={nameError} />
                <ErrorText id={`${rowId}-years-msg`} error={yearsError} />
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => patch({ skills: [...draft.skills, { ...NEW_SKILL }] })}
          >
            <Plus aria-hidden />
            {t("fields.skills.add")}
          </Button>
        </div>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={yearsId} label={t("fields.years_experience.label")} hint={t("fields.years_experience.hint")} error={errors.get("years_experience")}>
          <Input
            id={yearsId}
            inputMode="decimal"
            className="font-mono tabular-nums"
            suffix={t("units.years")}
            autoComplete="off"
            value={draft.years_experience}
            aria-invalid={errors.has("years_experience") || undefined}
            aria-describedby={describedBy(yearsId, true, errors.get("years_experience"))}
            onChange={(event) => patch({ years_experience: event.target.value })}
          />
        </Field>
        <Field id={cityId} label={t("fields.city.label")} error={errors.get("city")}>
          <Input
            id={cityId}
            autoComplete="off"
            value={draft.city}
            aria-invalid={errors.has("city") || undefined}
            aria-describedby={describedBy(cityId, false, errors.get("city"))}
            onChange={(event) => patch({ city: event.target.value })}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Switch id={`${base}-visa`} checked={draft.needs_visa_sponsorship} onCheckedChange={(checked) => patch({ needs_visa_sponsorship: checked })} />
        <label htmlFor={`${base}-visa`} className="text-label cursor-pointer font-bold">
          {t("fields.needs_visa_sponsorship.label")}
        </label>
      </div>

      <Field id={summaryId} label={t("fields.summary.label")} hint={t("fields.summary.hint")} error={errors.get("summary")}>
        <Textarea
          id={summaryId}
          rows={5}
          value={draft.summary}
          aria-invalid={errors.has("summary") || undefined}
          aria-describedby={describedBy(summaryId, true, errors.get("summary"))}
          onChange={(event) => patch({ summary: event.target.value })}
        />
      </Field>
    </FormCard>
  );
}
