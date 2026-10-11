"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { TriggerButton } from "@/components/control/trigger-button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LOCALE_META, LOCALES, isLocale, type Locale } from "@/i18n/locale";
import type { SetupView } from "@/lib/setup/view";

import { EnvPresenceList } from "./env-presence";
import { StepFrame } from "./step-frame";
import { useStep } from "./use-step";

/** Step 7 (optional): Telegram on / off, whether the two variables are set (names only), and a test message. */
export function StepTelegram({ view }: { view: SetupView["telegram"] }) {
  const t = useTranslations("setup.telegram");
  const tEnv = useTranslations("setup.env");
  const { pending, save, skip, formError } = useStep("telegram");
  const [enabled, setEnabled] = useState(view.enabled ?? false);
  const [locale, setLocale] = useState<Locale | null>(view.notifyLocale);
  const missing = view.env.some((e) => !e.present);

  if (view.enabled === null) {
    return (
      <StepFrame step="telegram" pending={pending} formError={formError} onSkip={skip} onSubmit={() => undefined} disabled>
        <p role="alert" className="text-body-sm font-bold text-bad">
          {t("unreadable")}
        </p>
      </StepFrame>
    );
  }

  return (
    <StepFrame step="telegram" pending={pending} formError={formError} onSkip={skip} onSubmit={() => save(view.fileAvailable ? { enabled, notify_locale: locale } : { enabled })}>
      <div className="flex items-center gap-sp-3">
        <Switch id="setup-telegram-enabled" checked={enabled} onCheckedChange={setEnabled} data-testid="setup-telegram-enabled" />
        <label htmlFor="setup-telegram-enabled" className="cursor-pointer text-label font-bold">
          {t("enabled")}
        </label>
      </div>
      <EnvPresenceList env={view.env} />
      {view.fileAvailable ? (
        <div className="flex max-w-xs flex-col gap-1.5">
          <label htmlFor="setup-telegram-locale" className="text-label font-bold">
            {t("locale")}
          </label>
          <Select id="setup-telegram-locale" value={locale ?? ""} onChange={(event) => setLocale(isLocale(event.target.value) ? event.target.value : null)} data-testid="setup-telegram-locale">
            <option value="">{t("localeDefault")}</option>
            {LOCALES.map((code) => (
              <option key={code} value={code}>
                {LOCALE_META[code].name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <p className="text-body-sm text-ink-2">{t("howTo")}</p>
      {missing ? <p className="text-body-sm text-ink-2">{tEnv("restart")}</p> : null}
      <div className="flex flex-col gap-sp-1">
        <TriggerButton kind="testTelegram" confirm disabled={missing} />
        <p className="text-body-sm text-ink-2">{t("testHint")}</p>
      </div>
    </StepFrame>
  );
}
