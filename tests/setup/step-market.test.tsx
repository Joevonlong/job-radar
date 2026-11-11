/** The wizard's market step: what a country switch does to the currency and the cities, and what the user's own edits keep. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StepMarket } from "@/components/setup/step-market";
import type { MarketView } from "@/lib/market/view";
import type { SetupView } from "@/lib/setup/view";

import en from "../../messages/en.json";
import { candidate, geoname, stubPlaceSearch } from "../profile/place-search-stub";

vi.mock("@/app/setup/actions", () => ({ saveSetupStepAction: vi.fn(), skipSetupStepAction: vi.fn() }));
vi.mock("@/app/me/actions", () => ({ enableMarketChannelsAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));

const market: MarketView = {
  error: null,
  packId: "generic",
  packName: "Generic",
  packs: [{ id: "generic", name: "Generic", country: null, currency: null, language: null, region: null, languageRules: false }],
  countryOptions: [
    { value: "DE", label: "Germany" },
    { value: "US", label: "United States" },
    { value: "ZZ", label: "Nowhere" },
  ],
  currencyOptions: [
    { value: "CHF", label: "CHF" },
    { value: "EUR", label: "EUR" },
    { value: "USD", label: "USD" },
  ],
  rateCurrencies: ["CHF", "EUR", "USD"],
  localChannels: [],
  country: "US",
  countryName: "United States",
  currency: "USD",
  currencySymbol: "$",
  homeLanguage: "en",
  languageName: "English",
  languageStep: false,
  placeGeo: { cityAliases: {}, cities: {}, countries: [], regions: {} },
  placeRecords: [],
  scopeOptions: [],
  homeRegion: null,
  regionChoices: [],
};

/** A country table in which ZZ has no entry at all, US has a currency but no city, DE has both. */
function view(): SetupView["market"] {
  return {
    workplace: ["onsite", "remote"],
    draft: { market: { pack: "generic", country: "US", currency: "USD", home_language: "en" }, home_city: "New York", places: [], timezone: "America/New_York" },
    saved: { pack: "generic", country: "US", currency: "USD", home_language: "en" },
    cities: { DE: ["Berlin", "München"] },
    countryDefaults: { DE: { currency: "EUR", city: "Berlin" }, US: { currency: "USD", city: null } },
  };
}

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
);

const renderStep = (done = false) => render(wrap(<StepMarket view={view()} done={done} market={market} />));
/** The chosen home city as shown ("" when none is chosen). */
const homeCity = () => screen.queryByTestId("setup-home-city-value")?.textContent ?? "";
const country = () => screen.getByTestId("market-country");
const currency = () => screen.getByTestId("market-currency");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StepMarket country switch", () => {
  it("replaces the cities with the country's main city and brings its currency", async () => {
    const user = userEvent.setup();
    renderStep();
    expect(homeCity()).toBe("New York");
    await user.selectOptions(country(), "DE");
    expect(homeCity()).toBe("Berlin");
    expect(currency()).toHaveValue("EUR");
  });

  it("keeps the cities the user edited by hand through a later country switch", async () => {
    const user = userEvent.setup();
    renderStep();
    stubPlaceSearch([candidate(geoname(4930956, "city", "Boston", "US", "United States", "Massachusetts"))]);
    await user.type(screen.getByTestId("setup-home-city"), "Bos");
    await screen.findAllByRole("option");
    await user.keyboard("{Enter}");
    expect(homeCity()).toBe("BostonMassachusetts, United States");
    await user.selectOptions(country(), "DE");
    expect(homeCity()).toBe("BostonMassachusetts, United States");
    expect(currency()).toHaveValue("EUR");
  });

  it("keeps a currency picked by hand through a country switch", async () => {
    const user = userEvent.setup();
    renderStep();
    await user.selectOptions(currency(), "CHF");
    await user.selectOptions(country(), "DE");
    expect(currency()).toHaveValue("CHF");
    expect(homeCity()).toBe("Berlin");
  });

  it("falls back to no currency and no city for a country the tables do not know", async () => {
    const user = userEvent.setup();
    renderStep();
    await user.selectOptions(country(), "ZZ");
    expect(currency()).toHaveValue("");
    expect(homeCity()).toBe("");
  });

  it("treats a saved step as the user's own choice: a country switch changes neither currency nor cities", async () => {
    const user = userEvent.setup();
    renderStep(true);
    await user.selectOptions(country(), "DE");
    expect(currency()).toHaveValue("USD");
    expect(homeCity()).toBe("New York");
  });
});
