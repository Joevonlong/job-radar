import { describe, expect, it } from "vitest";

import { columnOfSort, dirParam, effectiveDir, flipDir, nextSortParams } from "@/lib/jobs/sort";

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
