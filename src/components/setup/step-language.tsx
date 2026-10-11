"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Field, describedBy } from "@/components/profile/fields";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LOCALE_META, LOCALES, type Locale } from "@/i18n/locale";
import { displayLanguageName, isLanguageCode } from "@/lib/i18n/languages";
import type { SetupView } from "@/lib/setup/view";

import { StepFrame } from "./step-frame";
import { useStep } from "./use-step";

/** The name of a typed language code in the interface language, once it is a valid code. */
function codeName(code: string, locale: Locale): string | null {
  const trimmed = code.trim();
  return isLanguageCode(trimmed) ? displayLanguageName(trimmed, locale) : null;
}

/** Step 1: the interface language (preselected from the browser before the first save), the AI output and translation languages (language.yaml). */
export function StepLanguage({ view }: { view: SetupView["language"] }) {
  const t = useTranslations("setup.language");
  const { pending, save, skip, errors, formError } = useStep("language");
  const [ui, setUi] = useState<Locale>(view.suggested ?? view.current);
  const [aiOutput, setAiOutput] = useState(view.aiOutput);
  const [translation, setTranslation] = useState(view.translationTarget);

  return (
    <StepFrame
      step="language"
      pending={pending}
      formError={formError}
      onSkip={skip}
      onSubmit={() => save(view.fileAvailable ? { ui_locale: ui, ai_output: aiOutput, translation_target: translation } : { ui_locale: ui })}
    >
      <fieldset className="flex flex-col gap-sp-2" aria-describedby="setup-language-ui-hint">
        <legend className="mb-1.5 text-label font-bold">{t("ui")}</legend>
        <div className="flex flex-wrap gap-sp-2" data-testid="setup-language-ui">
          {LOCALES.map((locale) => (
            <label
              key={locale}
              className={cn(
                "flex h-ctl-md cursor-pointer items-center gap-sp-2 rounded-btn border-bw border-border px-4 text-label font-extrabold shadow-e2 has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal-t4",
                ui === locale ? "bg-hi text-hi-ink" : "bg-card text-ink hover:bg-soft",
              )}
            >
              <input type="radio" name="setup-ui-locale" value={locale} checked={ui === locale} onChange={() => setUi(locale)} className="sr-only" data-testid={`setup-locale-${locale}`} />
              <span lang={locale}>{LOCALE_META[locale].name}</span>
            </label>
          ))}
        </div>
        <p id="setup-language-ui-hint" className="text-body-sm text-ink-2">
          {t("uiHint")}
          {view.suggested !== null ? ` ${t("suggested", { language: LOCALE_META[view.suggested].name })}` : ""}
        </p>
      </fieldset>
      {view.fileAvailable ? (
        <div className="grid gap-sp-4 sm:grid-cols-2">
          <Field id="setup-ai-output" label={t("aiOutput")} hint={`${t("aiOutputHint")}${codeName(aiOutput, ui) ? ` · ${codeName(aiOutput, ui)}` : ""}`} errorText={errors.text("ai_output")}>
            <Input
              id="setup-ai-output"
              className="max-w-40 font-mono"
              autoComplete="off"
              value={aiOutput}
              aria-invalid={errors.has("ai_output") || undefined}
              aria-describedby={describedBy("setup-ai-output", true, errors.text("ai_output"))}
              onChange={(event) => setAiOutput(event.target.value)}
            />
          </Field>
          <Field id="setup-translation" label={t("translation")} hint={`${t("translationHint")}${codeName(translation, ui) ? ` · ${codeName(translation, ui)}` : ""}`} errorText={errors.text("translation_target")}>
            <Input
              id="setup-translation"
              className="max-w-40 font-mono"
              autoComplete="off"
              value={translation}
              aria-invalid={errors.has("translation_target") || undefined}
              aria-describedby={describedBy("setup-translation", true, errors.text("translation_target"))}
              onChange={(event) => setTranslation(event.target.value)}
            />
          </Field>
        </div>
      ) : null}
    </StepFrame>
  );
}
