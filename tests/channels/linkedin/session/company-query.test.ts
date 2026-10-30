// @vitest-environment node
import { expect, it } from "vitest";
import { locationOf, searchUrl } from "@/lib/channels/linkedin/session/contract";
import { marketForChannel } from "@/lib/channels/market";
import { shippedChannels } from "../../helpers";
import { berlinQuery } from "./helpers";

it("company queries use the home country without remote parameters or a city", () => {
  const settings = shippedChannels().linkedin.session;
  const market = marketForChannel();
  const query = berlinQuery({ company: { name: "Acme", key: "acme" }, location: null, remote: false, remoteScope: null, keywords: ["Acme"] });
  expect(locationOf(query, settings, market)).toBe(settings.site.country_name || market.countryName);
  const url = new URL(searchUrl(query, settings, "Acme", 0, market));
  expect(url.searchParams.get("location")).toBe(settings.site.country_name || market.countryName);
  expect(url.searchParams.has("f_WT")).toBe(false);
  expect(url.searchParams.has("distance")).toBe(false);
  expect(url.searchParams.get("keywords")).toBe("Acme");
});
