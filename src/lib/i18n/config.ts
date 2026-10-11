/**
 * The configured languages (language.yaml), read tolerantly. Server and Node only. A missing or invalid file never
 * breaks a page, a Telegram message or the doctor: the shipped fallback (English) is used and `config:check` / the doctor
 * report the file.
 */
import { ConfigError, loadConfig, reloadConfig, type LanguageConfig } from "@/lib/config";
import { FALLBACK, isLocale, type Locale } from "@/i18n/locale";

/**
 * language.yaml as loaded (cached; the runner's watcher and the settings save refresh it); null when it cannot be read.
 * `fresh`: read the file again (the web app has no watcher: a page read sees a hand edit at once, like ui.yaml).
 */
export function languageSettings(options: { fresh?: boolean } = {}): LanguageConfig | null {
  try {
    return options.fresh ? reloadConfig("language") : loadConfig("language");
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** The interface language of a browser that never picked one. */
export function defaultUiLocale(config: LanguageConfig | null = languageSettings()): Locale {
  return config?.ui.default_locale ?? FALLBACK;
}

/** The language of Telegram messages: `notify.locale`, else the default interface language. */
export function notifyLocale(config: LanguageConfig | null = languageSettings()): Locale {
  return config?.notify.locale ?? defaultUiLocale(config);
}

/** The language of the user commands (doctor, sources:list): `cli.locale`, else the default interface language. */
export function cliLocale(config: LanguageConfig | null = languageSettings()): Locale {
  return config?.cli.locale ?? defaultUiLocale(config);
}

/** The language AI texts are written in. */
export function aiOutputLanguage(config: LanguageConfig | null = languageSettings()): string {
  return config?.ai.output ?? FALLBACK;
}

/** The language job ads are translated into. */
export function translationTarget(config: LanguageConfig | null = languageSettings()): string {
  return config?.translation.target ?? FALLBACK;
}

/** The command-line language for a run: `override` (`--lang`) when it names an interface language, else `cli.locale` of `config`. */
export function cliLocaleFrom(config: LanguageConfig | null, override?: string | null): Locale {
  return override !== undefined && override !== null && isLocale(override) ? override : cliLocale(config);
}

/** The languages the AI writes in: `ai.output` and the extra summary languages `ai.summary_also`. */
export function aiOutputLanguages(config: LanguageConfig | null = languageSettings()): { language: string; also: string[] } {
  return { language: aiOutputLanguage(config), also: [...(config?.ai.summary_also ?? [])] };
}
