/**
 * Setup step 1: languages. Writes language.yaml: `ui.default_locale`, `ai.output`, `translation.target`; the
 * Server Action also sets the language cookie, so the wizard switches at once. The Telegram step sets `notify.locale`.
 */
import { languageSchema, mutateConfig, type LanguageConfig } from "@/lib/config";
import { LOCALES, type Locale } from "@/i18n/locale";
import { isLanguageCode } from "@/lib/i18n/languages";

import { languageInputSchema } from "../inputs";
import { stepError, type SetupFieldError, type SetupStepResult } from "../types";
import { editable, finishStep, readFresh, setupFrozen, setupWriteError } from "./common";

export interface LanguageDefaults {
  uiDefault: Locale | null;
  aiOutput: string | null;
  translationTarget: string | null;
  notifyLocale: Locale | null;
}

/** What language.yaml says now (all null when it cannot be read). */
export function readLanguageDefaults(): LanguageDefaults {
  const config = readFresh("language");
  if (config === null) return { uiDefault: null, aiOutput: null, translationTarget: null, notifyLocale: null };
  return { uiDefault: config.ui.default_locale, aiOutput: config.ai.output, translationTarget: config.translation.target, notifyLocale: config.notify.locale };
}

/** Validate `next` with the language.yaml schema and write it; zod issues come back as field errors of the step. */
async function writeLanguage(update: (current: LanguageConfig) => LanguageConfig | null, fieldOf: (path: ReadonlyArray<PropertyKey>) => string, step: "language" | "telegram"): Promise<SetupStepResult | null> {
  let problem: SetupStepResult | null = null;
  try {
    await mutateConfig("language", (current) => {
      const next = update(editable(current));
      if (next === null) return null;
      const checked = languageSchema.safeParse(next);
      if (checked.success) return checked.data;
      const errors = checked.error.issues.map((issue): SetupFieldError => ({ path: fieldOf(issue.path), ns: "setup", key: "invalid", params: { message: issue.message } }));
      problem = stepError(step, null, errors);
      return null;
    });
    return problem;
  } catch (error) {
    return stepError(step, setupWriteError(error));
  }
}

/** Set `notify.locale` (the Telegram step); null = the interface default. */
export async function writeNotifyLocale(locale: Locale | null): Promise<SetupStepResult | null> {
  const current = readFresh("language");
  if (current === null) return stepError("telegram", "configUnreadable");
  return writeLanguage((next) => {
    if (next.notify.locale === locale) return null;
    next.notify.locale = locale;
    return next;
  }, () => "notify_locale", "telegram");
}

/** The first interface language an `Accept-Language` header asks for; null when it names none of ours. */
export function localeFromAcceptLanguage(header: string | null): Locale | null {
  if (header === null) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag !== "" && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    const primary = tag.split("-")[0] ?? "";
    const found = LOCALES.find((locale) => locale === primary);
    if (found) return found;
  }
  return null;
}

/** Validate and save the languages (the caller sets the interface language cookie on success). */
export async function saveLanguageStep(raw: unknown): Promise<SetupStepResult & { locale?: Locale }> {
  const frozen = setupFrozen("language");
  if (frozen) return frozen;
  const parsed = languageInputSchema.safeParse(raw);
  if (!parsed.success) return stepError("language", "invalidPayload");
  const input = parsed.data;
  const errors: SetupFieldError[] = [];
  const aiOutput = input.ai_output?.trim();
  const target = input.translation_target?.trim();
  if (aiOutput !== undefined && !isLanguageCode(aiOutput)) errors.push({ path: "ai_output", ns: "setup", key: "languageCode" });
  if (target !== undefined && !isLanguageCode(target)) errors.push({ path: "translation_target", ns: "setup", key: "languageCode" });
  if (errors.length > 0) return stepError("language", null, errors);

  const current = readFresh("language");
  if (current === null) return stepError("language", "configUnreadable");
  const problem = await writeLanguage((next) => {
    next.ui.default_locale = input.ui_locale;
    if (aiOutput !== undefined) {
      next.ai.output = aiOutput;
      // the extra summary languages must not repeat the output language
      next.ai.summary_also = next.ai.summary_also.filter((code) => code !== aiOutput);
    }
    if (target !== undefined) next.translation.target = target;
    return next;
  }, (path) => (path[0] === "translation" ? "translation_target" : path[0] === "ai" ? "ai_output" : "ui_locale"), "language");
  if (problem !== null) return problem;
  const result = await finishStep("language");
  return result.status === "saved" ? { ...result, locale: input.ui_locale } : result;
}
