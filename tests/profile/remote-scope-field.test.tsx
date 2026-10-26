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

  it("falls back to the plain wording while the pack names no country", () => {
    field({ countryName: "" });
    expect(screen.getByRole("option", { name: /^Remote from the market's country/ })).toBeInTheDocument();
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
      { id: "de", name: "Germany", country: "DE", currency: "EUR", language: "de", languageRules: true },
      { id: "fr", name: "France", country: "FR", currency: "EUR", language: "fr", languageRules: false },
    ],
  } as unknown as MarketView;

  it("keeps the saved region while the draft keeps the home country", () => {
    expect(draftHomeRegion(market, { pack: "de", country: "", currency: "", home_language: "" })).toEqual(EU);
    expect(draftHomeRegion(market, { pack: "de", country: "DE", currency: "", home_language: "" })).toEqual(EU);
  });

  it("names no region for another country or when no country is known", () => {
    expect(draftHomeRegion(market, { pack: "de", country: "AT", currency: "", home_language: "" })).toBeNull();
    expect(draftHomeRegion(market, { pack: "fr", country: "", currency: "", home_language: "" })).toBeNull();
    expect(draftHomeRegion(market, { pack: "none", country: "", currency: "", home_language: "" })).toBeNull();
  });
});
