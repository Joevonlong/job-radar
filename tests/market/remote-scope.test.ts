// @vitest-environment node
/** The four forms of the remote scope and their equivalence with the values before market packs. */
import { describe, expect, it } from "vitest";

import { remoteScope } from "@/lib/config/schemas/common";
import type { RemoteScopeValue } from "@/lib/market/schema";
import { migrateRemoteScope, parseRemoteScopeKey, remoteLocationFor, remoteScopeKey, scopeCountries } from "@/lib/market/remote-scope";

import { filterWith, job, loc, prefs } from "../filter/helpers";
import { fixtureMarket, shippedPipeline } from "../pipeline/helpers";

const de = fixtureMarket();
const us = fixtureMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" });

describe("values", () => {
  it("accepts none, home_country, worldwide and a list of regions / countries", () => {
    for (const value of ["none", "home_country", "worldwide", { region: ["eu"] }, { region: ["dach", "NL"] }]) expect(remoteScope.safeParse(value).success).toBe(true);
    for (const value of ["eu_any", { region: [] }, { region: ["Europe"] }, { region: ["eu", "eu"] }, "anywhere"]) expect(remoteScope.safeParse(value).success).toBe(false);
  });

  it("round-trips through its key (query ids, form values)", () => {
    for (const value of ["none", "home_country", "worldwide", { region: ["eu", "CH"] }] satisfies RemoteScopeValue[]) expect(parseRemoteScopeKey(remoteScopeKey(value))).toEqual(value);
    expect(parseRemoteScopeKey("region:")).toBeNull();
    expect(parseRemoteScopeKey("mars")).toBeNull();
  });

  it("maps the old values: eu_hire_in_de -> home_country, eu_any -> {region: [eu]}", () => {
    expect(migrateRemoteScope("eu_hire_in_de")).toBe("home_country");
    expect(migrateRemoteScope("eu_any")).toEqual({ region: ["eu"] });
    expect(migrateRemoteScope("worldwide")).toBe("worldwide");
  });
});

describe("countries", () => {
  it("home_country is the market's country, a region its countries, an ISO code itself, worldwide all", () => {
    expect([...(scopeCountries("home_country", de) ?? [])]).toEqual(["DE"]);
    expect([...(scopeCountries("home_country", us) ?? [])]).toEqual(["US"]);
    expect(scopeCountries({ region: ["eu"] }, de)?.has("FR")).toBe(true);
    expect(scopeCountries({ region: ["dach", "NL"] }, de)).toEqual(new Set(["DE", "AT", "CH", "NL"]));
    expect(scopeCountries("worldwide", de)).toBeNull();
    expect(scopeCountries("none", de)?.size).toBe(0);
  });
});

describe("the hard filter under each form", () => {
  it("home_country (DE) and {region: [eu]} behave like eu_hire_in_de and eu_any", async () => {
    const { evaluateJob } = await import("@/lib/filter");
    const remote = (label: string, country: string | null) => job({ workplace: "remote", locations: [loc(label, null, country)] });
    const home = filterWith(prefs((raw) => void (raw.places = [])));
    const eu = filterWith(prefs((raw) => void (raw.places = [{ place: "eu", relocate: false }])));
    expect(evaluateJob(remote("Remote, France", "FR"), home).result).toBe("filtered_out");
    expect(evaluateJob(remote("Remote, France", "FR"), eu).result).toBe("passed");
    expect(evaluateJob(remote("Remote - EU", null), home).result).toBe("passed");
    expect(evaluateJob(remote("Remote - United Kingdom", "GB"), eu).result).toBe("filtered_out");
  });

  it("a list with the home country and another (DE, CH) keeps the home region's wide labels", async () => {
    const { evaluateJob } = await import("@/lib/filter");
    const homeAndSwiss = filterWith(prefs((raw) => void (raw.places = [{ place: "DE", relocate: false }, { place: "CH", relocate: false }])));
    const verdict = evaluateJob(job({ workplace: "remote", locations: [loc("Remote - EU", null, null)] }), homeAndSwiss);
    expect(verdict.result).toBe("passed");
    expect(verdict.reasons.filter((reason) => reason !== "remote_area_unknown")).toEqual([]);
  });

  it("a list with the home country and another (DE, CH) does not hide a title naming the home region next to another", async () => {
    const { evaluateJob } = await import("@/lib/filter");
    const homeAndSwiss = filterWith(prefs((raw) => void (raw.places = [{ place: "DE", relocate: false }, { place: "CH", relocate: false }])));
    const verdict = evaluateJob(job({ title: "Engineer - EU/US", workplace: "remote", locations: [loc("Remote", null, null)] }), homeAndSwiss);
    expect(verdict.reasons.filter((reason) => reason.startsWith("remote_out_of_scope"))).toEqual([]);
  });

  it("in the US market home_country takes US remote jobs and not German ones", async () => {
    const { evaluateJob } = await import("@/lib/filter");
    const usPipeline = shippedPipeline(us);
    const home = filterWith(prefs((raw) => void (raw.places = [])), usPipeline);
    const remote = (label: string, country: string | null) => job({ workplace: "remote", locations: [loc(label, null, country)] });
    expect(evaluateJob(remote("Remote - USA", "US"), home).result).toBe("passed");
    expect(evaluateJob(remote("Remote, Germany", "DE"), home).result).toBe("filtered_out");
  });
});

describe("the location a channel searches remote queries with", () => {
  it("uses the channel's text, else the market's names", () => {
    expect(remoteLocationFor("home_country", { home_country: "Deutschland" }, de)).toBe("Deutschland");
    expect(remoteLocationFor("home_country", {}, de)).toBe("Germany");
    expect(remoteLocationFor("home_country", {}, us)).toBe("United States");
    expect(remoteLocationFor({ region: ["eu"] }, undefined, de)).toBe("European Union");
    expect(remoteLocationFor({ region: ["dach", "NL"] }, undefined, de)).toBe("DACH, Netherlands");
    expect(remoteLocationFor("worldwide", {}, de)).toBe("Worldwide");
    expect(remoteLocationFor("worldwide", { worldwide: "" }, de, { worldwideText: "", emptyMeansNoLocation: true })).toBe("");
  });
});
