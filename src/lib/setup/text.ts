/**
 * The setup texts outside React (`pnpm run setup`), from `messages/` like the pages, in the command-line language
 * (`language.yaml: cli.locale`, `--lang` overrides it).
 */
import type { Locale } from "@/i18n/locale";
import { cliLocaleFrom, languageSettings } from "@/lib/i18n/config";
import { translatorFor } from "@/lib/i18n/node";

/** The language of the command line: `override` (`--lang`) when it names an interface language, else `cli.locale`. */
export function cliLocale(override?: string | null): Locale {
  return cliLocaleFrom(languageSettings({ fresh: true }), override);
}

/** Translator of the `setup` namespace. */
export function setupTranslator(locale: Locale) {
  return translatorFor(locale, "setup");
}

export type SetupTranslator = ReturnType<typeof setupTranslator>;

/** Translator of the profile page's field errors (the profile fields of the setup report them). */
export function profileErrorsTranslator(locale: Locale) {
  return translatorFor(locale, "profile.errors");
}

/** Translator of the profile fields' interface labels (`profile.incomplete.fields.*`, `separator`). */
export function profileFieldsTranslator(locale: Locale) {
  return translatorFor(locale, "profile.incomplete");
}
