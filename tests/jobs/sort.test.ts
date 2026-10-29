import { describe, expect, it } from "vitest";

import { JOB_SCOPES, JOB_SORTS } from "@/lib/jobs/constants";
import { resolveJobScope } from "@/lib/jobs/scope";
import { loadJobsSearchParams } from "@/lib/jobs/search-params";
import { columnOfSort, dirParam, effectiveDir, flipDir, nextSortParams, resolveSort } from "@/lib/jobs/sort";

describe("resolved list sort", () => {
  const fromUrl = (query: string) => {
    const params = loadJobsSearchParams(query);
    return resolveSort({ sort: params.sort, q: params.q, scope: resolveJobScope(params.scope, params.status) });
  };

  it("honours every explicit sort ahead of search text and scope defaults", () => {
    for (const sort of JOB_SORTS) for (const scope of JOB_SCOPES) {
      expect(resolveSort({ sort, q: "engineer", scope })).toBe(sort);
    }
  });

  it("defaults search to relevance, then archive to last listed and other scopes to rank", () => {
    for (const q of [null, "", "   "]) for (const scope of JOB_SCOPES) {
      expect(resolveSort({ sort: null, q, scope })).toBe(scope === "archive" ? "last_listed" : "rank");
    }
    expect(fromUrl("?scope=archive")).toBe("last_listed");
    expect(fromUrl("?scope=archive&q=engineer&sort=invalid")).toBe("relevance");
    expect(fromUrl("?q=engineer")).toBe("relevance");
    expect(fromUrl("?q=engineer&sort=rank")).toBe("rank");
    expect(fromUrl("?q=engineer&dir=asc")).toBe("relevance");
    expect(fromUrl("?sort=invalid")).toBe("rank");
  });

  it("distinguishes explicit rank from absent sort in the archive", () => {
    expect(fromUrl("?scope=archive&sort=rank")).toBe("rank");
    expect(fromUrl("?scope=archive")).toBe("last_listed");
    expect(loadJobsSearchParams("").sort).toBeNull();
    expect(loadJobsSearchParams("?sort=rank").sort).toBe("rank");
  });

  it("relevance is descending regardless of dir and belongs to no column", () => {
    for (const dir of [null, undefined, "asc", "desc"] as const) expect(effectiveDir("relevance", dir)).toBe("desc");
    expect(dirParam("relevance", "asc")).toBeNull();
    expect(dirParam("relevance", "desc")).toBeNull();
    expect(columnOfSort("relevance")).toBeNull();
    expect(nextSortParams("score", { sort: "relevance", dir: "asc" })).toEqual({ sort: "rank", dir: null, page: 1 });
  });

  it("last listed has descending direction and no column head", () => {
    expect(effectiveDir("last_listed", null)).toBe("desc");
    expect(columnOfSort("last_listed")).toBeNull();
    expect(nextSortParams("score", { sort: "last_listed", dir: null })).toEqual({ sort: "rank", dir: null, page: 1 });
  });
});

describe("column-head sort", () => {
  it("reads a missing direction as the sort's default (descending for every sort)", () => {
    expect(effectiveDir("rank", null)).toBe("desc");
    expect(effectiveDir("salary", undefined)).toBe("desc");
    expect(effectiveDir("first_seen", "asc")).toBe("asc");
    expect(flipDir("asc")).toBe("desc");
  });

  it("a click on the current column flips the direction, back to page 1", () => {
    expect(nextSortParams("salary", { sort: "salary", dir: null })).toEqual({ sort: "salary", dir: "asc", page: 1 });
    // back to the default direction: the URL leaves it out
    expect(nextSortParams("salary", { sort: "salary", dir: "asc" })).toEqual({ sort: "salary", dir: null, page: 1 });
    expect(nextSortParams("score", { sort: "rank", dir: null })).toEqual({ sort: "rank", dir: "asc", page: 1 });
  });

  it("a click on another column takes that column with its default direction", () => {
    expect(nextSortParams("fresh", { sort: "salary", dir: "asc" })).toEqual({ sort: "first_seen", dir: null, page: 1 });
    expect(nextSortParams("salary", { sort: "posted", dir: "asc" })).toEqual({ sort: "salary", dir: null, page: 1 });
  });

  it("maps sorts to columns; publication time has no column", () => {
    expect(columnOfSort("rank")).toBe("score");
    expect(columnOfSort("salary")).toBe("salary");
    expect(columnOfSort("first_seen")).toBe("fresh");
    expect(columnOfSort("posted")).toBeNull();
    expect(dirParam("rank", "desc")).toBeNull();
    expect(dirParam("rank", "asc")).toBe("asc");
  });
});
