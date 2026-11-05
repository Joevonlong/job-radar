// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadQueryPlaces } from "@/lib/channels/query-places";
import { resetConfigCache } from "@/lib/config";

import { makeTempConfig, writeLocationSettings, type TempConfig } from "../config/helpers";

describe("loadQueryPlaces", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig();
    writeLocationSettings(tmp, { home_city: "Testhome", places: [{ place: "Addedtown", relocate: true }], workplace: ["onsite"] });
  });
  afterEach(() => tmp.cleanup());

  const breakPreferences = (): void => fs.writeFileSync(path.join(tmp.profileDir, "preferences.yaml"), "places: [not closed\n");

  it("keeps the last good settings when a hand edit breaks the file", () => {
    const good = loadQueryPlaces();
    breakPreferences();
    expect(good.preferences.home_city).toBe("Testhome");
    expect(loadQueryPlaces().preferences).toEqual(good.preferences);
  });

  it("throws when the file was never readable", () => {
    breakPreferences();
    resetConfigCache();
    expect(() => loadQueryPlaces()).toThrow();
  });
});
