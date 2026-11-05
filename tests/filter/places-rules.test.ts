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
  filter: { ...shipped.filter, city_aliases: {}, remote: { ...shipped.filter.remote, title_outside_patterns: ["[-–]\\s*US\\b", "[-–]\\s*India\\b", "[-–]\\s*East Coast\\b"] } },
  market: { ...shipped.market, cities: { berlin: ["Berlin", "DE"], amsterdam: ["Amsterdam", "NL"], utrecht: ["Utrecht", "NL"], paris: ["Paris", "FR"], cambridge: ["Cambridge", "GB"] } },
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

describe("a place to move to that shares its name with a city elsewhere", () => {
  it("counts in the table's country and at home, where the same name may be meant", () => {
    expect(reasons("Berlin", [moving("Cambridge")], onsite("Cambridge, Germany", "Cambridge", "DE"))).toEqual([]);
    expect(reasons("Berlin", [moving("Cambridge")], onsite("Cambridge, UK", "Cambridge", "GB"))).toEqual([]);
    expect(reasons("Berlin", [moving("Cambridge")], onsite("Cambridge, France", "Cambridge", "FR"))).toEqual(notAllowed);
  });

  it("a remote-only place does not count on site at home either", () => {
    expect(reasons("Berlin", [remoteOnly("Cambridge")], onsite("Cambridge, Germany", "Cambridge", "DE"))).toEqual(notAllowed);
  });
});

describe("the title of a remote job", () => {
  const titled = (country: string): Partial<FilterJob> => ({ title: "AI Engineer - US", workplace: "remote", locations: [loc(country, null, country === "Germany" ? "DE" : "NL")] });

  it("wins over a whole country that would count", () => {
    expect(reasons("", [], titled("Germany"))).toEqual(outOfScope);
    expect(reasons("Berlin", [moving("NL")], titled("Netherlands"))).toEqual(outOfScope);
  });

  it("does not hide a job in a country the title names and the settings list", () => {
    expect(reasons("Berlin", [moving("US")], { title: "AI Engineer - US", workplace: "remote", locations: [loc("Boston", "Boston", "US")] })).toEqual([]);
    expect(reasons("Berlin", [remoteOnly("US")], { title: "AI Engineer - US", workplace: "remote", locations: [loc("Boston", "Boston", "US")] })).toEqual([]);
    expect(reasons("", [], { title: "Lead - US, Germany", workplace: "remote", locations: [loc("Germany", null, "DE")] })).toEqual([]);
  });

  it("gives way over a whole country only to a title naming another country", () => {
    const eastCoast = { title: "AI Engineer - East Coast", workplace: "remote" as const };
    expect(reasons("Berlin", [moving("US")], { ...eastCoast, locations: [loc("Boston", "Boston", "US")] })).toEqual([]);
    expect(reasons("", [], { ...eastCoast, locations: [loc("Germany", null, "DE")] })).toEqual([]);
    expect(reasons("Berlin", [], { ...eastCoast, locations: [loc("Germany", null, "DE")] })).toEqual(outOfScope);
  });

  it("does not take a short name written in small letters for the country", () => {
    expect(reasons("Berlin", [moving("US")], { title: "Build with us - India", workplace: "remote", locations: [loc("Germany", null, "DE")] })).toEqual(outOfScope);
  });

  it("does not touch an on-site job there, or a remote job naming a wanted city", () => {
    expect(reasons("", [], { ...titled("Germany"), workplace: "hybrid" })).toEqual([]);
    expect(reasons("Berlin", [], { title: "AI Engineer - US", workplace: "remote", locations: [loc("Berlin", "Berlin", "DE")] })).toEqual([]);
  });
});

describe("a location naming only the country of a place to move to", () => {
  const verdict = (location: Partial<FilterJob>) => evaluateJob(job(location), filterWith(prefs((raw) => {
    raw.home_city = "Berlin";
    raw.places = [moving("Amsterdam")];
    raw.workplace = ["onsite", "hybrid", "remote"];
  }), pipeline));

  it("is kept with a note, as the home country's name is", () => {
    const { reasons: found } = verdict(onsite("Netherlands", null, "NL"));
    expect(found).toEqual(expect.arrayContaining([expect.stringMatching(/^location_country_level/)]));
    expect(found.filter((reason) => reason.startsWith("location_not_allowed"))).toEqual([]);
  });

  it("reads a note in brackets after the name", () => {
    expect(verdict(onsite("Netherlands (Hybrid)", null, "NL")).reasons.filter((reason) => reason.startsWith("location_not_allowed"))).toEqual([]);
  });

  it("does not stretch to another country, or to a remote job, which check 1 reads", () => {
    expect(reasons("Berlin", [moving("Amsterdam")], onsite("France", null, "FR"))).toEqual(notAllowed);
    expect(reasons("Berlin", [moving("Amsterdam")], remote("Netherlands", null, "NL"))).toEqual(outOfScope);
  });

  it("does not count for a remote-only city", () => {
    expect(reasons("Berlin", [remoteOnly("Amsterdam")], onsite("Netherlands", null, "NL"))).toEqual(notAllowed);
  });
});
