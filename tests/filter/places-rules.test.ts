// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evaluateJob, type FilterJob } from "@/lib/filter";
import type { PipelineConfig } from "@/lib/config";

import { filterWith, job, loc, prefs } from "./helpers";
import { fixtureMarket, shippedPipeline } from "../pipeline/helpers";

const market = fixtureMarket({ pack: "generic", country: "DE", currency: "EUR", home_language: "de" });
const shipped = shippedPipeline(market);
const pipeline: PipelineConfig = {
  ...shipped,
  filter: { ...shipped.filter, city_aliases: {} },
  market: { ...shipped.market, cities: { berlin: ["Berlin", "DE"], amsterdam: ["Amsterdam", "NL"], utrecht: ["Utrecht", "NL"], paris: ["Paris", "FR"] } },
};
const moving = (place: string) => ({ place, relocate: true });
const remoteOnly = (place: string) => ({ place, relocate: false });

function reasons(home: string, places: { place: string; relocate: boolean }[], over: Partial<FilterJob>): string[] {
  const filter = filterWith(prefs((raw) => {
    raw.home_city = home;
    raw.places = places;
    raw.workplace = ["onsite", "hybrid", "remote"];
  }), pipeline);
  return evaluateJob(job(over), filter).reasons.filter((reason) => /^(location_not_allowed|remote_out_of_scope)/.test(reason));
}
const onsite = (label: string, city: string | null, country: string | null): Partial<FilterJob> => ({ workplace: "hybrid", locations: [loc(label, city, country)] });
const remote = (label: string, city: string | null, country: string | null): Partial<FilterJob> => ({ workplace: "remote", locations: [loc(label, city, country)] });
const notAllowed = [expect.stringMatching(/^location_not_allowed/)];
const outOfScope = [expect.stringMatching(/^remote_out_of_scope/)];

describe("on-site and hybrid jobs", () => {
  it("count in a city to move to, in its country only", () => {
    expect(reasons("Berlin", [moving("Amsterdam")], onsite("Amsterdam, Netherlands", "Amsterdam", "NL"))).toEqual([]);
    expect(reasons("Berlin", [moving("Amsterdam")], onsite("Amsterdam, United States", "Amsterdam", "US"))).toEqual(notAllowed);
    expect(reasons("Berlin", [moving("Amsterdam")], onsite("Paris, France", "Paris", "FR"))).toEqual(notAllowed);
  });

  it("count anywhere in a country to move to", () => {
    expect(reasons("Berlin", [moving("NL")], onsite("Utrecht, Netherlands", "Utrecht", "NL"))).toEqual([]);
  });

  it("do not count in a remote-only place", () => {
    expect(reasons("Berlin", [remoteOnly("Amsterdam")], onsite("Amsterdam, Netherlands", "Amsterdam", "NL"))).toEqual(notAllowed);
    expect(reasons("Berlin", [remoteOnly("NL")], onsite("Utrecht, Netherlands", "Utrecht", "NL"))).toEqual(notAllowed);
    expect(reasons("Berlin", [remoteOnly("eu")], onsite("Paris, France", "Paris", "FR"))).toEqual(notAllowed);
  });

  it("keep the home city to the home country", () => {
    expect(reasons("Berlin", [], onsite("Berlin, United States", "Berlin", "US"))).toEqual(notAllowed);
    expect(reasons("Berlin", [], onsite("Berlin", "Berlin", null))).toEqual([]);
  });

  it("without a home city, count where the location states the home country", () => {
    expect(reasons("", [], onsite("Stuttgart, Germany", "Stuttgart", "DE"))).toEqual([]);
    expect(reasons("", [], onsite("San Francisco", "San Francisco", null))).toEqual(notAllowed);
    expect(reasons("", [], onsite("Paris, France", "Paris", "FR"))).toEqual(notAllowed);
  });

  it("match a name the tables do not know as written, in any country", () => {
    expect(reasons("Berlin", [moving("Smalltown")], onsite("Smalltown, France", "Smalltown", "FR"))).toEqual([]);
    expect(reasons("Berlin", [moving("Smalltown")], onsite("Smalltown", "Smalltown", null))).toEqual([]);
    expect(reasons("Berlin", [moving("Smalltown")], onsite("Bigtown, France", "Bigtown", "FR"))).toEqual(notAllowed);
  });
});

describe("remote jobs, check 1", () => {
  it("pass on home", () => {
    expect(reasons("Berlin", [], remote("Germany", null, "DE"))).toEqual([]);
    expect(reasons("Berlin", [], remote("France", null, "FR"))).toEqual(outOfScope);
  });

  it("pass on a listed country, moving or not", () => {
    expect(reasons("Berlin", [remoteOnly("NL")], remote("Netherlands", null, "NL"))).toEqual([]);
    expect(reasons("Berlin", [moving("NL")], remote("Netherlands", null, "NL"))).toEqual([]);
    expect(reasons("Berlin", [remoteOnly("NL")], remote("France", null, "FR"))).toEqual(outOfScope);
  });

  it("pass on a listed city, moving or not", () => {
    expect(reasons("Berlin", [remoteOnly("Amsterdam")], remote("Amsterdam, Netherlands", "Amsterdam", "NL"))).toEqual([]);
    expect(reasons("Berlin", [moving("Amsterdam")], remote("Amsterdam, Netherlands", "Amsterdam", "NL"))).toEqual([]);
    expect(reasons("Berlin", [remoteOnly("Amsterdam")], remote("Utrecht, Netherlands", "Utrecht", "NL"))).toEqual(outOfScope);
  });

  it("pass on a listed name the tables do not know, in any country", () => {
    expect(reasons("Berlin", [remoteOnly("Smalltown")], remote("Smalltown, France", "Smalltown", "FR"))).toEqual([]);
  });

  it("pass on a wide label that covers home", () => {
    expect(reasons("Berlin", [], remote("EU", null, null))).toEqual([]);
    expect(reasons("Berlin", [], remote("Worldwide", null, null))).toEqual([]);
  });

  it("pass everywhere with Worldwide listed", () => {
    expect(reasons("Berlin", [remoteOnly("Worldwide")], remote("Paris, France", "Paris", "FR"))).toEqual([]);
  });

  it("with a region listed and home not, still show home jobs", () => {
    expect(reasons("Berlin", [remoteOnly("CH")], remote("Germany", null, "DE"))).toEqual([]);
    expect(reasons("Berlin", [remoteOnly("eu")], remote("France", null, "FR"))).toEqual([]);
  });
});
