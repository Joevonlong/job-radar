import { describe, expect, it } from "vitest";

import { createSerializer } from "nuqs/server";

import { APPLICATION_FILTER_STATUSES, MAX_FILTER_VALUE_CHARS, MAX_FILTER_VALUES } from "@/lib/jobs/constants";
import { APPLICATION_STATUSES } from "@/lib/db/repos/applications";
import { viewFiltersFromParams, viewFiltersToParams } from "@/lib/interests/view-filters";
import { countActiveFilters, hasActiveFilters, isCalendarDate, jobsListHref, jobsSearchParsers, jobsSearchQuery, loadFavoritesSearchParams, loadJobsSearchParams } from "@/lib/jobs/search-params";

describe("jobs search params", () => {
  it("parses scope, canonical archive reasons and last listed without introducing defaults", () => {
    expect(loadJobsSearchParams("?scope=archive&reason=dormant&reason=gone&reason=manual&reason=gone&reason=bad&sort=last_listed")).toMatchObject({ scope: "archive", reason: ["manual", "gone", "dormant"], sort: "last_listed" });
    expect(loadJobsSearchParams("?scope=bad&reason=phrase&reason=&sort=bad")).toMatchObject({ scope: null, reason: [], sort: null });
    expect(loadJobsSearchParams("")).toMatchObject({ scope: null, reason: [], sort: null });
    expect(jobsListHref({ scope: "archive", sort: null })).toBe("/jobs?scope=archive");
    expect(jobsListHref({ scope: "archive", sort: "rank" })).toBe("/jobs?scope=archive&sort=rank");
  });

  it("counts reasons once, but never counts scope as a filter", () => {
    expect(countActiveFilters(loadJobsSearchParams("?scope=all"))).toBe(0);
    expect(hasActiveFilters(loadJobsSearchParams("?scope=archive"))).toBe(false);
    expect(countActiveFilters(loadJobsSearchParams("?scope=current&reason=manual&reason=gone"))).toBe(1);
  });
  it("parses valid URL state", () => {
    const params = loadJobsSearchParams("?q=llm&source=ats&workplace=remote&status=active&from=2026-10-01&to=2026-10-07&salary=true&sort=posted&page=3");
    expect(params).toMatchObject({ q: "llm", source: ["ats"], workplace: ["remote"], status: ["active"], from: "2026-10-01", to: "2026-10-07", salary: true, sort: "posted", page: 3 });
  });

  it("falls back to defaults for invalid values", () => {
    const params = loadJobsSearchParams("?workplace=moon&status=bogus&from=2026-13-40&sort=nope&page=abc&salary=maybe");
    expect(params.workplace).toEqual([]);
    expect(params.status).toEqual([]);
    expect(params.from).toBeNull();
    expect(params.sort).toBeNull();
    expect(params.page).toBe(1);
    expect(hasActiveFilters(params)).toBe(false);
  });

  it("accepts the async searchParams object of Next.js", async () => {
    const params = await loadJobsSearchParams(Promise.resolve({ city: "Berlin", q: ["a", "b"] }));
    expect(params.city).toEqual(["Berlin"]);
  });

  it("isCalendarDate rejects impossible dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("26-02-01")).toBe(false);
  });

  it("reads application status as repeated keys (several at once), minimum score and minimum salary", () => {
    const params = loadJobsSearchParams("?app=interested&app=applied&minScore=70&minSalary=85000");
    expect(params.app).toEqual(["interested", "applied"]);
    expect(params.minScore).toBe(70);
    expect(params.minSalary).toBe(85000);
    expect(hasActiveFilters(params)).toBe(true);
  });

  it("drops unknown statuses and unusable numbers instead of failing", () => {
    const params = loadJobsSearchParams("?app=interested&app=bogus&minScore=abc&minSalary=-5");
    expect(params.app).toEqual(["interested"]);
    expect(params.minScore).toBeNull();
    expect(params.minSalary).toBeNull();
    expect(loadJobsSearchParams("?minScore=101").minScore).toBeNull();
    expect(loadJobsSearchParams("?minScore=0").minScore).toBe(0);
    expect(hasActiveFilters(loadJobsSearchParams("?minScore=0"))).toBe(true);
    expect(loadJobsSearchParams("?minSalary=99999999999").minSalary).toBeNull();
    expect(loadJobsSearchParams("?minSalary=70.5").minSalary).toBeNull();
    expect(hasActiveFilters(loadJobsSearchParams("?app=bogus"))).toBe(false);
  });

  it("writes the statuses as repeated keys and leaves an empty selection out of the URL", () => {
    const serialize = createSerializer(jobsSearchParsers);
    expect(serialize("/jobs", { app: ["new", "archived"], minScore: 60 })).toBe("/jobs?app=new&app=archived&minScore=60");
    expect(serialize("/jobs", { app: [] })).toBe("/jobs");
    expect(serialize("/jobs", { app: null })).toBe("/jobs");
  });

  it("writes link URLs the way Next spells them, so a comma or a slash in the search text does not stall the prefetch", () => {
    expect(jobsListHref({ q: "ai,ml", filtered: true })).toBe("/jobs?q=ai%2Cml&filtered=true");
    expect(jobsListHref({ q: "a/b=c:d é", page: 2 })).toBe("/jobs?q=a%2Fb%3Dc%3Ad+%C3%A9&page=2");
    expect(jobsListHref({ app: ["new", "archived"], minScore: 60 })).toBe("/jobs?app=new&app=archived&minScore=60");
    expect(jobsListHref({})).toBe("/jobs");
    // the spelling reads back as the same text
    expect(loadJobsSearchParams(jobsListHref({ q: "ai,ml" }).slice("/jobs".length)).q).toBe("ai,ml");
  });

  it("counts the filters for the phone's Filters (n) button: not the search text, the sort or the page", () => {
    expect(countActiveFilters(loadJobsSearchParams("?q=rust&sort=posted&page=2"))).toBe(0);
    expect(countActiveFilters(loadJobsSearchParams("?source=ats&city=Berlin&app=new&app=applied&minScore=70&minSalary=80000&salary=true&high=true"))).toBe(7);
    // a multi-select counts once
    expect(countActiveFilters(loadJobsSearchParams("?app=new&app=applied&app=offer"))).toBe(1);
  });

  it("offers every application status the database knows, in pipeline order", () => {
    expect([...APPLICATION_FILTER_STATUSES]).toEqual([...APPLICATION_STATUSES]);
  });

  it("reads the categorical filters as repeated keys, and an old single value as a one-element list", () => {
    const params = loadJobsSearchParams("?city=Berlin&city=M%C3%BCnchen&source=xing&workplace=hybrid&workplace=remote&contract=permanent&status=closed&status=active");
    expect(params.city).toEqual(["Berlin", "München"]);
    expect(params.source).toEqual(["xing"]);
    // enum filters come in their canonical order, whatever the URL said
    expect(params.workplace).toEqual(["hybrid", "remote"]);
    expect(params.status).toEqual(["active", "closed"]);
    expect(params.contract).toEqual(["permanent"]);
    expect(loadJobsSearchParams("?city=Berlin").city).toEqual(["Berlin"]);
  });

  it("drops empty, unknown, duplicate and surplus values instead of failing", () => {
    const params = loadJobsSearchParams("?city=&city=%20Berlin%20&city=Berlin&city=%20&workplace=moon&workplace=remote&workplace=remote&status=bogus");
    expect(params.city).toEqual(["Berlin"]);
    expect(params.workplace).toEqual(["remote"]);
    expect(params.status).toEqual([]);
    expect(hasActiveFilters(loadJobsSearchParams("?status=bogus&city="))).toBe(false);
    const many = Array.from({ length: MAX_FILTER_VALUES + 5 }, (_, i) => `city=C${i}`).join("&");
    expect(loadJobsSearchParams(`?${many}`).city).toHaveLength(MAX_FILTER_VALUES);
    expect(loadJobsSearchParams(`?city=${"x".repeat(MAX_FILTER_VALUE_CHARS + 1)}`).city).toEqual([]);
  });

  it("reads companies like cities: repeated keys, an old single value, invalid, duplicate and surplus values dropped", () => {
    expect(loadJobsSearchParams("?company=Zalando&company=N26").company).toEqual(["Zalando", "N26"]);
    expect(loadJobsSearchParams("?company=Zalando").company).toEqual(["Zalando"]);
    expect(loadJobsSearchParams("?company=&company=%20Zalando%20&company=Zalando&company=%20").company).toEqual(["Zalando"]);
    const many = Array.from({ length: MAX_FILTER_VALUES + 5 }, (_, i) => `company=C${i}`).join("&");
    expect(loadJobsSearchParams(`?${many}`).company).toHaveLength(MAX_FILTER_VALUES);
    expect(loadJobsSearchParams(`?company=${"x".repeat(MAX_FILTER_VALUE_CHARS + 1)}`).company).toEqual([]);
    expect(jobsListHref({ company: ["AT&T, Inc.", "N26"] })).toBe("/jobs?company=AT%26T%2C+Inc.&company=N26");
    expect(loadJobsSearchParams(jobsListHref({ company: ["AT&T, Inc."] }).slice("/jobs".length)).company).toEqual(["AT&T, Inc."]);
    expect(countActiveFilters(loadJobsSearchParams("?company=Zalando&company=N26&city=Berlin"))).toBe(2);
    expect(hasActiveFilters(loadJobsSearchParams("?company=Zalando"))).toBe(true);
  });

  it("writes several values as repeated keys and nothing for an empty list", () => {
    const serialize = createSerializer(jobsSearchParsers);
    expect(serialize("/jobs", { city: ["Berlin", "München"], workplace: ["remote"] })).toBe("/jobs?city=Berlin&city=München&workplace=remote");
    expect(serialize("/jobs", { city: [], source: [] })).toBe("/jobs");
  });

  it("a value with a comma is one value, and links carry no bare comma", () => {
    const href = jobsListHref({ city: ["Nürnberg, Mittelfranken", "Berlin"] });
    expect(href).toBe("/jobs?city=N%C3%BCrnberg%2C+Mittelfranken&city=Berlin");
    expect(href).not.toContain(",");
    expect(loadJobsSearchParams(href.slice("/jobs".length)).city).toEqual(["Nürnberg, Mittelfranken", "Berlin"]);
  });

  it("counts a multi-value filter once, and 'show filtered' is no filter", () => {
    expect(countActiveFilters(loadJobsSearchParams("?city=Berlin&city=M%C3%BCnchen&workplace=remote&workplace=hybrid"))).toBe(2);
    expect(hasActiveFilters(loadJobsSearchParams("?filtered=true"))).toBe(false);
    expect(hasActiveFilters(loadJobsSearchParams("?city=Berlin&city=M%C3%BCnchen"))).toBe(true);
  });
});

describe("favorites only", () => {
  it("reads fav as a boolean toggle that counts as an active filter and is cleared with the rest", () => {
    const params = loadJobsSearchParams("?fav=true&minScore=70");
    expect(params.fav).toBe(true);
    expect(hasActiveFilters(params)).toBe(true);
    expect(countActiveFilters(params)).toBe(2);
    expect(hasActiveFilters(loadJobsSearchParams("?fav=true"))).toBe(true);
    expect(hasActiveFilters(loadJobsSearchParams("?fav=maybe"))).toBe(false);
    expect(hasActiveFilters(loadJobsSearchParams(""))).toBe(false);
  });

  it("writes fav=true in a list link and leaves it out when off", () => {
    expect(jobsListHref({ fav: true, page: 1 })).toBe("/jobs?fav=true");
    expect(jobsListHref({ fav: null })).toBe("/jobs");
  });

  it("unseen only is a URL toggle like fav: an active filter, never part of a saved view", () => {
    const params = loadJobsSearchParams("?unseen=true&city=Berlin");
    expect(params.unseen).toBe(true);
    expect(hasActiveFilters(loadJobsSearchParams("?unseen=true"))).toBe(true);
    expect(jobsListHref({ unseen: true, page: 1 })).toBe("/jobs?unseen=true");
    expect(viewFiltersFromParams(params)).toEqual({ city: "Berlin" });
    expect(jobsSearchQuery({ ...params, page: 3 })).toBe("city=Berlin&unseen=true");
  });

  it("the favorites page reads sort, and an invalid value reads as the default", () => {
    expect(loadFavoritesSearchParams("?sort=rank").sort).toBe("rank");
    expect(loadFavoritesSearchParams("?sort=starred").sort).toBe("starred");
    expect(loadFavoritesSearchParams("?sort=nope").sort).toBe("starred");
    expect(loadFavoritesSearchParams("").sort).toBe("starred");
  });
});

describe("AI trap filter", () => {
  it("reads trap=only|hide, ignores anything else, and counts as an active filter", () => {
    expect(loadJobsSearchParams("?trap=only").trap).toBe("only");
    expect(loadJobsSearchParams("?trap=hide").trap).toBe("hide");
    expect(loadJobsSearchParams("?trap=maybe").trap).toBeNull();
    expect(countActiveFilters(loadJobsSearchParams("?trap=only&minScore=70"))).toBe(2);
    expect(hasActiveFilters(loadJobsSearchParams("?trap=hide"))).toBe(true);
    expect(jobsListHref({ trap: "only", page: 1 })).toBe("/jobs?trap=only");
  });

  it("round-trips through a saved view", () => {
    const filters = viewFiltersFromParams(loadJobsSearchParams("?trap=hide&high=true"));
    expect(filters).toEqual({ high: true, trap: "hide" });
    expect(viewFiltersToParams(filters).trap).toBe("hide");
    expect(viewFiltersToParams({}).trap).toBeNull();
  });

});

describe("visa filter", () => {
  it("reads visa=offered|not_denied, ignores anything else, and counts as an active filter", () => {
    expect(loadJobsSearchParams("?visa=offered").visa).toBe("offered");
    expect(loadJobsSearchParams("?visa=not_denied").visa).toBe("not_denied");
    expect(loadJobsSearchParams("?visa=yes").visa).toBeNull();
    expect(countActiveFilters(loadJobsSearchParams("?visa=offered&minScore=70"))).toBe(2);
    expect(hasActiveFilters(loadJobsSearchParams("?visa=not_denied"))).toBe(true);
    expect(jobsListHref({ visa: "offered", page: 1 })).toBe("/jobs?visa=offered");
  });

  it("while hidden is ignored but kept: not counted, not active, still in the URL", () => {
    const params = loadJobsSearchParams("?visa=offered&minScore=70");
    const hidden = { ignore: ["visa"] as const };
    expect(countActiveFilters(params, hidden)).toBe(1);
    expect(hasActiveFilters(loadJobsSearchParams("?visa=offered"), hidden)).toBe(false);
    expect(params.visa).toBe("offered");
    expect(jobsListHref({ ...params, page: 1 })).toContain("visa=offered");
  });

  it("round-trips through a saved view", () => {
    const filters = viewFiltersFromParams(loadJobsSearchParams("?visa=not_denied"));
    expect(filters).toEqual({ visa: "not_denied" });
    expect(viewFiltersToParams(filters).visa).toBe("not_denied");
    expect(viewFiltersToParams({}).visa).toBeNull();
  });
});

describe("ghost job filter", () => {
  it("reads ghost=all|only|hide and ignores anything else; all is no filter", () => {
    expect(loadJobsSearchParams("?ghost=only").ghost).toBe("only");
    expect(loadJobsSearchParams("?ghost=hide").ghost).toBe("hide");
    expect(loadJobsSearchParams("?ghost=yes").ghost).toBeNull();
    expect(loadJobsSearchParams("?ghost=all").ghost).toBe("all");
    expect(countActiveFilters(loadJobsSearchParams("?ghost=all&minScore=70"))).toBe(1);
    expect(hasActiveFilters(loadJobsSearchParams("?ghost=all"))).toBe(false);
    expect(countActiveFilters(loadJobsSearchParams("?ghost=hide&minScore=70"))).toBe(2);
    expect(jobsListHref({ ghost: "only", page: 1 })).toBe("/jobs?ghost=only");
  });

  it("while the check is off is ignored but kept", () => {
    const params = loadJobsSearchParams("?ghost=only");
    expect(hasActiveFilters(params, { ignore: ["ghost"] as const })).toBe(false);
    expect(jobsListHref({ ...params, page: 1 })).toContain("ghost=only");
  });

  it("a saved view keeps only and hide, never all", () => {
    expect(viewFiltersFromParams(loadJobsSearchParams("?ghost=hide"))).toEqual({ ghost: "hide" });
    expect(viewFiltersFromParams(loadJobsSearchParams("?ghost=all"))).toEqual({});
    expect(viewFiltersToParams({ ghost: "only" }).ghost).toBe("only");
    expect(viewFiltersToParams({}).ghost).toBeNull();
  });
});

describe("jobs sort direction", () => {
  it("reads the sort direction: asc / desc, anything else is unset; it is not a filter", () => {
    expect(loadJobsSearchParams("?sort=salary&dir=asc")).toMatchObject({ sort: "salary", dir: "asc" });
    expect(loadJobsSearchParams("?sort=salary&dir=up").dir).toBeNull();
    expect(loadJobsSearchParams("?dir=desc").sort).toBeNull();
    expect(hasActiveFilters(loadJobsSearchParams("?dir=asc"))).toBe(false);
    expect(countActiveFilters(loadJobsSearchParams("?sort=salary&dir=asc"))).toBe(0);
    // old links keep their meaning: no direction = the default
    for (const sort of ["rank", "posted", "first_seen"] as const) expect(loadJobsSearchParams(`?sort=${sort}`)).toMatchObject({ sort, dir: null });
    expect(jobsListHref({ sort: "salary", dir: "asc", page: 1 })).toBe("/jobs?sort=salary&dir=asc");
    expect(jobsListHref({ sort: "rank", dir: null, page: 1 })).toBe("/jobs?sort=rank");
  });
});
