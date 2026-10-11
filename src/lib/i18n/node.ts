/**
 * Translators outside React (runner, ai-worker, CLI): Telegram uses `notify.locale`, the user commands (doctor,
 * sources:list) use `cli.locale`. Every language's messages are bundled (`messages.generated.ts`); a non-core language is
 * laid over English. Server and Node only.
 */
import { createTranslator, type Messages, type NamespaceKeys, type NestedKeyOf } from "next-intl";

import { isCoreLocale } from "@/i18n/messages";
import { deepMergeMessages } from "@/i18n/merge";
import { BUNDLED_MESSAGES } from "@/i18n/messages.generated";
import { FALLBACK, isLocale, type Locale } from "@/i18n/locale";

import { cliLocale, notifyLocale } from "./config";

const merged = new Map<Locale, Messages>();

/** The complete messages of a language (a non-core one merged over English). */
export function messagesFor(locale: Locale): Messages {
  const hit = merged.get(locale);
  if (hit) return hit;
  const own = BUNDLED_MESSAGES[locale] as Messages;
  const value = isCoreLocale(locale) ? own : deepMergeMessages(BUNDLED_MESSAGES[FALLBACK] as Messages, own);
  merged.set(locale, value);
  return value;
}

export type TranslatorNamespace = NamespaceKeys<Messages, NestedKeyOf<Messages>>;

/** A translator for one namespace in a given language. */
export function translatorFor<N extends TranslatorNamespace>(locale: Locale, namespace: N) {
  return createTranslator<Messages, N>({ locale, messages: messagesFor(locale), namespace });
}

/** Who the text is for: `notify` = Telegram (`notify.locale`), `cli` = the user commands (`cli.locale`). */
export type TextScope = "notify" | "cli";

/** The language of a scope; `override` (a `--lang` argument) wins when it names an interface language. */
export function scopeLocale(scope: TextScope, override?: string | null): Locale {
  if (override !== undefined && override !== null && isLocale(override)) return override;
  return scope === "notify" ? notifyLocale() : cliLocale();
}

/** `translatorFor(scopeLocale(scope, override), namespace)`. */
export function getTranslator<N extends TranslatorNamespace>(namespace: N, scope: TextScope, override?: string | null) {
  return translatorFor(scopeLocale(scope, override), namespace);
}
