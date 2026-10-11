/** The `visa` texts outside React (`pnpm visa:scan`), in the language the caller passes (CLI: `cli.locale`). */
import type { Locale } from "@/i18n/locale";
import { defaultUiLocale } from "@/lib/i18n/config";
import { translatorFor } from "@/lib/i18n/node";

export function visaTranslator(locale: Locale = defaultUiLocale()) {
  return translatorFor(locale, "visa");
}
