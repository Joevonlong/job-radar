import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/me/actions", () => ({ enableMarketChannelsAction: vi.fn(), saveProfileAction: vi.fn() }));
vi.mock("@/app/setup/actions", () => ({ saveSetupStepAction: vi.fn(), skipSetupStepAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));

import { PreferencesForm } from "@/components/profile/preferences-form";
import { StepMarket } from "@/components/setup/step-market";
import { configRegistry } from "@/lib/config";
import type { MarketView } from "@/lib/market/view";
import { preferencesConfigToDraft } from "@/lib/profile/draft";

import en from "../../messages/en.json";
import { shippedYaml } from "../config/helpers";

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
);

const EU_TEXT = "(incl. EU / Europe / EMEA / worldwide remote)";

const market: MarketView = {
  error: null,
  packId: "de",
  packName: "Germany",
  packs: [
    { id: "de", name: "Germany", country: "DE", currency: "EUR", language: "de", region: "eu", languageRules: true },
    { id: "generic", name: "Generic", country: null, currency: null, language: null, region: null, languageRules: false },
  ],
  countryOptions: [
    { value: "AT", label: "Austria" },
    { value: "DE", label: "Germany" },
    { value: "US", label: "United States" },
  ],
  currencyOptions: [
    { value: "EUR", label: "EUR" },
    { value: "USD", label: "USD" },
  ],
  rateCurrencies: ["EUR", "USD"],
  localChannels: [],
  country: "DE",
  countryName: "Germany",
  currency: "EUR",
  currencySymbol: "€",
  homeLanguage: "de",
  languageName: "German",
  languageStep: true,
  scopeOptions: [],
  homeRegion: { id: "eu", name: "European Union" },
  regionChoices: [{ id: "eu", name: "European Union", countries: ["DE", "AT"] }],
};

const homeCountryOption = () => screen.getByTestId("remote-scope-kind").querySelector("option[value=home_country]")?.textContent;

describe("/me: the remote scope follows the draft market", () => {
  const initial = preferencesConfigToDraft(configRegistry.preferences.schema.parse(shippedYaml("profile.example/preferences.yaml")));
  const form = () =>
    render(
      wrap(
        <PreferencesForm
          initial={initial}
          hash="h"
          state={{ status: "idle" }}
          pending={false}
          onSave={() => {}}
          salaries={[]}
          axis={{ minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" }}
          salaryMedian={{ value: null, count: 0, minSample: 10 }}
          market={market}
          searchLocations={[]}
          userLanguageLevel={null}
          needsVisaSponsorship={null}
        />,
      ),
    );

  it("keeps the EU when the country changes from Germany to Austria, and drops it for a country outside every region", async () => {
    const user = userEvent.setup();
    form();
    expect(homeCountryOption()).toBe(`Remote from Germany ${EU_TEXT}`);
    await user.selectOptions(screen.getByTestId("market-country"), "AT");
    expect(homeCountryOption()).toBe(`Remote from Austria ${EU_TEXT}`);
    await user.selectOptions(screen.getByTestId("market-country"), "US");
    expect(homeCountryOption()).toBe("Remote from United States");
  });

  it("follows the pack: the generic pack with Austria still sits in the EU", async () => {
    const user = userEvent.setup();
    form();
    await user.selectOptions(screen.getByTestId("market-pack"), "generic");
    await user.selectOptions(screen.getByTestId("market-country"), "AT");
    expect(homeCountryOption()).toBe(`Remote from Austria ${EU_TEXT}`);
  });
});

describe("setup wizard: the remote scope follows the country switch", () => {
  const view = {
    draft: { market: { pack: "de", country: "", currency: "", home_language: "" }, locations: ["Berlin"], remote_scope: "home_country", timezone: "Europe/Berlin" },
    saved: { pack: "de", country: "", currency: "", home_language: "" },
    cities: { DE: ["Berlin"] },
    countryDefaults: { DE: { currency: "EUR", city: "Berlin" }, AT: { currency: "EUR", city: null }, US: { currency: "USD", city: null } },
  };

  it("keeps the EU for Austria and drops it for the United States", async () => {
    const user = userEvent.setup();
    render(wrap(<StepMarket view={view} done={false} market={market} />));
    expect(homeCountryOption()).toBe(`Remote from Germany ${EU_TEXT}`);
    await user.selectOptions(screen.getByTestId("market-country"), "AT");
    expect(homeCountryOption()).toBe(`Remote from Austria ${EU_TEXT}`);
    await user.selectOptions(screen.getByTestId("market-country"), "US");
    expect(homeCountryOption()).toBe("Remote from United States");
  });
});
