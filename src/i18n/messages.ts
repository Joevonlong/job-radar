/**
 * Messages of an interface language. A core language (en, zh) is complete; any other one is laid over English,
 * so a key it lacks shows the English text.
 */
import { deepMergeMessages } from "./merge";
import { CORE_LOCALES, FALLBACK_LOCALE } from "./catalog-schema";
import { MESSAGE_LOADERS, type Locale } from "./catalog.generated";

export type Messages = typeof import("../../messages/en.json");

export function isCoreLocale(locale: string): boolean {
  return (CORE_LOCALES as readonly string[]).includes(locale);
}

/** The messages of `locale` for next-intl (web): loaded on demand, non-core languages merged over English. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  const own = (await MESSAGE_LOADERS[locale]()) as Messages;
  if (isCoreLocale(locale)) return own;
  const base = (await MESSAGE_LOADERS[FALLBACK_LOCALE]()) as Messages;
  return deepMergeMessages(base, own);
}
