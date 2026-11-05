// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildQueries, buildSweepQuery, capQuery, isRemotePlaceQuery, queriesForChannels, queryId, windowHoursFor } from "@/lib/channels/query";
import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../config/helpers";
import { shippedSearch, testPlaces } from "./helpers";

describe("queriesForChannels", () => {
  const places = testPlaces({ places: [{ place: "NL", relocate: false }] });
  const queries = buildQueries(shippedSearch(), { ...places, preferences: { ...places.preferences, places: [{ place: "Netherlands", relocate: false }] } }, "manual");

  it("takes place queries from a unit whose channels cannot send one, and keeps every scope query", () => {
    const withoutPlaces = queriesForChannels(queries, [{ supportsRemotePlaces: false }]);
    expect(queries.some(isRemotePlaceQuery)).toBe(true);
    expect(withoutPlaces.some(isRemotePlaceQuery)).toBe(false);
    expect(withoutPlaces).toEqual(queries.filter((query) => !isRemotePlaceQuery(query)));
    expect(withoutPlaces.some((query) => query.remote && query.location === null)).toBe(true);
  });

  it("keeps them when any channel of the unit can", () => {
    expect(queriesForChannels(queries, [{ supportsRemotePlaces: false }, {}])).toEqual(queries);
  });
});

describe("buildQueries", () => {
  const search = shippedSearch();
  const places = testPlaces();

  it("builds keyword groups x locations plus one remote query per group", () => {
    const queries = buildQueries(search, places, "weekday_morning");
    // 3 groups x 2 locations + 3 remote
    expect(queries).toHaveLength(9);
    expect(queries.filter((q) => q.remote)).toHaveLength(3);
    expect(queries.filter((q) => q.remote).every((q) => q.location === null)).toBe(true);
    expect(queries.filter((q) => !q.remote).map((q) => `${q.keywordGroup}/${q.location}`)).toEqual([
      "engineering/Berlin",
      "engineering/München",
      "fde_solutions/Berlin",
      "fde_solutions/München",
      "german/Berlin",
      "german/München",
    ]);
    const engineering = queries[0];
    expect(engineering?.keywords).toEqual(search.keyword_groups.engineering);
    expect(engineering?.maxResults).toBe(search.max_per_group_per_location);
  });

  it("sets remoteScope from the location settings on remote queries only", () => {
    const queries = buildQueries(search, places, "manual");
    expect(queries.filter((q) => q.remote).every((q) => q.remoteScope === "home_country")).toBe(true);
    expect(queries.filter((q) => !q.remote).every((q) => q.remoteScope === null)).toBe(true);
    const anywhere = buildQueries(search, testPlaces({ places: [{ place: "Worldwide", relocate: false }] }), "manual").filter((q) => q.remote);
    expect(anywhere.every((q) => q.remoteScope === "worldwide")).toBe(true);
    // the scope is part of the id: a changed scope is a different query
    const euAny = buildQueries(search, testPlaces({ places: [{ place: "eu", relocate: false }] }), "manual").filter((q) => q.remote);
    expect(euAny.map((q) => q.id)).not.toEqual(anywhere.map((q) => q.id));
    expect(euAny.map((q) => q.id)).not.toEqual(queries.filter((q) => q.remote).map((q) => q.id));
  });

  it("has no remote queries when remote work isn't wanted, and no keyword queries without location settings", () => {
    const queries = buildQueries(search, testPlaces({ workplace: ["onsite", "hybrid"] }), "manual");
    expect(queries).toHaveLength(6);
    expect(queries.some((q) => q.remote)).toBe(false);
    expect(buildQueries(search, null, "manual")).toEqual([]);
  });

  it("takes the look-back window from the cycle kind", () => {
    expect(buildQueries(search, places, "weekday_morning")[0]?.windowHours).toBe(24);
    expect(buildQueries(search, places, "weekday_evening")[0]?.windowHours).toBe(10);
    expect(buildQueries(search, places, "weekend")[0]?.windowHours).toBe(24);
  });

  it("uses the replaced cycle's window for a catch-up, and the longest window otherwise", () => {
    expect(windowHoursFor("catchup", search, "weekday_evening")).toBe(10);
    expect(windowHoursFor("catchup", search, null)).toBe(24);
    expect(windowHoursFor("manual", search)).toBe(24);
    const custom = { ...search, window_hours: { morning: 12, evening: 6, weekend: 30 } };
    expect(windowHoursFor("manual", custom)).toBe(30);
    expect(windowHoursFor("weekday_evening", custom, "weekend")).toBe(6);
  });

  it("gives every query a stable id that does not depend on window or limits", () => {
    const morning = buildQueries(search, places, "weekday_morning");
    const evening = buildQueries(search, places, "weekday_evening");
    expect(morning.map((q) => q.id)).toEqual(evening.map((q) => q.id));
    expect(new Set(morning.map((q) => q.id)).size).toBe(morning.length);
    expect(morning[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    const raw = structuredClone(shippedYaml("search.yaml"));
    raw.max_per_group_per_location = 5;
    const smaller = configRegistry.search.schema.parse(raw);
    expect(buildQueries(smaller, places, "weekday_morning").map((q) => q.id)).toEqual(morning.map((q) => q.id));
  });

  it("changes the id when keywords or location change, but not with keyword order", () => {
    const base = { keywords: ["a", "b"], keywordGroup: "g", location: "Berlin", remote: false, remoteScope: null };
    expect(queryId({ ...base, keywords: ["b", "a"] })).toBe(queryId(base));
    expect(queryId({ ...base, keywords: ["a", "c"] })).not.toBe(queryId(base));
    expect(queryId({ ...base, location: "München" })).not.toBe(queryId(base));
    expect(queryId({ ...base, location: null, remote: true, remoteScope: "home_country" })).not.toBe(queryId(base));
    expect(queryId({ ...base, location: null, remote: true, remoteScope: { region: ["eu"] } })).not.toBe(
      queryId({ ...base, location: null, remote: true, remoteScope: "home_country" }),
    );
  });

  it("builds a keyword-less sweep query and caps results per channel", () => {
    const sweep = buildSweepQuery(search, "weekday_evening");
    expect(sweep).toMatchObject({ keywords: [], keywordGroup: "*", location: null, remote: false, remoteScope: null, windowHours: 10 });
    const query = buildQueries(search, places, "manual")[0];
    if (!query) throw new Error("no query");
    expect(capQuery(query, 10).maxResults).toBe(10);
    expect(capQuery(query, 500)).toBe(query);
    expect(capQuery(query, 10).id).toBe(query.id);
    expect(capQuery(sweep, 500).maxResults).toBe(500);
  });
});
