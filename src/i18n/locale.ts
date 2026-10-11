/**
 * Interface languages: one per `messages/<id>.json`, listed in the generated catalog. The default language comes
 * from `language.yaml: ui.default_locale` (see `request.ts`); this module is pure and safe in client bundles.
 */
import { FALLBACK_LOCALE } from "./catalog-schema";
import { FORMAT_LABELS, LOCALE_META, LOCALES, type Locale } from "./catalog.generated";

export { FORMAT_LABELS, LOCALE_META, LOCALES, type Locale };

/** The language used when nothing else is known (no cookie, no readable language.yaml). */
export const FALLBACK: Locale = FALLBACK_LOCALE;
export const LOCALE_COOKIE = "NEXT_LOCALE";
/** One year, in seconds. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Resolve a raw cookie value (untrusted input) to a supported locale; `fallback` when it is not one. */
export function resolveLocale(value: string | null | undefined, fallback: Locale = FALLBACK): Locale {
  return isLocale(value) ? value : fallback;
}

/** The BCP 47 tag of an interface language (`en-US`, `zh-CN`): `lang` attributes and `Intl`. */
export function intlTag(locale: Locale): string {
  return LOCALE_META[locale].intl;
}
