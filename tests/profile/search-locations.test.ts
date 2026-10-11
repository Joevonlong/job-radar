// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reloadConfig } from "@/lib/config";
import { sameLocations } from "@/lib/profile/same-locations";
import { syncSearchLocations } from "@/lib/profile/search-locations";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

describe("sameLocations", () => {
  it("ignores case, order, blanks and repeats", () => {
    expect(sameLocations(["Austin", "Dallas"], ["dallas", " Austin ", "Austin"])).toBe(true);
    expect(sameLocations(["Austin"], ["Hamburg", "Köln"])).toBe(false);
  });
});

describe("syncSearchLocations", () => {
  it("replaces the search cities and nothing else", async () => {
    const before = reloadConfig("search");
    expect(await syncSearchLocations(["Austin", " austin ", "Dallas"])).toEqual({ status: "done", locations: ["Austin", "Dallas"] });
    const after = reloadConfig("search");
    expect(after.locations).toEqual(["Austin", "Dallas"]);
    expect(after.keyword_groups).toEqual(before.keyword_groups);
    expect(after.remote_scope).toEqual(before.remote_scope);
  });

  it("refuses an empty or malformed list and leaves the file alone", async () => {
    const before = reloadConfig("search").locations;
    expect(await syncSearchLocations([])).toEqual({ status: "error", error: "invalid" });
    expect(await syncSearchLocations(["  "])).toEqual({ status: "error", error: "invalid" });
    expect(await syncSearchLocations("Austin")).toEqual({ status: "error", error: "invalid" });
    expect(reloadConfig("search").locations).toEqual(before);
  });
});
