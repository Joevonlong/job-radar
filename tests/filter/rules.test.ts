import { describe, expect, it } from "vitest";

import { applyOverride, evaluateJob, parseFilterReason, wholeWordPattern } from "@/lib/filter";

import { normalizeLocation } from "@/lib/pipeline/geography";

import { fixtureMarket, pipelineWith, pipelineWithPack, shippedPipeline } from "../pipeline/helpers";
import { filterWith, job, loc, prefs, salary } from "./helpers";

const run = (j: ReturnType<typeof job>, filter = filterWith()) => evaluateJob(j, filter);

describe("a job that matches", () => {
  it("passes with no reasons", () => {
    expect(run(job())).toEqual({ result: "passed", reasons: [] });
  });
});

describe("location", () => {
  it.each(["Berlin", "München", "Munich", "Muenchen"])("%s is allowed", (name) => {
    expect(run(job({ locations: [loc(name, name, "DE")] })).result).toBe("passed");
  });

  it("knows Munich as München through the alias table, with or without a stored city", () => {
    expect(run(job({ locations: [loc("Munich, Bavaria, Germany", null, "DE")] })).result).toBe("passed");
    expect(run(job({ locations: [loc("München", "München", "DE")] })).result).toBe("passed");
  });

  it("filters a city that is not wanted, naming it", () => {
    expect(run(job({ locations: [loc("Hamburg", "Hamburg", "DE")] }))).toEqual({ result: "filtered_out", reasons: ["location_not_allowed:Hamburg"] });
  });

  it("is happy with any one allowed city among several", () => {
    expect(run(job({ locations: [loc("Hamburg", "Hamburg", "DE"), loc("Berlin", "Berlin", "DE")] })).result).toBe("passed");
  });

  it("does not match a city name inside another word", () => {
    expect(run(job({ locations: [loc("Berlingen", null, "CH")] })).reasons).toEqual(["location_not_allowed:Berlingen"]);
  });

  it("uses the metro areas of pipeline.yaml (Potsdam counts for Berlin, configurable)", () => {
    const potsdam = job({ locations: [loc("Potsdam", "Potsdam", "DE")] });
    expect(run(potsdam).result).toBe("passed");
    const metro = (areas: Record<string, string[]>) => filterWith(prefs(), pipelineWith((raw) => ((raw.filter as { metro_areas: Record<string, string[]> }).metro_areas = areas)));
    expect(run(potsdam, metro({ Berlin: [], München: [] })).reasons).toEqual(["location_not_allowed:Potsdam"]);
    expect(run(job({ locations: [loc("Garching", "Garching", "DE")] }), metro({ München: ["Garching"] })).result).toBe("passed");
  });

  it.each([
    ["Garching", "Garching, Bavaria, Germany"],
    ["Unterföhring", "Unterföhring, Bavaria, Germany"],
    ["Unterfoehring", "Unterfoehring"],
    ["Planegg", "Planegg"],
    ["Poing bei München", "Poing bei München"],
    ["Schönefeld", "Schönefeld, Brandenburg, Germany"],
  ])("a town of the metro area (%s) is the target city", (city, label) => {
    expect(run(job({ locations: [loc(label, city, "DE")] })).result).toBe("passed");
  });

  it.each(["Berlin Metropolitan Area", "Greater Munich Metropolitan Area", "Munich Metropolitan Area", "Greater Berlin Area", "Metropolregion München"])(
    "reads the LinkedIn-style label %s, with the label as the city or on its own",
    (label) => {
      expect(run(job({ locations: [loc(label, label, "DE")] })).result).toBe("passed");
      expect(run(job({ locations: [loc(label, null, null)] })).result).toBe("passed");
    },
  );

  it("does not take a town of another country or a similar name for a metro town", () => {
    expect(run(job({ locations: [loc("Garching", "Garching", "AT")] })).result).toBe("filtered_out");
    expect(run(job({ locations: [loc("Hartha", "Hartha", "DE")] })).result).toBe("filtered_out");
    expect(run(job({ locations: [loc("Gräfelfingen", "Gräfelfingen", "DE")] })).result).toBe("filtered_out");
    expect(run(job({ locations: [loc("Erlangen, Bavaria, Germany", "Erlangen", "DE")] })).reasons).toEqual(["location_not_allowed:Erlangen"]);
  });

  it("allows other cities the user adds to preferences", () => {
    const hamburg = filterWith(prefs((raw) => ((raw.locations as string[]).push("Hamburg"))));
    expect(run(job({ locations: [loc("Hamburg", "Hamburg", "DE")] }), hamburg).result).toBe("passed");
  });

  it("keeps an on-site job whose place is only a country, marking it as country level", () => {
    expect(run(job({ locations: [loc("Germany", null, "DE")], workplace: "onsite" }))).toEqual({ result: "passed", reasons: ["location_country_level:Germany"] });
  });

  it("reads a city field that holds the country (LinkedIn gives 'Germany' as the city) as country level", () => {
    for (const workplace of ["unknown", "hybrid", "onsite"] as const) {
      expect(run(job({ workplace, locations: [loc("Germany", "Germany", "DE")] }))).toEqual({ result: "passed", reasons: ["location_country_level:Germany"] });
    }
    expect(run(job({ locations: [loc("Deutschland", "Deutschland", "DE")] })).reasons).toEqual(["location_country_level:Deutschland"]);
    expect(run(job({ locations: [loc("Bundesweit", null, null)] })).reasons).toEqual(["location_country_level:Bundesweit"]);
  });

  it("filters an on-site country-level job when the policy says exclude, but still keeps hybrid and unknown ones", () => {
    const strict = filterWith(prefs(), pipelineWith((raw) => ((raw.filter as { country_level: { onsite_policy: string } }).country_level.onsite_policy = "exclude")));
    const germany = [loc("Germany", "Germany", "DE")];
    expect(run(job({ workplace: "onsite", locations: germany }), strict).reasons).toEqual(["location_not_allowed:Germany"]);
    expect(run(job({ workplace: "hybrid", locations: germany }), strict).reasons).toEqual(["location_country_level:Germany"]);
    expect(run(job({ workplace: "unknown", locations: germany }), strict).reasons).toEqual(["location_country_level:Germany"]);
  });

  it("keeps a job whose place is only the region of a target city (Bavaria), but not a town in that region", () => {
    expect(run(job({ locations: [loc("Bavaria, Germany", "Bavaria", "DE")] })).reasons).toEqual(["location_country_level:Bavaria"]);
    expect(run(job({ locations: [loc("Bayern", null, "DE")] })).reasons).toEqual(["location_country_level:Bayern"]);
    expect(run(job({ locations: [loc("Regensburg, Bavaria, Germany", "Regensburg", "DE")] })).reasons).toEqual(["location_not_allowed:Regensburg"]);
  });

  it("keeps a job with a text that names no place at all, with the unknown-place note", () => {
    expect(run(job({ locations: [loc("Home Office", null, null)] }))).toEqual({ result: "passed", reasons: ["location_unknown"] });
  });

  it("filters an on-site job at a named place that has no city field", () => {
    expect(run(job({ locations: [loc("Bochum", null, "DE")] })).reasons).toEqual(["location_not_allowed:Bochum"]);
    expect(run(job({ locations: [loc("New York, NY", null, null)] })).reasons).toEqual(["location_not_allowed:New York, NY"]);
  });

  it("reads a city with a region suffix by its first part", () => {
    expect(run(job({ locations: [loc("München, Oberbayern", "München, Oberbayern", "DE")] })).result).toBe("passed");
    expect(run(job({ locations: [loc("Nürnberg, Mittelfranken", "Nürnberg, Mittelfranken", "DE")] })).result).toBe("filtered_out");
  });

  it("finds an allowed city in the label when the city field is empty", () => {
    expect(run(job({ locations: [loc("Greater Berlin Area", null, null)] })).result).toBe("passed");
  });

  it("filters an on-site job in another country even without a city", () => {
    expect(run(job({ locations: [loc("France", null, "FR")] })).reasons).toEqual(["location_not_allowed:France"]);
  });

  it("keeps a job without any location, with a note", () => {
    expect(run(job({ locations: [] }))).toEqual({ result: "passed", reasons: ["location_unknown"] });
  });
});

describe("remote", () => {
  const remote = (...locations: ReturnType<typeof loc>[]) => job({ workplace: "remote", locations });

  it("keeps remote jobs in Germany (eu_hire_in_de)", () => {
    expect(run(remote(loc("Germany", null, "DE"))).result).toBe("passed");
  });

  it("keeps EU-wide remote jobs", () => {
    expect(run(remote(loc("Remote, EU", null, null))).result).toBe("passed");
    expect(run(remote(loc("Europe", null, null))).result).toBe("passed");
  });

  it("keeps a remote job with an unknown place and marks it", () => {
    expect(run(remote(loc("Remote", null, null)))).toEqual({ result: "passed", reasons: ["remote_scope_unknown"] });
    expect(run(remote())).toEqual({ result: "passed", reasons: ["remote_scope_unknown"] });
  });

  it("filters remote jobs that are bound to another country", () => {
    expect(run(remote(loc("Remote - Spain", null, "ES")))).toEqual({ result: "filtered_out", reasons: ["remote_out_of_scope:Remote - Spain"] });
    expect(run(remote(loc("Remote, USA", null, null))).reasons).toEqual(["remote_out_of_scope:Remote, USA"]);
  });

  it("keeps the job when one place is in scope or unclear", () => {
    expect(run(remote(loc("Remote, USA", null, null), loc("Remote, Germany", null, "DE"))).result).toBe("passed");
    expect(run(remote(loc("Remote, USA", null, null), loc("Remote", null, null))).reasons).toEqual(["remote_scope_unknown"]);
  });

  it("treats a remote job in an allowed city as local", () => {
    expect(run(remote(loc("Berlin", "Berlin", "DE")))).toEqual({ result: "passed", reasons: [] });
  });

  it("eu_any also accepts other EU countries; the UK is not in the EU", () => {
    const euAny = filterWith(prefs((raw) => (raw.remote_scope = { region: ["eu"] })));
    expect(run(remote(loc("Remote - Spain", null, "ES")), euAny).result).toBe("passed");
    expect(run(remote(loc("Remote - UK", null, "GB")), euAny).reasons).toEqual(["remote_out_of_scope:Remote - UK"]);
  });

  it("worldwide accepts everything; none refuses remote jobs outside the allowed cities", () => {
    const worldwide = filterWith(prefs((raw) => (raw.remote_scope = "worldwide")));
    expect(run(remote(loc("Remote, USA", null, "US")), worldwide).result).toBe("passed");
    const none = filterWith(prefs((raw) => (raw.remote_scope = "none")));
    expect(run(remote(loc("Germany", null, "DE")), none).reasons).toEqual(["remote_not_wanted"]);
    expect(run(remote(loc("Berlin", "Berlin", "DE")), none).result).toBe("passed");
  });

  it("keeps a remote job in Germany but marks a country-level location", () => {
    expect(run(remote(loc("Germany", "Germany", "DE")))).toEqual({ result: "passed", reasons: ["location_country_level:Germany"] });
  });

  it.each([
    "Remote - Washington D.C.",
    "Remote - Virginia",
    "Denver, Colorado",
    "Remote in the US, Remote in Canada",
    "Colombia Remote",
    "Remote - India",
    "Remotely in the USA",
    "Austin, TX",
    "Remote - NY",
    "San Francisco, New York, Seattle, Chicago, Atlanta, Remote in the US",
    "Tokyo, Japan",
  ])("filters a remote job located outside the EU/EEA/UK without a country code: %s", (label) => {
    expect(run(remote(loc(label, null, null))).reasons).toEqual([`remote_out_of_scope:${label}`]);
  });

  it("does not take German places for US state codes or states", () => {
    expect(run(remote(loc("Remote, DE", null, null))).reasons).toEqual(["remote_scope_unknown"]);
    expect(run(remote(loc("Remote - Berlin timezone", null, null))).result).toBe("passed");
  });

  it("filters when every location is outside, even a mix of places", () => {
    expect(run(remote(loc("Remote - India", null, null), loc("Tokyo, Japan", null, null), loc("Singapore", null, null))).result).toBe("filtered_out");
    // one place of unknown scope keeps it, noted
    expect(run(remote(loc("Remote - India", null, null), loc("Remote", null, null))).reasons).toEqual(["remote_scope_unknown"]);
  });

  describe("when the description says where it hires", () => {
    const inUs = (description: string) => job({ workplace: "remote", locations: [loc("United States (Remote)", null, null)], description });
    it.each([
      "For this role, we can hire candidates based in the UK, Ireland, Germany, Portugal or Spain.",
      "This role is remote within the EU.",
      "Work from anywhere in Europe.",
      "We are hiring across Europe for this position.",
      "Europe-wide remote role.",
      "Remote aus Deutschland möglich.",
    ])("keeps it, noted: %s", (description) => {
      expect(run(inUs(description))).toEqual({ result: "passed", reasons: ["remote_scope_description:United States (Remote)"] });
    });

    it.each([
      "We serve customers across Europe and the US.",
      "We are a remote-first company with an office in Berlin.",
      "Our engineering team is based in Europe and New York.",
      "Remote role for the US market.",
    ])("does not rescue on a loose mention: %s", (description) => {
      expect(run(inUs(description)).reasons).toEqual(["remote_out_of_scope:United States (Remote)"]);
    });

    it("also rescues a country that is not Germany when the description names Germany", () => {
      const uk = job({ workplace: "remote", locations: [loc("United Kingdom (Remote)", null, "GB")], description: "We can hire candidates based in the UK, Ireland, Germany." });
      expect(run(uk).reasons).toEqual(["remote_scope_description:United Kingdom (Remote)"]);
    });
  });

  describe("a region marker in the title", () => {
    const titled = (title: string, ...locations: ReturnType<typeof loc>[]) =>
      job({ title, workplace: "remote", locations, description: "For this role, we can hire candidates based in the UK, Ireland, Germany, Portugal or Spain." });

    it.each([
      ["Staff AI Engineer - US", "US"],
      ["Forward Deployed Engineer - US East Coast", "US East Coast"],
      ["Solutions Engineer (Americas)", "Americas"],
      ["AI Engineer | North America", "North America"],
      ["ML Engineer, Canada", "Canada"],
      ["Sales Engineer, West Coast", "West Coast"],
      ["Data Scientist (US-based)", "US"],
    ])("excludes %s whatever the locations and the description say", (title, marker) => {
      expect(run(titled(title, loc("United States (Remote)", null, null)))).toEqual({ result: "filtered_out", reasons: [`remote_out_of_scope:${marker}`] });
      expect(run(titled(title, loc("Germany", null, "DE"))).result).toBe("filtered_out");
    });

    it.each(["Senior AI Engineer - EU", "Forward Deployed Engineer - EMEA", "AI Engineer (EMEA / Americas)", "Campus Recruiter", "Usability Engineer - Remote", "Focus on US healthcare data"])("does not exclude %s", (title) => {
      expect(run(titled(title, loc("Germany", null, "DE"))).result).toBe("passed");
    });

    it("only applies to remote postings and not to remote_scope worldwide", () => {
      expect(run(job({ title: "AI Engineer - US", workplace: "hybrid", locations: [loc("Berlin", "Berlin", "DE")] })).result).toBe("passed");
      const worldwide = filterWith(prefs((raw) => (raw.remote_scope = "worldwide")));
      expect(run(titled("Staff AI Engineer - US", loc("United States (Remote)", null, null)), worldwide).result).toBe("passed");
    });

    it("is configurable", () => {
      // The markers are the DE pack's (rules.yaml); a pack copy can drop them
      const none = filterWith(prefs(), pipelineWithPack("de", (pack) => void (pack.rules.filter.remote.title_outside_patterns = [])));
      expect(run(titled("Staff AI Engineer - US", loc("United States (Remote)", null, null)), none).reasons).toEqual(["remote_scope_description:United States (Remote)"]);
    });
  });

  it("worldwide remote counts as in scope", () => {
    expect(run(remote(loc("Remote (worldwide)", null, null))).result).toBe("passed");
  });
});

describe("workplace", () => {
  it("filters a workplace the preferences leave out; unknown is kept", () => {
    const noOnsite = filterWith(prefs((raw) => (raw.workplace = ["hybrid", "remote"])));
    expect(run(job({ workplace: "onsite" }), noOnsite).reasons).toEqual(["workplace_not_wanted:onsite"]);
    expect(run(job({ workplace: "unknown" }), noOnsite).result).toBe("passed");
  });
});

describe("student roles and contract", () => {
  it("excludes student contracts", () => {
    expect(run(job({ contract: "student" }))).toEqual({ result: "filtered_out", reasons: ["student_role"] });
  });
  it("keeps them when the preference is off", () => {
    expect(run(job({ contract: "student" }), filterWith(prefs((raw) => (raw.exclude_student_roles = false)))).result).toBe("passed");
  });
  it("excludes temp agency work", () => {
    expect(run(job({ contract: "temp_agency" })).reasons).toEqual(["contract_excluded:temp_agency"]);
  });
  it("keeps freelance, permanent, fixed term and unknown", () => {
    for (const contract of ["freelance", "permanent", "fixed_term", "unknown"]) expect(run(job({ contract })).result).toBe("passed");
  });
  it("filters a kind that is neither allowed nor excluded", () => {
    const strict = filterWith(prefs((raw) => (raw.contracts = { allow: ["permanent"], exclude: [] })));
    expect(run(job({ contract: "freelance" }), strict).reasons).toEqual(["contract_not_allowed:freelance"]);
    expect(run(job({ contract: "unknown" }), strict).result).toBe("passed");
  });
});

describe("salary", () => {
  it("excludes a stated maximum below the floor", () => {
    expect(run(job({ salary: salary(50_000, 69_999) })).reasons).toEqual(["salary_below_floor:69999"]);
  });
  it("an hourly or foreign-currency salary goes through the floor in EUR per year", () => {
    // Sprachwerk "Rate: 18 USD per hour": 37,440 USD a year, about 32,000 EUR
    const hourly = salary(32_198, 32_198, { currency: "USD", period: "hour", min: 18, max: 18, otherRegion: "currency" });
    expect(run(job({ salary: hourly })).reasons).toEqual(["salary_below_floor:32198"]);
  });
  it("keeps a maximum of exactly the floor", () => {
    expect(run(job({ salary: salary(60_000, 70_000) })).result).toBe("passed");
  });
  it("keeps a range that crosses the floor", () => {
    expect(run(job({ salary: salary(60_000, 80_000) })).result).toBe("passed");
  });
  it("does not use the minimum: a range entirely below is excluded by its maximum", () => {
    expect(run(job({ salary: salary(50_000, 60_000) })).result).toBe("filtered_out");
  });
  it("keeps a posting without salary, with only a minimum, without an EUR figure, or with a doubtful one", () => {
    expect(run(job({ salary: null })).result).toBe("passed");
    expect(run(job({ salary: salary(40_000, null) })).result).toBe("passed");
    expect(run(job({ salary: salary(null, null, { eurPerYear: null, currency: "GBP" }) })).result).toBe("passed");
    expect(run(job({ salary: salary(1_000, 2_000, { qualityStatus: "review" }) })).result).toBe("passed");
  });
  it("uses the floor of the preferences; a floor of 0 switches the rule off", () => {
    const high = filterWith(prefs((raw) => (raw.salary_floor_year = 90_000)));
    expect(run(job({ salary: salary(60_000, 80_000) }), high).result).toBe("filtered_out");
    const off = filterWith(prefs((raw) => (raw.salary_floor_year = 0)));
    expect(run(job({ salary: salary(1, 2) }), off).result).toBe("passed");
  });
});

describe("blacklist", () => {
  it("matches the company regardless of case and legal form", () => {
    const f = filterWith(prefs((raw) => (raw.exclude_companies = ["acme"])));
    expect(run(job({ companyName: "ACME GmbH" }), f).reasons).toEqual(["blacklist_company:ACME GmbH"]);
    expect(run(job({ companyName: "Acme Robotics" }), f).result).toBe("passed");
  });
  it("matches a company by an alias and honours the companies.blacklisted flag", () => {
    const f = filterWith(prefs((raw) => (raw.exclude_companies = ["Facebook"])));
    expect(run(job({ companyName: "Meta" }), f).result).toBe("filtered_out");
    expect(run(job({ companyName: "Other", companyAliases: ["Facebook Inc."] }), f).result).toBe("filtered_out");
    expect(run(job({ companyBlacklisted: true })).reasons).toEqual(["blacklist_company:Northwind Labs GmbH"]);
  });
  it("matches whole words of the title and the description, case-insensitively", () => {
    const f = filterWith(prefs((raw) => (raw.exclude_keywords = ["Rust", "sap abap"])));
    expect(run(job({ title: "RUST Engineer" }), f).reasons).toEqual(["blacklist_keyword:Rust"]);
    expect(run(job({ description: "We use SAP  ABAP daily" }), f).reasons).toEqual(["blacklist_keyword:sap abap"]);
    expect(run(job({ description: "We trust our people; frustrating rusty things" }), f).result).toBe("passed");
  });
  it("lists every keyword that matches", () => {
    const f = filterWith(prefs((raw) => (raw.exclude_keywords = ["Rust", "Cobol"])));
    expect(run(job({ description: "rust and cobol" }), f).reasons).toEqual(["blacklist_keyword:Rust", "blacklist_keyword:Cobol"]);
  });
  it("handles keywords with regex characters", () => {
    const f = filterWith(prefs((raw) => (raw.exclude_keywords = ["C++"])));
    expect(run(job({ description: "senior C++ developer" }), f).result).toBe("filtered_out");
    expect(run(job({ description: "C# developer" }), f).result).toBe("passed");
  });
});

describe("seniority", () => {
  it("does not filter when the preference is all", () => {
    for (const seniority of ["intern", "junior", "senior", "lead", "unknown"]) expect(run(job({ seniority })).result).toBe("passed");
  });
  it("filters other levels when one is wanted, but keeps unstated ones", () => {
    const senior = filterWith(prefs((raw) => (raw.seniority = "senior")));
    expect(run(job({ seniority: "junior" }), senior).reasons).toEqual(["seniority_mismatch:junior"]);
    expect(run(job({ seniority: "staff" }), senior).result).toBe("passed");
    expect(run(job({ seniority: "unknown" }), senior).result).toBe("passed");
  });
});

describe("several rules", () => {
  it("lists every rule that excludes the job", () => {
    const verdict = run(job({ locations: [loc("Hamburg", "Hamburg", "DE")], contract: "temp_agency", salary: salary(30_000, 40_000) }));
    expect(verdict.reasons).toEqual(["location_not_allowed:Hamburg", "contract_excluded:temp_agency", "salary_below_floor:40000"]);
  });
});

describe("user override", () => {
  const hamburg = job({ locations: [loc("Hamburg", "Hamburg", "DE")] });

  it("keep turns a filtered job into a passed one and records what the rules said", () => {
    expect(evaluateJob(hamburg, filterWith(), "keep")).toEqual({ result: "passed", reasons: ["override_keep", "location_not_allowed:Hamburg"] });
  });

  it("exclude filters a job that passed", () => {
    expect(evaluateJob(job(), filterWith(), "exclude")).toEqual({ result: "filtered_out", reasons: ["override_exclude"] });
  });

  it("keeps the rule reasons next to an exclude of a job the rules filtered anyway", () => {
    expect(evaluateJob(hamburg, filterWith(), "exclude")).toEqual({ result: "filtered_out", reasons: ["override_exclude", "location_not_allowed:Hamburg"] });
  });

  it("keep on a job that passed keeps its notes; no override changes nothing", () => {
    const remoteUnknown = job({ workplace: "remote", locations: [loc("Remote", null, null)] });
    expect(evaluateJob(remoteUnknown, filterWith(), "keep")).toEqual({ result: "passed", reasons: ["override_keep", "remote_scope_unknown"] });
    expect(evaluateJob(hamburg, filterWith(), null)).toEqual(evaluateJob(hamburg, filterWith()));
    expect(applyOverride({ result: "passed", reasons: [] }, null)).toEqual({ result: "passed", reasons: [] });
  });
});

describe("helpers", () => {
  it("parses reason strings", () => {
    expect(parseFilterReason("salary_below_floor:58000")).toMatchObject({ code: "salary_below_floor", detail: "58000" });
    expect(parseFilterReason("blacklist_keyword:C++:x")).toMatchObject({ code: "blacklist_keyword", detail: "C++:x" });
    expect(parseFilterReason("student_role")).toMatchObject({ code: "student_role", detail: null });
    expect(parseFilterReason("Student position")).toMatchObject({ code: null, raw: "Student position" });
  });
  it("matches whole words only", () => {
    expect(wholeWordPattern("go").test("ago")).toBe(false);
    expect(wholeWordPattern("go").test("Go, Rust")).toBe(true);
  });
});

describe("remote scope home_country: what it keeps (rules unchanged)", () => {
  const market = fixtureMarket();
  const remote = (label: string, title = "Applied AI Engineer", description: string | null = "Build LLM features for our platform.") =>
    job({ title, description, workplace: "remote", locations: [normalizeLocation(label, market)] });
  const homeCountry = filterWith(prefs((raw) => (raw.remote_scope = "home_country")));

  it.each([
    ["Remote - Berlin", []],
    ["Munich (Remote)", []],
    ["Germany (Remote)", ["location_country_level:Germany (Remote)"]],
    ["Remote, Deutschland", null],
    ["Remote - EU", []],
    ["Europe", []],
    ["EMEA", []],
    ["EEA", []],
    ["Europa", []],
    ["Remote - Worldwide", []],
    ["Anywhere", []],
    ["Global", []],
    ["weltweit", []],
  ])("keeps %s", (label, reasons) => {
    const verdict = run(remote(label), homeCountry);
    expect(verdict.result).toBe("passed");
    // the country-level note names the stored place; the other rows carry no note
    if (reasons !== null) expect(verdict.reasons.map((r) => r.split(":", 1)[0])).toEqual(reasons.map((r) => r.split(":", 1)[0]));
  });

  it.each(["Remote - Spain", "Remote, UK", "Austria", "Remote - USA", "Americas", "APAC", "Austin, TX"])("excludes %s", (label) => {
    const verdict = run(remote(label), homeCountry);
    expect(verdict.result).toBe("filtered_out");
    expect(verdict.reasons.map((r) => r.split(":", 1)[0])).toEqual(["remote_out_of_scope"]);
  });

  it("keeps an outside place when the description says it hires in Europe, noted", () => {
    const verdict = run(remote("Remote - Spain", "Applied AI Engineer", "This is a remote from anywhere in Europe role."), homeCountry);
    expect(verdict.result).toBe("passed");
    expect(verdict.reasons.map((r) => r.split(":", 1)[0])).toEqual(["remote_scope_description"]);
  });

  it("excludes by the title marker even when the title also says nothing in scope; an in-scope region in the title wins", () => {
    expect(run(remote("Germany", "AI Engineer - US"), homeCountry).reasons).toEqual(["remote_out_of_scope:US"]);
    expect(run(remote("Germany", "AI Engineer (EMEA / Americas)"), homeCountry).result).toBe("passed");
  });

  it("keeps a remote job that does not say where, noted", () => {
    expect(run(remote("Remote"), homeCountry)).toEqual({ result: "passed", reasons: ["remote_scope_unknown"] });
    expect(run(job({ workplace: "remote", locations: [] }), homeCountry)).toEqual({ result: "passed", reasons: ["remote_scope_unknown"] });
  });

  it("has the same rules in the generic market (no region: only the home country and worldwide)", () => {
    const genericMarket = fixtureMarket({ pack: "generic", country: "DE", currency: "EUR", home_language: "de" });
    const generic = filterWith(prefs((raw) => (raw.remote_scope = "home_country")), shippedPipeline(genericMarket));
    const place = (label: string) => job({ workplace: "remote", locations: [normalizeLocation(label, genericMarket)] });
    expect(run(place("Germany (Remote)"), generic).result).toBe("passed");
    expect(run(place("Remote - Worldwide"), generic).result).toBe("passed");
    expect(run(place("Remote - Spain"), generic).result).toBe("filtered_out");
  });
});

describe("watched companies keep their on-site jobs anywhere in the home country", () => {
  const watchedFilter = (...names: string[]) => filterWith(prefs(), shippedPipeline(), names);
  const at = (...locations: ReturnType<typeof loc>[]) => job({ companyName: "Acme GmbH", companyNameNorm: "acme", workplace: "onsite", locations });
  // through the real location reading: the city table says Hamburg is in Germany
  const hamburg = normalizeLocation("Hamburg", fixtureMarket());

  it("reads Hamburg as a German city", () => {
    expect(hamburg).toMatchObject({ city: "Hamburg", countryCode: "DE" });
  });

  it("never watches a company through an empty key", () => {
    const empty = filterWith(prefs(), shippedPipeline(), ["日本電気"]);
    expect(run({ ...at(hamburg), companyNameNorm: null }, empty).reasons).toEqual(["location_not_allowed:Hamburg"]);
    expect(run({ ...at(hamburg), companyNameNorm: "" }, empty).reasons).toEqual(["location_not_allowed:Hamburg"]);
    expect(run({ ...at(hamburg), companyNameNorm: undefined }, empty).reasons).toEqual(["location_not_allowed:Hamburg"]);
    // the database flag still watches
    expect(run({ ...at(hamburg), companyNameNorm: "", companyWatched: true }, empty).result).toBe("passed");
  });

  it("keeps Hamburg for a watched company, noting why; the same job of an unwatched company is excluded", () => {
    expect(run(at(hamburg), watchedFilter("Acme"))).toEqual({ result: "passed", reasons: ["watched_company_location:Hamburg"] });
    expect(run(at(hamburg), watchedFilter())).toEqual({ result: "filtered_out", reasons: ["location_not_allowed:Hamburg"] });
    expect(run(at(hamburg), watchedFilter("Other"))).toEqual({ result: "filtered_out", reasons: ["location_not_allowed:Hamburg"] });
  });

  it("reads the watch list by the push step's key: legal form and case do not matter", () => {
    expect(run(at(hamburg), watchedFilter("acme GmbH")).result).toBe("passed");
    expect(run(at(hamburg), watchedFilter("ACME")).result).toBe("passed");
    expect(run(at(hamburg), watchedFilter("Acme AI")).result).toBe("filtered_out");
  });

  it("watches by the database flag alone", () => {
    expect(run({ ...at(hamburg), companyWatched: true }, watchedFilter())).toEqual({ result: "passed", reasons: ["watched_company_location:Hamburg"] });
  });

  it("works for hybrid and unknown work modes too", () => {
    for (const workplace of ["hybrid", "unknown"] as const) {
      expect(run({ ...at(hamburg), workplace }, watchedFilter("Acme")).reasons).toEqual(["watched_company_location:Hamburg"]);
    }
  });

  it("keeps a town whose country is stated by the source", () => {
    expect(run(at(loc("Walldorf, Germany", "Walldorf", "DE")), watchedFilter("Acme")).reasons).toEqual(["watched_company_location:Walldorf"]);
  });

  it("keeps a job when any one of its places is in the home country", () => {
    expect(run(at(hamburg, loc("London, UK", "London", "GB")), watchedFilter("Acme")).reasons).toEqual(["watched_company_location:Hamburg"]);
    expect(run(at(loc("London, UK", "London", "GB"), hamburg), watchedFilter("Acme")).reasons).toEqual(["watched_company_location:Hamburg"]);
  });

  it("does not keep a place in another country", () => {
    expect(run(at(loc("London", "London", "GB")), watchedFilter("Acme")).reasons).toEqual(["location_not_allowed:London"]);
  });

  // a place the data does not tie to the home country is not kept: the board is collected whole and the push step ignores the score
  it.each([
    ["San Francisco", "San Francisco"],
    ["Bengaluru", "Bengaluru"],
    ["Walldorf", "Walldorf"],
  ])("does not keep %s when no country can be read", (label, place) => {
    const location = normalizeLocation(label, fixtureMarket());
    expect(location.countryCode).toBeNull();
    expect(run(at(location), watchedFilter("Acme"))).toEqual({ result: "filtered_out", reasons: [`location_not_allowed:${place}`] });
  });

  it("keeps an on-site job that names only the country when the policy says exclude", () => {
    const strict = pipelineWith((raw) => ((raw.filter as { country_level: { onsite_policy: string } }).country_level.onsite_policy = "exclude"));
    const germany = [loc("Germany", "Germany", "DE")];
    expect(run(at(...germany), filterWith(prefs(), strict, ["Acme"]))).toEqual({ result: "passed", reasons: ["watched_company_location:Germany"] });
    expect(run(at(...germany), filterWith(prefs(), strict))).toEqual({ result: "filtered_out", reasons: ["location_not_allowed:Germany"] });
    // a place the filter keeps anyway gets no extra note
    expect(run({ ...at(...germany), workplace: "hybrid" }, filterWith(prefs(), strict, ["Acme"])).reasons).toEqual(["location_country_level:Germany"]);
  });

  it("adds no note where the job is kept anyway", () => {
    expect(run(at(loc("Berlin", "Berlin", "DE")), watchedFilter("Acme"))).toEqual({ result: "passed", reasons: [] });
    expect(run(at(), watchedFilter("Acme")).reasons).toEqual(["location_unknown"]);
    expect(run(at(loc("Home Office", null, null)), watchedFilter("Acme")).reasons).toEqual(["location_unknown"]);
  });

  it("changes only the location check", () => {
    const f = watchedFilter("Acme");
    expect(run({ ...at(hamburg), workplace: "onsite" }, filterWith(prefs((raw) => (raw.workplace = ["remote"])), shippedPipeline(), ["Acme"])).reasons).toEqual(["workplace_not_wanted:onsite"]);
    expect(run({ ...at(hamburg), salary: salary(1000, 2000) }, f).reasons).toEqual(["salary_below_floor:2000"]);
    expect(run({ ...at(hamburg), contract: "student" }, f).reasons).toEqual(["student_role"]);
    const senior = filterWith(prefs((raw) => (raw.seniority = "senior")), shippedPipeline(), ["Acme"]);
    expect(run({ ...at(hamburg), seniority: "entry" }, senior).reasons).toEqual(["seniority_mismatch:entry"]);
    expect(run({ ...at(hamburg), companyBlacklisted: true }, f).reasons).toEqual(["blacklist_company:Acme GmbH"]);
    expect(run({ ...at(hamburg), title: "Intern" }, filterWith(prefs((raw) => (raw.exclude_keywords = ["Intern"])), shippedPipeline(), ["Acme"])).reasons).toEqual(["blacklist_keyword:Intern"]);
    expect(run(at(hamburg), f).result).toBe("passed");
    // a deal-breaker still vetoes a watched company's job
    const withVeto = filterWith(prefs((raw) => (raw.deal_breakers = [{ id: "rust", label: "Rust", type: "phrase", terms: ["Rust"] }])), shippedPipeline(), ["Acme"]);
    // (the veto itself comes from dealBreakerVetoes, covered in deal-breakers.test.ts; here it is handed in)
    expect(evaluateJob(at(hamburg), withVeto, null, ["rust"])).toEqual({ result: "filtered_out", reasons: ["deal_breaker:rust"] });
    expect(evaluateJob(at(hamburg), withVeto, null, [])).toEqual({ result: "passed", reasons: ["watched_company_location:Hamburg"] });
    expect(applyOverride(run(at(hamburg), f), "exclude")).toEqual({ result: "filtered_out", reasons: ["override_exclude"] });
  });

  it("leaves remote jobs to the remote scope", () => {
    const f = watchedFilter("Acme");
    expect(run({ ...at(loc("Remote - Spain", null, "ES")), workplace: "remote" }, f).reasons).toEqual(["remote_out_of_scope:Remote - Spain"]);
    expect(run({ ...at(loc("Hamburg", "Hamburg", "DE")), workplace: "remote" }, f)).toEqual({ result: "passed", reasons: [] });
  });
});
