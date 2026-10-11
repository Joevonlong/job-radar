/**
 * Language codes. Interface languages are the messages files (`LOCALES`); AI output and translation targets may be
 * any language a BCP 47 tag names. Pure: safe in client bundles.
 */
import { LOCALE_META, isLocale, type Locale } from "@/i18n/locale";

/** `en`, `zh`, `pt-BR`, `zh-Hant`: a lowercase language subtag, optionally a script and / or region, that `Intl` accepts. */
const CODE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;

export function isLanguageCode(value: unknown): value is string {
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}

/** The primary language subtag (`zh` of `zh-Hant`). */
export function primaryLanguage(code: string): string {
  return code.split("-")[0]?.toLowerCase() ?? code;
}

/** Same language, ignoring script and region (`zh` = `zh-CN`, `en` ≠ `de`). */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return primaryLanguage(a) === primaryLanguage(b);
}

/** The interface language whose code is `code` or shares its primary subtag; null when there is none. */
export function localeOf(code: string): Locale | null {
  if (isLocale(code)) return code;
  const primary = primaryLanguage(code);
  return isLocale(primary) ? primary : null;
}

function displayName(code: string, inLanguage: string): string | null {
  try {
    return new Intl.DisplayNames([inLanguage], { type: "language" }).of(code) ?? null;
  } catch {
    return null;
  }
}

/** How a prompt names a language to the AI model: the messages file's `meta.promptName`, else its English name. */
export function promptLanguageName(code: string): string {
  if (isLocale(code)) return LOCALE_META[code].promptName;
  return displayName(code, "en") ?? code;
}

/** A language's name in the interface language (`德语`, `German`); the code itself when `Intl` does not know it. */
export function displayLanguageName(code: string, uiLocale: Locale): string {
  return displayName(code, LOCALE_META[uiLocale].intl) ?? code;
}

/** A language's own name (`中文`, `English`, `Deutsch`): an interface language's `meta.name`, else what `Intl` calls it in itself. */
export function languageAutonym(code: string): string {
  if (isLocale(code)) return LOCALE_META[code].name;
  const name = displayName(code, code);
  return name === null ? code : name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}

/** The BCP 47 tag for a `lang` attribute: an interface language's `meta.intl` (`zh-CN`), any other code as it is. */
export function bcp47(code: string): string {
  return isLocale(code) ? LOCALE_META[code].intl : code;
}

/** The writing system of a language (`Latn`, `Hans`, `Cyrl`, `Jpan`); null when `Intl` cannot tell. */
export function targetScript(code: string): string | null {
  try {
    return new Intl.Locale(code).maximize().script ?? null;
  } catch {
    return null;
  }
}

/** Whether text in this language is wide (CJK): `meta.wide` of its messages file, else from its script. */
export function isWideLanguage(code: string): boolean {
  const locale = localeOf(code);
  if (locale !== null) return LOCALE_META[locale].wide;
  const script = targetScript(code);
  return script !== null && WIDE_SCRIPTS.has(script);
}

/** Scripts written with wide (full-width) characters. Unicode facts, not copy. */
const WIDE_SCRIPTS = new Set(["Hans", "Hant", "Hani", "Jpan", "Kore", "Hang"]);
