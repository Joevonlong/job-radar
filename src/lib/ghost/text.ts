/** The `ghostJobs` texts outside React (`pnpm ghost:check`), in the language the caller passes (CLI: `cli.locale`). */
import type { Locale } from "@/i18n/locale";
import { defaultUiLocale } from "@/lib/i18n/config";
import { translatorFor } from "@/lib/i18n/node";

export function ghostTranslator(locale: Locale = defaultUiLocale()) {
  return translatorFor(locale, "ghostJobs");
}
