/** The market block of "What I want" (/me). */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { draftCountryName, languageStepOn, MarketFields } from "@/components/profile/market-fields";
import type { MarketView, PackOption } from "@/lib/market/view";
import type { MarketDraft } from "@/lib/profile/draft";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const action = vi.hoisted(() => ({ enableMarketChannelsAction: vi.fn(async () => ({ status: "done", outcome: "enabled" })) }));
vi.mock("@/app/me/actions", () => action);

const LOCAL: PackOption = { id: "xx", name: "Example", country: "DE", currency: "EUR", language: "de", region: "eu", languageRules: true };
const GENERIC: PackOption = { id: "generic", name: "Generic", country: null, currency: null, language: null, region: null, languageRules: false };

function view(over: Partial<MarketView> = {}): MarketView {
  return {
    error: null,
    packId: "xx",
    packName: "Example",
    packs: [GENERIC, LOCAL],
    countryOptions: [
      { value: "DE", label: "Germany" },
      { value: "US", label: "United States" },
    ],
    currencyOptions: [
      { value: "EUR", label: "EUR · Euro" },
      { value: "USD", label: "USD · US Dollar" },
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
    homeRegion: null,
    regionChoices: [],
    ...over,
  };
}

const SAVED: MarketDraft = { pack: "xx", country: "", currency: "", home_language: "" };

function Harness({ market, onChange }: { market: MarketView; onChange?: (next: MarketDraft) => void }) {
  const [value, setValue] = useState(SAVED);
  return (
    <MarketFields
      baseId="m"
      value={value}
      saved={SAVED}
      market={market}
      errors={new Map()}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

describe("draftCountryName", () => {
  it("follows the draft, not the saved market", () => {
    const market = view({ country: "US", countryName: "United States" });
    expect(draftCountryName(market, { pack: "xx", country: "", currency: "", home_language: "" })).toBe("Germany");
    expect(draftCountryName(market, { pack: "xx", country: "US", currency: "", home_language: "" })).toBe("United States");
    expect(draftCountryName(market, { pack: "generic", country: "", currency: "", home_language: "" })).toBe("");
    expect(draftCountryName(market, { pack: "generic", country: "DE", currency: "", home_language: "" })).toBe("Germany");
  });
});

describe("languageStepOn", () => {
  it("is on only for a pack with rules whose language the user keeps", () => {
    expect(languageStepOn(LOCAL, "")).toBe(true);
    expect(languageStepOn(LOCAL, "DE")).toBe(true);
    expect(languageStepOn(LOCAL, "fr")).toBe(false);
    expect(languageStepOn(GENERIC, "en")).toBe(false);
    expect(languageStepOn(undefined, "")).toBe(false);
  });
});

describe("MarketFields", () => {
  it("shows the pack defaults and the step, and after a pack change resets the values and asks for a reprocess", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(wrap(<Harness market={view()} onChange={onChange} />));
    expect(screen.getByTestId("market-country")).toHaveDisplayValue("Pack default (Germany)");
    expect(screen.getByTestId("market-currency")).toHaveDisplayValue("Pack default (EUR)");
    expect(screen.getByTestId("market-language-step")).toHaveAttribute("data-on", "true");
    expect(screen.getByTestId("market-language-step")).toHaveTextContent("German");
    expect(screen.queryByTestId("market-reprocess-note")).toBeNull();

    await user.selectOptions(screen.getByTestId("market-pack"), "generic");
    expect(onChange).toHaveBeenLastCalledWith({ pack: "generic", country: "", currency: "", home_language: "" });
    expect(screen.getByTestId("market-country")).toHaveDisplayValue("Choose one");
    expect(screen.getByTestId("market-language-step")).toHaveAttribute("data-on", "false");
    expect(screen.getByTestId("market-reprocess-note")).toHaveTextContent("pnpm reprocess");

    await user.selectOptions(screen.getByTestId("market-country"), "US");
    await user.type(screen.getByTestId("market-language"), "en");
    expect(onChange).toHaveBeenLastCalledWith({ pack: "generic", country: "US", currency: "", home_language: "en" });
    expect(screen.getByTestId("market-language-step")).toHaveTextContent("English");
  });

  it("warns when the chosen currency has no exchange rate", async () => {
    const user = userEvent.setup();
    render(wrap(<Harness market={view({ currencyOptions: [{ value: "EUR", label: "EUR" }, { value: "INR", label: "INR" }] })} />));
    expect(screen.queryByTestId("market-currency-no-rate")).toBeNull();
    await user.selectOptions(screen.getByTestId("market-currency"), "INR");
    expect(screen.getByTestId("market-currency-no-rate")).toHaveTextContent("INR");
  });

  it("offers to switch on the market's own job boards that are off", async () => {
    const user = userEvent.setup();
    render(wrap(<Harness market={view({ localChannels: [{ id: "board-a", enabled: true }, { id: "board-b", enabled: false }] })} />, "zh"));
    expect(screen.getByTestId("market-local-channels")).toHaveTextContent("board-b");
    expect(screen.getByTestId("market-local-channels")).not.toHaveTextContent("board-a");
    await user.click(screen.getByRole("button", { name: "开启它们" }));
    expect(action.enableMarketChannelsAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent("已开启");
  });
});
