/**
 * The language of Telegram (`language.yaml: notify.locale`, else the default interface language). Every message,
 * button and callback answer comes from the `telegram` messages namespace; application statuses reuse `dashboard.status`.
 * Format functions get a `NotifyText` passed in, so they stay pure and tests pick the language.
 */
import type { Locale } from "@/i18n/locale";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { notifyLocale } from "@/lib/i18n/config";
import { translatorFor } from "@/lib/i18n/node";

export type TelegramTranslator = ReturnType<typeof translatorFor<"telegram">>;

export interface NotifyText {
  locale: Locale;
  t: TelegramTranslator;
  /** The name of an application status (`dashboard.status.*`). */
  status: (status: ApplicationStatus) => string;
}

/** Texts in `locale` (default: the configured Telegram language). */
export function notifyText(locale: Locale = notifyLocale()): NotifyText {
  const statuses = translatorFor(locale, "dashboard.status");
  return { locale, t: translatorFor(locale, "telegram"), status: (status) => statuses(status) };
}
