// @vitest-environment node
import { describe, expect, it } from "vitest";
import { locationOf, searchUrl } from "@/lib/channels/linkedin/session/contract";
import { marketForChannel } from "@/lib/channels/market";
import type { ChannelContext } from "@/lib/channels/types";
import { shippedChannels } from "../../helpers";
import { berlinQuery, harness, setup } from "./helpers";

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

describe("employer check before a posting page is opened", () => {
  const company = berlinQuery({ company: { name: "Kornblum Analytics", key: "kornblum-analytics" }, location: null, remote: false, remoteScope: null, keywords: ["Kornblum Analytics"] });
  const postingLoads = (loads: ReadonlyArray<{ url: string }>): string[] => loads.map((load) => load.url).filter((url) => url.includes("/jobs/view/"));

  it("opens the pages of the matching employer and of cards that name none; the others cost no page", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    const ctx: ChannelContext = { ...h.ctx, employerMatches: (name) => name === null || name === undefined || name === "Kornblum Analytics AG" };
    const postings = await s.session.collect(company, ctx);
    const opened = postingLoads(s.browser.log.loads).map((url) => /\/jobs\/view\/(\d+)/.exec(url)?.[1]);
    expect(opened).toEqual(["4385000102", "4385000106"]);
    // the other employers stay card data, which the cycle's check drops
    expect(postings.map((p) => p.externalId)).toEqual(expect.arrayContaining(["4385000101", "4385000102", "4385000103", "4385000104"]));
    expect(h.logs.find((l) => l.message === "linkedin session read finished")?.fields).toMatchObject({ otherEmployer: 3 });
  });

  it("counts only the opened pages against the daily limit", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    await s.session.collect(company, { ...h.ctx, employerMatches: () => false });
    expect(postingLoads(s.browser.log.loads)).toEqual([]);
    expect(s.store.requests.get("2026-10-07")).toBe(s.browser.log.loads.length);
  });

  it("keyword queries open every page, as before", async () => {
    const s = setup();
    const h = await harness(s.session, s.config);
    await s.session.collect(berlinQuery(), h.ctx);
    expect(postingLoads(s.browser.log.loads).length).toBeGreaterThan(2);
  });
});
