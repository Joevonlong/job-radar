"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { enableMarketChannelsAction } from "@/app/me/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { consentKind } from "@/lib/channels/access";
import type { MarketView, PackOption } from "@/lib/market/view";
import type { FieldError, MarketDraft } from "@/lib/profile/draft";

import { Field, describedBy } from "./fields";

interface MarketFieldsProps {
  baseId: string;
  value: MarketDraft;
  /** The saved market (the reprocess note shows once the draft differs from it). */
  saved: MarketDraft;
  onChange: (next: MarketDraft) => void;
  market: MarketView;
  errors: Map<string, FieldError>;
}

function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Whether the local-language step would be on for this draft (the pack has rules for its language and the user keeps it). */
export function languageStepOn(pack: PackOption | undefined, homeLanguage: string): boolean {
  if (!pack || !pack.languageRules || pack.language === null) return false;
  const language = homeLanguage.trim() === "" ? pack.language : homeLanguage.trim().toLowerCase();
  return language === pack.language;
}

/**
 * The home country's name for the draft (not for the saved market): the draft's country, else the chosen pack's own.
 * Empty when the pack names none (the remote scope then says "home country" without a name).
 */
export function draftCountryName(market: MarketView, draft: MarketDraft): string {
  const code = draft.country !== "" ? draft.country : (market.packs.find((p) => p.id === draft.pack)?.country ?? "");
  if (code === "") return "";
  return market.countryOptions.find((o) => o.value === code)?.label ?? (code === market.country ? market.countryName : code);
}

/**
 * The home region for the draft: the saved market's region while the draft keeps its home country, else null (a region
 * of another country is not known here, and the scope then names no region).
 */
export function draftHomeRegion(market: MarketView, draft: MarketDraft): MarketView["homeRegion"] {
  const code = draft.country !== "" ? draft.country : (market.packs.find((p) => p.id === draft.pack)?.country ?? "");
  return code !== "" && code === market.country ? market.homeRegion : null;
}

const sameMarket = (a: MarketDraft, b: MarketDraft): boolean => a.pack === b.pack && a.country === b.country && a.currency === b.currency && a.home_language === b.home_language;

/**
 * The market block at the top of "What I want": the pack, and the home country, base currency and local language
 * (empty = the pack's own). Says whether the local-language step is on, that stored jobs need `pnpm reprocess` after a
 * change, and offers to switch on the market's own job boards.
 */
export function MarketFields({ baseId, value, saved, onChange, market, errors }: MarketFieldsProps) {
  const t = useTranslations("market.form");
  const locale = useLocale();
  const pack = market.packs.find((p) => p.id === value.pack);
  const ids = { pack: `${baseId}-pack`, country: `${baseId}-country`, currency: `${baseId}-currency`, language: `${baseId}-language` };
  const countryLabel = (code: string): string => market.countryOptions.find((o) => o.value === code)?.label ?? code;
  const homeLanguage = value.home_language.trim() === "" ? (pack?.language ?? "") : value.home_language.trim().toLowerCase();
  const stepOn = languageStepOn(pack, value.home_language);
  const changed = !sameMarket(value, saved);
  // a currency without a rate in pipeline.yaml is never converted: the salary floor and the salary signal do not work for it
  const effectiveCurrency = value.currency !== "" ? value.currency : (pack?.currency ?? "");
  const noRate = effectiveCurrency !== "" && market.rateCurrencies.length > 0 && !market.rateCurrencies.includes(effectiveCurrency);
  const offChannels = market.localChannels.filter((c) => !c.enabled && consentKind(c.id) === null);
  // channels with a terms-of-service notice are never switched on in one click: they are confirmed one by one on the sources page
  const consentChannels = market.localChannels.filter((c) => !c.enabled && consentKind(c.id) !== null);
  const [pending, startTransition] = useTransition();
  const [channelsResult, setChannelsResult] = useState<"done" | "error" | null>(null);

  const packDefault = (field: "country" | "currency" | "language"): string | null => {
    const v = pack?.[field] ?? null;
    if (v === null) return null;
    return field === "country" ? countryLabel(v) : field === "language" ? languageName(v, locale) : v;
  };
  const defaultOption = (field: "country" | "currency"): string => {
    const v = packDefault(field);
    return v === null ? t("choose") : t("packDefault", { value: v });
  };

  return (
    <section className="border-border flex flex-col gap-4 rounded-lg border p-4" data-testid="market-block" aria-labelledby={`${baseId}-title`}>
      <div className="flex flex-col gap-1">
        <h3 id={`${baseId}-title`} className="text-label font-bold">
          {t("title")}
        </h3>
        <p className="text-ink-2 text-body-sm">{t("description")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={ids.pack} label={t("pack")} error={errors.get("market.pack")}>
          <Select
            id={ids.pack}
            value={value.pack}
            data-testid="market-pack"
            aria-invalid={errors.has("market.pack") || undefined}
            aria-describedby={describedBy(ids.pack, false, errors.get("market.pack"))}
            onChange={(event) => onChange({ pack: event.target.value, country: "", currency: "", home_language: "" })}
          >
            {pack === undefined ? <option value={value.pack}>{value.pack}</option> : null}
            {market.packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={ids.country} label={t("country")} error={errors.get("market.country")}>
          <Select
            id={ids.country}
            value={value.country}
            data-testid="market-country"
            aria-invalid={errors.has("market.country") || undefined}
            aria-describedby={describedBy(ids.country, false, errors.get("market.country"))}
            onChange={(event) => onChange({ ...value, country: event.target.value })}
          >
            <option value="">{defaultOption("country")}</option>
            {value.country !== "" && !market.countryOptions.some((o) => o.value === value.country) ? <option value={value.country}>{value.country}</option> : null}
            {market.countryOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={ids.currency} label={t("currency")} hint={t("currencyHint")} error={errors.get("market.currency")}>
          <Select
            id={ids.currency}
            value={value.currency}
            data-testid="market-currency"
            aria-invalid={errors.has("market.currency") || undefined}
            aria-describedby={describedBy(ids.currency, true, errors.get("market.currency"))}
            onChange={(event) => onChange({ ...value, currency: event.target.value })}
          >
            <option value="">{defaultOption("currency")}</option>
            {value.currency !== "" && !market.currencyOptions.some((o) => o.value === value.currency) ? <option value={value.currency}>{value.currency}</option> : null}
            {market.currencyOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={ids.language} label={t("language")} hint={t("languageHint")} error={errors.get("market.home_language")}>
          <Input
            id={ids.language}
            className="max-w-40 font-mono"
            autoComplete="off"
            maxLength={3}
            data-testid="market-language"
            placeholder={pack?.language ?? ""}
            value={value.home_language}
            aria-invalid={errors.has("market.home_language") || undefined}
            aria-describedby={describedBy(ids.language, true, errors.get("market.home_language"))}
            onChange={(event) => onChange({ ...value, home_language: event.target.value })}
          />
        </Field>
      </div>
      {noRate ? (
        <p className="text-body-sm font-semibold" role="note" data-testid="market-currency-no-rate">
          {t("currencyNoRate", { currency: effectiveCurrency })}
        </p>
      ) : null}
      <p className="text-body-sm" data-testid="market-language-step" data-on={stepOn}>
        {stepOn ? t("stepOn", { language: languageName(homeLanguage, locale) }) : homeLanguage === "" ? t("stepOffNoLanguage") : t("stepOff", { language: languageName(homeLanguage, locale) })}
      </p>
      {changed ? (
        <p className="text-ink-2 text-body-sm" data-testid="market-reprocess-note">
          {t.rich("reprocessNote", { code: (chunks) => <code className="font-mono">{chunks}</code> })}
        </p>
      ) : null}
      {!changed && market.error === null && offChannels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="market-local-channels">
          <p className="text-body-sm">{t("localChannels", { channels: offChannels.map((c) => c.id).join(", "), count: offChannels.length })}</p>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await enableMarketChannelsAction();
                setChannelsResult(result.status === "done" ? "done" : "error");
              })
            }
          >
            {t("enableLocalChannels")}
          </Button>
        </div>
      ) : null}
      {!changed && market.error === null && consentChannels.length > 0 ? (
        <p className="text-body-sm" data-testid="market-consent-channels">
          {t("localChannelsConsent", { channels: consentChannels.map((c) => c.id).join(", ") })}
        </p>
      ) : null}
      {channelsResult !== null ? (
        <p role="status" className={channelsResult === "done" ? "text-body-sm" : "text-bad text-body-sm font-bold"}>
          {channelsResult === "done" ? t("localChannelsEnabled") : t("localChannelsFailed")}
        </p>
      ) : null}
    </section>
  );
}
