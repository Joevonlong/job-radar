"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { MarketFields } from "@/components/profile/market-fields";
import { Field, describedBy } from "@/components/profile/fields";
import { PlacesField } from "@/components/profile/places-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { MarketView } from "@/lib/market/view";
import type { FieldError } from "@/lib/profile/draft";
import type { MarketInput } from "@/lib/setup/inputs";
import type { SetupView } from "@/lib/setup/view";

import { useBrowserTimeZone, useTimeZones } from "./browser";
import { StepFrame } from "./step-frame";
import { useStep } from "./use-step";

/** Most city suggestions shown at once (the rest are a type-ahead away). */
const MAX_SUGGESTIONS = 30;

interface StepMarketProps {
  view: SetupView["market"];
  /** The step was saved before: show the files' values, no browser pre-selection. */
  done: boolean;
  market: MarketView;
}

/** Step 2: market pack, country, currency, local language (the /me market block), home city, places and time zone. */
export function StepMarket({ view, done, market }: StepMarketProps) {
  const t = useTranslations("setup.market");
  const tProfile = useTranslations("profile.fields");
  const { pending, save, skip, errors, formError } = useStep("market");
  const browserZone = useBrowserTimeZone();
  const zones = useTimeZones();
  const [draft, setDraft] = useState<MarketInput | null>(view.draft);
  const [zoneChoice, setZoneChoice] = useState<string | null>(null);
  // What was chosen per pack, so switching away and back keeps the country / currency / language
  const packChoices = useRef(new Map<string, MarketInput["market"]>());
  // Whether the user set the currency / the cities themselves: until then a new country brings its own (a saved step counts as set)
  const [edited, setEdited] = useState({ currency: done, homeCity: done });

  if (draft === null || view.saved === null) {
    return (
      <StepFrame step="market" pending={pending} formError={formError} onSkip={skip} onSubmit={() => undefined} disabled>
        <p role="alert" className="text-body-sm font-bold text-bad">
          {t("unreadable")}
        </p>
      </StepFrame>
    );
  }

  const zone = zoneChoice ?? (!done && browserZone !== null ? browserZone : draft.timezone);
  const pack = market.packs.find((p) => p.id === draft.market.pack);
  const country = draft.market.country !== "" ? draft.market.country : (pack?.country ?? "");
  const suggestions = (view.cities[country] ?? []).filter((city) => city.toLowerCase() !== draft.home_city.trim().toLowerCase()).slice(0, MAX_SUGGESTIONS);
  const profileErrors = new Map<string, FieldError>();
  for (const path of ["market.pack", "market.country", "market.currency", "market.home_language"]) {
    const error = errors.profile(path);
    if (error) profileErrors.set(path, error);
  }
  const zoneOptions = zones.includes(zone) || zone === "" ? zones : [zone, ...zones];
  const ids = { city: "setup-market-city", places: "setup-market-places", zone: "setup-market-zone" };
  const cityError = errors.profile("home_city");
  const placesError = errors.profile("places");

  const setHomeCity = (home_city: string): void => {
    setEdited({ ...edited, homeCity: true });
    setDraft({ ...draft, home_city });
  };

  const changeMarket = (next: MarketInput["market"]): void => {
    if (next.pack === draft.market.pack) {
      if (next.country !== draft.market.country) {
        // a new country: its currency and its main city, unless the user chose them already
        const defaults = view.countryDefaults[next.country !== "" ? next.country : (market.packs.find((p) => p.id === next.pack)?.country ?? "")];
        setDraft({
          ...draft,
          market: edited.currency ? next : { ...next, currency: defaults?.currency ?? "" },
          home_city: edited.homeCity ? draft.home_city : (defaults?.city ?? ""),
        });
        return;
      }
      if (next.currency !== draft.market.currency) setEdited({ ...edited, currency: true });
      setDraft({ ...draft, market: next });
      return;
    }
    packChoices.current.set(draft.market.pack, draft.market);
    setDraft({ ...draft, market: packChoices.current.get(next.pack) ?? next });
  };

  return (
    <StepFrame step="market" pending={pending} formError={formError} onSkip={skip} onSubmit={() => save({ ...draft, timezone: zone })}>
      <MarketFields baseId="setup-market" value={draft.market} saved={view.saved} onChange={changeMarket} market={market} errors={profileErrors} />

      <Field id={ids.city} label={tProfile("home_city.label")} hint={tProfile("home_city.hint")} error={cityError} errorText={errors.text("home_city")}>
        <Input id={ids.city} className="max-w-72" value={draft.home_city} data-testid="setup-home-city" aria-invalid={errors.has("home_city") || undefined} aria-describedby={describedBy(ids.city, true, cityError ?? errors.text("home_city"))} onChange={(event) => setHomeCity(event.target.value)} />
      </Field>
      <div className="flex flex-col gap-sp-2" data-testid="setup-city-suggestions">
        <p className="font-mono text-data-sm font-semibold tracking-wider text-ink-2 uppercase">{t("suggestions")}</p>
        {suggestions.length === 0 ? (
          <p className="text-body-sm text-ink-2">{t("noSuggestions")}</p>
        ) : (
          <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto p-0.5">
            {suggestions.map((city) => (
              <li key={city}>
                <Button type="button" size="xs" variant="default" aria-label={t("addCity", { city })} onClick={() => setHomeCity(city)}>
                  <Plus aria-hidden />
                  {city}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Field id={ids.places} label={tProfile("places.label")} hint={tProfile("places.hint")} error={placesError} errorText={errors.text("places")}>
        <PlacesField
          id={ids.places}
          value={draft.places}
          onChange={(places) => setDraft({ ...draft, places })}
          geo={market.placeGeo}
          options={market.scopeOptions}
          known={draft.market.pack === market.packId && market.error === null}
          search={{ homeCity: draft.home_city, workplace: view.workplace, home: { country: market.country, countryName: market.countryName } }}
          invalid={errors.has("places")}
          describedBy={describedBy(ids.places, true, placesError ?? errors.text("places"))}
        />
      </Field>

      <div className="grid gap-sp-4 sm:grid-cols-2">
        <Field id={ids.zone} label={t("timezone")} hint={t("timezoneHint")} errorText={errors.text("timezone")}>
          <Select id={ids.zone} value={zone} aria-invalid={errors.has("timezone") || undefined} aria-describedby={describedBy(ids.zone, true, errors.text("timezone"))} onChange={(event) => setZoneChoice(event.target.value)} data-testid="setup-timezone">
            {zoneOptions.length === 0 ? <option value={zone}>{zone}</option> : null}
            {zoneOptions.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
          {browserZone !== null && browserZone !== zone ? (
            <p className="flex flex-wrap items-center gap-sp-2 text-body-sm text-ink-2">
              {t("browserZone", { zone: browserZone })}
              <Button type="button" variant="link" size="sm" onClick={() => setZoneChoice(browserZone)}>
                {t("useBrowserZone")}
              </Button>
            </p>
          ) : null}
        </Field>
      </div>
    </StepFrame>
  );
}
