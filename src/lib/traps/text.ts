/**
 * The `aiTraps` texts outside React: the Telegram badge, the resume-kit export notice, `pnpm run doctor` and `pnpm traps:scan`.
 * The caller passes the language of its audience (Telegram: `notify.locale`, CLI: `cli.locale`); without one the
 * default interface language (`language.yaml: ui.default_locale`) is used.
 */
import type { Locale } from "@/i18n/locale";
import { defaultUiLocale } from "@/lib/i18n/config";
import { translatorFor } from "@/lib/i18n/node";

export function trapsTranslator(locale: Locale = defaultUiLocale()) {
  return translatorFor(locale, "aiTraps");
}

export type TrapsTranslator = ReturnType<typeof trapsTranslator>;
