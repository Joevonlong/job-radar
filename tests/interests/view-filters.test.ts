// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSerializer } from "nuqs/server";

import { viewFiltersSchema, type SavedView } from "@/lib/config/schemas/interests";
import { jobsSearchParsers, loadJobsSearchParams } from "@/lib/jobs/search-params";
import { activeFilterKeys, filterValues, hasViewFilters, resolveTodayView, sameFilters, slugifyViewId, todayHref, viewDateField, viewFiltersFromParams, viewFiltersToParams, VIEW_FILTER_KEYS } from "@/lib/interests/view-filters";

const serialize = createSerializer(jobsSearchParsers);
const loadJobsSearchParamsSync = (query: string) => loadJobsSearchParams(query);

const view = (id: string, over: Partial<SavedView> = {}): SavedView => ({ id, name: id, default: false, filters: { city: "Berlin" }, ...over });

describe("view filters <-> /jobs URL state", () => {
  it("never reads or writes scope, archive reasons and relists, preserving legacy status-only views", () => {
    const params = loadJobsSearchParams("?scope=archive&reason=gone&reason=manual&status=closed&sort=last_listed&relisted=true");
    expect(viewFiltersFromParams(params)).toEqual({ status: "closed" });
    const view = { status: "closed" as const, scope: "archive", reason: ["gone"], relisted: true };
    const urlParams = viewFiltersToParams(view);
    expect(urlParams).not.toHaveProperty("scope");
    expect(urlParams).not.toHaveProperty("reason");
    expect(urlParams).not.toHaveProperty("relisted");
    expect(serialize("/jobs", urlParams)).toBe("/jobs?status=closed");
    // keys a view does not store are dropped on read, never kept
    expect(viewFiltersSchema.parse(view)).toEqual({ status: "closed" });
  });
  it("keeps only the filters that are set", async () => {
    const params = await loadJobsSearchParams("?q=%20rust%20&city=Berlin&workplace=remote&salary=true&hideLang=false&sort=posted&page=3");
    expect(viewFiltersFromParams(params)).toEqual({ q: "rust", city: "Berlin", workplace: "remote", salary: true });
  });

  it("an empty set of params gives no filters", async () => {
    const filters = viewFiltersFromParams(await loadJobsSearchParams(""));
    expect(filters).toEqual({});
    expect(hasViewFilters(filters)).toBe(false);
  });

  it("round-trips through the /jobs URL: the view opens with exactly its filters (no sort, no page)", async () => {
    const filters = { q: "ml engineer", source: "linkedin", city: "München", workplace: "hybrid", status: "active", from: "2026-01-01", to: "2026-02-01", salary: true, filtered: true, hideLang: true, high: true } as const;
    const url = serialize("/jobs", viewFiltersToParams(filters));
    expect(url).not.toMatch(/sort=|page=/);
    const query = url.slice(url.indexOf("?"));
    expect(viewFiltersFromParams(await loadJobsSearchParams(query))).toEqual(filters);
  });

  it("carries application status, minimum score and minimum salary through a saved view", async () => {
    const params = await loadJobsSearchParams("?app=archived&app=interested&minScore=75&minSalary=70000&city=Berlin");
    // statuses are stored in pipeline order, whatever order the URL had
    const filters = viewFiltersFromParams(params);
    expect(filters).toEqual({ city: "Berlin", app: ["interested", "archived"], minScore: 75, minSalary: 70000 });
    const url = serialize("/jobs", viewFiltersToParams(filters));
    expect(url).toContain("app=interested&app=archived");
    expect(viewFiltersFromParams(await loadJobsSearchParams(url.slice(url.indexOf("?"))))).toEqual(filters);
    // a view without them opens without them
    expect(serialize("/jobs", viewFiltersToParams({ city: "Berlin" }))).toBe("/jobs?city=Berlin");
    // a minimum of 0 is still a filter
    expect(viewFiltersFromParams(loadJobsSearchParamsSync("?minScore=0"))).toEqual({ minScore: 0 });
  });

  it("compares list and number filters by value", () => {
    expect(sameFilters({ app: ["new", "applied"], minScore: 70 }, { minScore: 70, app: ["new", "applied"] })).toBe(true);
    expect(sameFilters({ app: ["new"] }, { app: ["new", "applied"] })).toBe(false);
    expect(sameFilters({ minSalary: 70000 }, { minSalary: 80000 })).toBe(false);
    expect(activeFilterKeys({ app: ["new"], minScore: 0, minSalary: undefined })).toEqual(["app", "minScore"]);
  });

  it("lists the active keys in a fixed order and compares filters regardless of key order", () => {
    expect(activeFilterKeys({ high: true, city: "Berlin", salary: undefined })).toEqual(["city", "high"]);
    expect(sameFilters({ city: "Berlin", high: true }, { high: true, city: "Berlin" })).toBe(true);
    expect(sameFilters({ city: "Berlin" }, { city: "Berlin", high: true })).toBe(false);
  });
});

describe("slugifyViewId", () => {
  it("makes a valid id and avoids taken ones", () => {
    expect(slugifyViewId("High pay + English + Berlin", [])).toBe("high-pay-english-berlin");
    expect(slugifyViewId("High pay", ["high-pay", "high-pay-2"])).toBe("high-pay-3");
    expect(slugifyViewId("München Köln", [])).toBe("munchen-koln");
    expect(slugifyViewId("高薪信号", [])).toBe("view");
    expect(slugifyViewId("高薪信号", ["view"])).toBe("view-2");
    expect(slugifyViewId("  Ünïcode — name!! ", [])).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(slugifyViewId("x".repeat(100), [])).toHaveLength(40);
  });
});

describe("resolveTodayView", () => {
  const none = { filtered: null, hideLang: null, high: null };
  const views = [view("a"), view("b", { default: true, filters: { hideLang: true, from: "2026-01-01", city: "Köln" } })];

  it("applies the default view when the URL says nothing", () => {
    const state = resolveTodayView(views, null, none);
    expect(state.active?.id).toBe("b");
    expect(state.implicit).toBe(true);
    expect(state.filters).toEqual({ hideLang: true, city: "Köln" }); // dates never apply to Today
  });

  it("view=all shows everything, view=<id> that view, an unknown id nothing special", () => {
    expect(resolveTodayView(views, "all", none).active).toBeNull();
    expect(resolveTodayView(views, "a", none)).toMatchObject({ active: { id: "a" }, implicit: false, filters: { city: "Berlin" } });
    expect(resolveTodayView(views, "zzz", none).active).toBeNull();
  });

  it("an explicit toggle in the URL wins: no default view, and on a view it overrides the view's value", () => {
    expect(resolveTodayView(views, null, { ...none, filtered: true })).toMatchObject({ active: null, filters: { filtered: true } });
    expect(resolveTodayView(views, "b", { ...none, hideLang: false }).filters).toEqual({ city: "Köln" });
    expect(resolveTodayView(views, "a", { ...none, high: true }).filters).toEqual({ city: "Berlin", high: true });
  });

  it("without views there is nothing to apply", () => {
    expect(resolveTodayView([], null, none)).toEqual({ active: null, implicit: false, filters: {} });
  });
});

describe("todayHref", () => {
  const off = { filtered: false, hideLang: false, high: false };
  it("is `/` without view and toggles", () => {
    expect(todayHref({ view: null, toggles: off })).toBe("/");
  });
  it("carries the view and only the toggles that differ from it", () => {
    expect(todayHref({ view: "all", toggles: off })).toBe("/?view=all");
    expect(todayHref({ view: null, toggles: { ...off, filtered: true } })).toBe("/?filtered=true");
    expect(todayHref({ view: "b", toggles: { ...off, hideLang: true }, viewFilters: { hideLang: true } })).toBe("/?view=b");
    expect(todayHref({ view: "b", toggles: off, viewFilters: { hideLang: true } })).toBe("/?view=b&hideLang=false");
    expect(todayHref({ view: "a", toggles: { ...off, high: true }, viewFilters: { city: "Berlin" } })).toBe("/?view=a&high=true");
  });
});

describe("multi-value filters in saved views", () => {
  it("writes one value as a scalar (the file as before) and several as a list; app is always a list", async () => {
    expect(viewFiltersFromParams(await loadJobsSearchParams("?city=Berlin&workplace=remote&app=new"))).toEqual({ city: "Berlin", workplace: "remote", app: ["new"] });
    expect(viewFiltersFromParams(await loadJobsSearchParams("?city=Berlin&city=M%C3%BCnchen&workplace=remote&workplace=hybrid"))).toEqual({ city: ["Berlin", "München"], workplace: ["hybrid", "remote"] });
  });

  it("writes companies as a list, also a single one, and opens them again unchanged", async () => {
    const one = viewFiltersFromParams(await loadJobsSearchParams("?company=Zalando"));
    expect(one).toEqual({ company: ["Zalando"] });
    const two = viewFiltersFromParams(await loadJobsSearchParams("?company=Zalando&company=N26&city=Berlin"));
    expect(two).toEqual({ city: "Berlin", company: ["Zalando", "N26"] });
    expect(serialize("/jobs", viewFiltersToParams(two))).toBe("/jobs?city=Berlin&company=Zalando&company=N26");
    expect(viewFiltersFromParams(viewFiltersToParams(two))).toEqual(two);
    // a view without companies writes no company key
    expect(viewFiltersFromParams(await loadJobsSearchParams("?city=Berlin"))).not.toHaveProperty("company");
    expect(viewFiltersToParams({ city: "Berlin" }).company).toEqual([]);
    expect(sameFilters({ company: ["Zalando", "N26"] }, { company: ["Zalando", "N26"] })).toBe(true);
    expect(activeFilterKeys({ company: ["Zalando"] })).toEqual(["company"]);
  });

  it("keeps the key order of the file: q, source, city, workplace, ..., app, then the rest", async () => {
    const filters = viewFiltersFromParams(await loadJobsSearchParams("?minScore=70&app=new&city=Berlin&q=x&source=ats&source=xing"));
    expect(Object.keys(filters)).toEqual(["q", "source", "city", "app", "minScore"]);
  });

  it("opens a scalar and a one-element list view the same way, and a list with all its values", () => {
    const serializeUrl = (filters: SavedView["filters"]) => serialize("/jobs", viewFiltersToParams(filters));
    expect(serializeUrl({ city: "Berlin" })).toBe("/jobs?city=Berlin");
    expect(serializeUrl({ city: ["Berlin"] })).toBe("/jobs?city=Berlin");
    expect(serializeUrl({ city: ["Berlin", "München"], workplace: ["remote", "hybrid"] })).toBe("/jobs?city=Berlin&city=München&workplace=remote&workplace=hybrid");
  });

  it("filterValues reads a scalar as a one-element list and absent as empty", () => {
    expect(filterValues({ city: "Berlin" }, "city")).toEqual(["Berlin"]);
    expect(filterValues({ city: ["Berlin", "München"] }, "city")).toEqual(["Berlin", "München"]);
    expect(filterValues({}, "workplace")).toEqual([]);
    expect(filterValues({ workplace: "remote" }, "workplace")).toEqual(["remote"]);
  });

  it("sameFilters treats \"Berlin\" and [\"Berlin\"] as the same, and enum lists in any order", () => {
    expect(sameFilters({ city: "Berlin" }, { city: ["Berlin"] })).toBe(true);
    expect(sameFilters({ workplace: ["remote", "hybrid"] }, { workplace: ["hybrid", "remote"] })).toBe(true);
    expect(sameFilters({ city: ["Berlin", "München"] }, { city: ["Berlin"] })).toBe(false);
    expect(sameFilters({ city: ["Berlin", "München"] }, { city: ["München", "Berlin"] })).toBe(false);
  });

  it("a multi-value view still counts as having filters", () => {
    expect(hasViewFilters({ city: ["Berlin", "München"] })).toBe(true);
    expect(activeFilterKeys({ city: ["Berlin"], source: "ats" })).toEqual(["source", "city"]);
  });
});

it("never saves country or search scope and never adds either to view URLs", () => {
  const params = loadJobsSearchParams("?q=AI&country=DE&searchIn=all");
  const view = viewFiltersFromParams(params);
  expect(view).toEqual({ q: "AI" });
  expect(viewFiltersFromParams(loadJobsSearchParams("?country=DE&searchIn=all"))).toEqual({});
  const restored = viewFiltersToParams(view);
  expect(restored).not.toHaveProperty("country");
  expect(restored).not.toHaveProperty("searchIn");
});

describe("dates in saved views", () => {
  const fromUrl = (query: string) => viewFiltersFromParams(loadJobsSearchParams(query));

  it("saves custom dates read as first seen (old links, first-seen picks) as before, without dateBy: first seen is what a view means by default", () => {
    expect(fromUrl("?from=2026-10-01&to=2026-10-15")).toEqual({ from: "2026-10-01", to: "2026-10-15" });
    expect(fromUrl("?from=2026-10-01&dateBy=seen")).toEqual({ from: "2026-10-01" });
  });

  it("saves a quick range as its token, with dateBy only for the posted date", () => {
    expect(fromUrl("?city=Berlin&within=7d&dateBy=posted")).toEqual({ city: "Berlin", within: "7d", dateBy: "posted" });
    expect(fromUrl("?within=month&dateBy=seen")).toEqual({ within: "month" });
    expect(fromUrl("?within=30d")).toEqual({ within: "30d" });
  });

  it("saves custom dates compared by the posted date with their dateBy", () => {
    expect(fromUrl("?from=2026-10-01&to=2026-10-15&dateBy=posted")).toEqual({ from: "2026-10-01", to: "2026-10-15", dateBy: "posted" });
  });

  it("lets a quick range win over custom dates in a hand-written link, as the list does", () => {
    expect(fromUrl("?within=7d&from=2026-10-01&dateBy=seen")).toEqual({ within: "7d" });
  });

  it("never saves dateBy alone: without a date condition it filters nothing", () => {
    expect(fromUrl("?dateBy=posted")).toEqual({});
    expect(fromUrl("?city=Berlin&dateBy=posted")).toEqual({ city: "Berlin" });
    expect(hasViewFilters(fromUrl("?dateBy=posted"))).toBe(false);
  });

  it("holds within among the view filters, and dateBy in none of the lists", () => {
    expect(VIEW_FILTER_KEYS).toContain("within");
    expect(VIEW_FILTER_KEYS).not.toContain("dateBy");
    expect(activeFilterKeys({ within: "7d", dateBy: "posted" })).toEqual(["within"]);
    expect(hasViewFilters({ within: "7d" })).toBe(true);
  });

  it("opens a view with its quick range in the /jobs link, counted from then, and says what it compares", () => {
    expect(serialize("/jobs", viewFiltersToParams({ within: "7d", dateBy: "posted" }))).toBe("/jobs?within=7d&dateBy=posted");
    expect(serialize("/jobs", viewFiltersToParams({ within: "month" }))).toBe("/jobs?within=month&dateBy=seen");
    expect(viewFiltersToParams({ within: "7d" }).within).toEqual({ kind: "days", days: 7 });
  });

  it("opens an old view (custom dates, no dateBy) as first seen, and a view without dates without dateBy", () => {
    expect(serialize("/jobs", viewFiltersToParams({ from: "2026-10-01" }))).toBe("/jobs?from=2026-10-01&dateBy=seen");
    expect(serialize("/jobs", viewFiltersToParams({ from: "2026-10-01", dateBy: "posted" }))).toBe("/jobs?from=2026-10-01&dateBy=posted");
    expect(serialize("/jobs", viewFiltersToParams({ city: "Berlin" }))).toBe("/jobs?city=Berlin");
    expect(viewFiltersToParams({ city: "Berlin" })).toMatchObject({ within: null, dateBy: null });
  });

  it("round-trips: a link saved as a view opens as the same link", () => {
    for (const query of ["?within=7d&dateBy=posted&city=Berlin", "?within=month&dateBy=seen", "?from=2026-10-01&to=2026-10-15&dateBy=posted", "?from=2026-10-01&dateBy=seen"]) {
      const params = loadJobsSearchParams(query);
      const reopened = viewFiltersToParams(viewFiltersFromParams(params));
      expect(serialize("/jobs", reopened), query).toBe(serialize("/jobs", params));
    }
  });

  it("tells views that differ only by what the date compares apart", () => {
    expect(sameFilters({ within: "7d", dateBy: "posted" }, { within: "7d", dateBy: "seen" })).toBe(false);
    expect(sameFilters({ within: "7d" }, { within: "7d", dateBy: "seen" })).toBe(true);
    expect(sameFilters({ within: "7d" }, { within: "14d" })).toBe(false);
    expect(sameFilters({ city: "Berlin", dateBy: "posted" }, { city: "Berlin" })).toBe(true);
    expect(viewDateField({ from: "2026-10-01" })).toBe("seen");
    expect(viewDateField({ city: "Berlin", dateBy: "posted" })).toBeNull();
  });

  it("keeps the dates of a view out of Today", () => {
    const today = (filters: SavedView["filters"]) => resolveTodayView([view("a", { filters })], "a", { filtered: null, hideLang: null, high: null }).filters;
    expect(today({ city: "Berlin", from: "2026-10-01" })).toEqual({ city: "Berlin" });
    expect(today({ city: "Berlin", within: "7d", dateBy: "posted" })).toEqual({ city: "Berlin" });
    expect(today({ city: "Berlin", from: "2026-10-01", to: "2026-10-15", dateBy: "seen" })).toEqual({ city: "Berlin" });
  });
});

