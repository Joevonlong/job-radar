import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { RemoteScopeField } from "@/components/profile/remote-scope-field";
import { draftHomeRegion } from "@/components/profile/market-fields";
import type { MarketView } from "@/lib/market/view";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const EU = { id: "eu", name: "European Union" };

function field(props: { value?: string; countryName?: string; homeRegion?: { id: string; name: string } | null; namespace?: "profile" | "settings"; describedBy?: string }, locale: "en" | "zh" = "en") {
  return render(
    wrap(
      <RemoteScopeField
        id="scope"
        value={props.value ?? "home_country"}
        onChange={vi.fn()}
        options={[]}
        countryName={props.countryName ?? (locale === "zh" ? "德国" : "Germany")}
        homeRegion={props.homeRegion === undefined ? EU : props.homeRegion}
        invalid={false}
        describedBy={props.describedBy}
        namespace={props.namespace ?? "profile"}
      />,
      locale,
    ),
  );
}

describe("RemoteScopeField: what the home-country choice says", () => {
  it("names the country and the region the rule reads (en)", () => {
    field({});
    expect(screen.getByRole("option", { name: "Remote from Germany (incl. EU / Europe / EMEA / worldwide remote)" })).toBeInTheDocument();
  });

  it("names the country and the region the rule reads (zh)", () => {
    field({}, "zh");
    expect(screen.getByRole("option", { name: "能从德国远程（含面向欧盟 / 欧洲 / EMEA / 全球的远程岗）" })).toBeInTheDocument();
  });

  it("writes no region part for a market without a home region", () => {
    field({ homeRegion: null });
    const option = screen.getByRole("option", { name: "Remote from Germany" });
    expect(option).toBeInTheDocument();
    expect(option.textContent).not.toMatch(/EU|Europe|EMEA/);
    expect(screen.getByTestId("remote-scope-hint").textContent).not.toMatch(/EU|Europe|EMEA/);
  });

  it("uses the region's own name for a region without a short wording", () => {
    field({ homeRegion: { id: "nordics", name: "Nordics" } });
    expect(screen.getByRole("option", { name: "Remote from Germany (incl. Nordics / worldwide remote)" })).toBeInTheDocument();
  });

  it("uses the same wording on the settings page", () => {
    field({ namespace: "settings" });
    expect(screen.getByRole("option", { name: "Remote from Germany (incl. EU / Europe / EMEA / worldwide remote)" })).toBeInTheDocument();
  });
});

describe("RemoteScopeField: the line under the select", () => {
  it("explains what is kept and excluded for the chosen kind, and is linked to the select", () => {
    field({ describedBy: "other-hint" });
    const hint = screen.getByTestId("remote-scope-hint");
    expect(hint).toHaveTextContent(/^Kept: located in Germany, or open to EU \/ Europe \/ EMEA or worldwide/);
    expect(hint).toHaveTextContent("Remote - Spain");
    const describedBy = screen.getByTestId("remote-scope-kind").getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ")).toEqual(["other-hint", hint.id]);
  });

  it("is linked even when the caller passes no description", () => {
    field({});
    expect(screen.getByTestId("remote-scope-kind").getAttribute("aria-describedby")).toBe(screen.getByTestId("remote-scope-hint").id);
  });

  it("changes with the chosen kind", async () => {
    const user = userEvent.setup();
    const { rerender } = field({ value: "none" });
    expect(screen.getByTestId("remote-scope-hint")).toHaveTextContent("Remote jobs are excluded, unless the posting is located in one of your cities.");
    rerender(wrap(<RemoteScopeField id="scope" value="worldwide" onChange={vi.fn()} options={[]} countryName="Germany" homeRegion={EU} invalid={false} describedBy={undefined} namespace="profile" />));
    expect(screen.getByTestId("remote-scope-hint")).toHaveTextContent("Every remote job is kept");
    rerender(wrap(<RemoteScopeField id="scope" value="region:eu" onChange={vi.fn()} options={[]} countryName="Germany" homeRegion={EU} invalid={false} describedBy={undefined} namespace="profile" />));
    expect(screen.getByTestId("remote-scope-hint")).toHaveTextContent("Kept: located in a selected region or country");
    await user.tab(); // the field keeps working
  });

  it("is in Chinese too", () => {
    field({}, "zh");
    expect(screen.getByTestId("remote-scope-hint")).toHaveTextContent(/^保留：地点在德国、写明面向欧盟 \/ 欧洲 \/ EMEA或全球的远程岗/);
  });
});

describe("draftHomeRegion", () => {
  const market = {
    country: "DE",
    homeRegion: EU,
    packs: [
      { id: "de", name: "Germany", country: "DE", currency: "EUR", language: "de", region: "eu", languageRules: true },
      { id: "fr", name: "France", country: "FR", currency: "EUR", language: "fr", region: null, languageRules: false },
      { id: "generic", name: "Generic", country: null, currency: null, language: null, region: null, languageRules: false },
    ],
    regionChoices: [
      { id: "eu", name: "European Union", countries: ["DE", "AT", "FR"] },
      { id: "dach", name: "DACH", countries: ["DE", "AT", "CH"] },
    ],
  } as unknown as MarketView;
  const draft = (pack: string, country = "") => ({ pack, country, currency: "", home_language: "" });

  it("uses the pack's region while the draft keeps the pack's country", () => {
    expect(draftHomeRegion(market, draft("de"))).toEqual(EU);
    expect(draftHomeRegion(market, draft("de", "DE"))).toEqual(EU);
  });

  it("follows the draft's country: DE to AT is still the EU, a country outside every region has none", () => {
    expect(draftHomeRegion(market, draft("de", "AT"))).toEqual(EU);
    expect(draftHomeRegion(market, draft("de", "CH"))).toEqual({ id: "dach", name: "DACH" });
    expect(draftHomeRegion(market, draft("de", "US"))).toBeNull();
  });

  it("follows the draft's pack: another pack's country, or the generic pack with a chosen country", () => {
    expect(draftHomeRegion(market, draft("fr"))).toEqual(EU);
    expect(draftHomeRegion(market, draft("generic", "AT"))).toEqual(EU);
    expect(draftHomeRegion(market, draft("generic", "US"))).toBeNull();
  });

  it("has no region without any country", () => {
    expect(draftHomeRegion(market, draft("generic"))).toBeNull();
    expect(draftHomeRegion(market, draft("missing"))).toBeNull();
  });
});

describe("RemoteScopeField without a country name", () => {
  it("stands in 'your home country' and names no region when there is none", () => {
    field({ countryName: "", homeRegion: null });
    const option = screen.getByRole("option", { name: "Remote from your home country" });
    expect(option.textContent).not.toMatch(/region|EU|Europe/i);
    expect(screen.getByTestId("remote-scope-hint").textContent).not.toMatch(/EU \/ Europe/);
  });

  it("names the region when there is one", () => {
    field({ countryName: "" });
    expect(screen.getByRole("option", { name: "Remote from your home country (incl. EU / Europe / EMEA / worldwide remote)" })).toBeInTheDocument();
  });
});
