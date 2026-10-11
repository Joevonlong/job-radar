"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";

import { describedBy } from "@/components/profile/fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RESERVED_CATEGORY_IDS, SIGNAL_CATEGORY_KINDS, type SignalCategoryKind } from "@/lib/config/schemas/interests";
import { uniquePresetId, type PresetOption } from "@/lib/interests/presets";
import { isValidCategoryId, newCategoryDraft, type CategoryDraft } from "@/lib/interests/vocabulary-draft";
import type { SignalColor } from "@/lib/signals/palette";
import { cn } from "@/lib/utils";

import { ColorPicker } from "./color-picker";

interface CategoryAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every id in use, active and deleted (an id is never used twice). */
  takenIds: readonly string[];
  /** An amount category exists already (there can be one). */
  hasAmount: boolean;
  /** The colour the form starts with (the first one no category uses). */
  initialColor: SignalColor;
  onAdd: (draft: CategoryDraft) => void;
  /** Presets the form can start from (signal-presets.yaml); none hides the picker. */
  presets?: readonly PresetOption[];
}

type AddError = "idFormat" | "idReserved" | "idTaken" | "nameRequired";

/**
 * "Add a category": id, kind, the two names and the colour. Checked here as typed (the save checks again on the
 * server); the new category is added to the draft, expanded, and saved with the rest of the form.
 */
export function CategoryAddDialog({ open, onOpenChange, takenIds, hasAmount, initialColor, onAdd, presets = [] }: CategoryAddDialogProps) {
  const t = useTranslations("interests.categories");
  const tp = useTranslations("interests.presets");
  const locale = useLocale();
  const base = useId();
  const [presetId, setPresetId] = useState("");
  const [adjusted, setAdjusted] = useState<{ from: string; to: string } | null>(null);
  const [id, setId] = useState("");
  const [kind, setKind] = useState<SignalCategoryKind>("keyword");
  const [labelZh, setLabelZh] = useState("");
  const [labelEn, setLabelEn] = useState("");
  const [color, setColor] = useState<SignalColor>(initialColor);
  const [errors, setErrors] = useState<Partial<Record<"id" | "name", AddError>>>({});

  function reset() {
    setPresetId("");
    setAdjusted(null);
    setId("");
    setKind("keyword");
    setLabelZh("");
    setLabelEn("");
    setColor(initialColor);
    setErrors({});
  }

  /** Fill the form from a preset ("" = blank); a taken id gets a suffix, and the form says so. */
  function choosePreset(value: string) {
    setPresetId(value);
    setErrors({});
    const preset = presets.find((entry) => entry.id === value);
    if (!preset) {
      setAdjusted(null);
      return;
    }
    const next = uniquePresetId(preset.id, takenIds);
    setAdjusted(next === preset.id ? null : { from: preset.id, to: next });
    setId(next);
    setKind("keyword");
    setLabelZh(preset.draft.labelZh);
    setLabelEn(preset.draft.labelEn);
    setColor(preset.draft.color);
  }

  function check(): Partial<Record<"id" | "name", AddError>> {
    const trimmed = id.trim();
    const found: Partial<Record<"id" | "name", AddError>> = {};
    if (!isValidCategoryId(trimmed)) found.id = "idFormat";
    else if ((RESERVED_CATEGORY_IDS as readonly string[]).includes(trimmed.toLowerCase())) found.id = "idReserved";
    else if (takenIds.some((taken) => taken.toLowerCase() === trimmed.toLowerCase())) found.id = "idTaken";
    if (labelZh.trim() === "" && labelEn.trim() === "") found.name = "nameRequired";
    return found;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const preset = presets.find((entry) => entry.id === presetId);
    // a preset brings its definition, words, icon and weight (only for the kind it was written for)
    onAdd(newCategoryDraft({ id: id.trim(), kind, labelZh: labelZh.trim(), labelEn: labelEn.trim(), color }, preset && kind === preset.draft.kind ? preset.draft : undefined));
    reset();
    onOpenChange(false);
  }

  const idError = errors.id ? t(`addErrors.${errors.id}`) : undefined;
  const nameError = errors.name ? t(`addErrors.${errors.name}`) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="category-add-dialog">
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("addTitle")}</DialogTitle>
            <DialogDescription>{t("addDescription")}</DialogDescription>
          </DialogHeader>

          {presets.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-preset`} className="text-label font-bold">
                {tp("label")}
              </label>
              <NativeSelect id={`${base}-preset`} value={presetId} aria-describedby={`${base}-preset-hint`} onChange={(event) => choosePreset(event.target.value)} data-testid="category-add-preset">
                <option value="">{tp("blank")}</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {(locale === "zh" ? preset.labelZh || preset.labelEn : preset.labelEn || preset.labelZh) || preset.id}
                  </option>
                ))}
              </NativeSelect>
              <p id={`${base}-preset-hint`} className="text-ink-2 text-body-sm">
                {tp("hint")}
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${base}-id`} className="text-label font-bold">
              {t("id")}
            </label>
            <Input
              id={`${base}-id`}
              value={id}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-invalid={idError !== undefined || undefined}
              aria-describedby={describedBy(`${base}-id`, true, idError)}
              onChange={(event) => setId(event.target.value)}
              data-testid="category-add-id"
            />
            <p id={`${base}-id-hint`} className="text-ink-2 text-body-sm">
              {t("idHint")}
            </p>
            {adjusted && id === adjusted.to ? (
              <p className="text-ink-2 text-body-sm" data-testid="category-add-id-adjusted">
                {tp("idAdjusted", { id: adjusted.from, next: adjusted.to })}
              </p>
            ) : null}
            {idError ? (
              <p id={`${base}-id-msg`} role="alert" className="text-bad text-body-sm font-bold" data-testid="category-add-id-error">
                {idError}
              </p>
            ) : null}
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-label mb-1.5 font-bold">{t("kind")}</legend>
            <div role="radiogroup" aria-label={t("kind")} className="flex flex-wrap gap-2">
              {SIGNAL_CATEGORY_KINDS.map((option) => {
                const disabled = option === "amount" && hasAmount;
                return (
                  <label
                    key={option}
                    className={cn(
                      "border-border flex cursor-pointer items-center gap-2 rounded-tag border-bw px-2.5 py-1.5 text-body-sm font-bold has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal-t4",
                      kind === option ? "bg-hi text-hi-ink" : "bg-card",
                      disabled && "cursor-not-allowed opacity-45",
                    )}
                  >
                    <input type="radio" name={`${base}-kind`} value={option} checked={kind === option} disabled={disabled} onChange={() => setKind(option)} className="sr-only" data-testid={`category-add-kind-${option}`} />
                    {t(`kinds.${option}`)}
                  </label>
                );
              })}
            </div>
            <p className="text-ink-2 text-body-sm">{hasAmount && kind !== "amount" ? `${t(`kindHints.${kind}`)} ${t("amountTaken")}` : t(`kindHints.${kind}`)}</p>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-zh`} className="text-label font-bold">
                {t("labelZh")}
              </label>
              <Input id={`${base}-zh`} value={labelZh} autoComplete="off" aria-invalid={nameError !== undefined || undefined} aria-describedby={nameError ? `${base}-name-msg` : undefined} onChange={(event) => setLabelZh(event.target.value)} data-testid="category-add-zh" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-en`} className="text-label font-bold">
                {t("labelEn")}
              </label>
              <Input id={`${base}-en`} value={labelEn} autoComplete="off" aria-invalid={nameError !== undefined || undefined} aria-describedby={nameError ? `${base}-name-msg` : undefined} onChange={(event) => setLabelEn(event.target.value)} data-testid="category-add-en" />
            </div>
          </div>
          {nameError ? (
            <p id={`${base}-name-msg`} role="alert" className="text-bad text-body-sm font-bold">
              {nameError}
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span id={`${base}-color`} className="text-label font-bold">
              {t("color")}
            </span>
            <ColorPicker labelledBy={`${base}-color`} value={color} onChange={setColor} testId="category-add-color" />
          </div>

          <DialogFooter>
            <Button type="button" variant="default" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="primary" data-testid="category-add-submit">
              {t("addSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
