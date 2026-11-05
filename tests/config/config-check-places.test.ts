// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTempConfig, writeLocationSettings, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

/** `pnpm config:check` names what search.yaml's old keys and the location settings disagree on, in both directions. */
describe("pnpm config:check on the location settings", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig();
    writeLocationSettings(tmp, { home_city: "Testhome", places: [{ place: "Addedtown", relocate: true }], workplace: ["onsite"] });
  });
  afterEach(() => tmp.cleanup());

  it("warns about what search.yaml lists and places lack, and what places add", () => {
    const file = path.join(tmp.configDir, "search.yaml");
    const search = parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, stringify({ ...search, locations: ["Testhome", "Oldtown"] }));
    const run = runConfigScript(tmp, "config-check.ts");
    expect(run.out).toContain("Oldtown not in preferences.yaml places");
    expect(run.out).toContain("Addedtown searched now");
  });

  it("stays quiet about it without the old keys", () => {
    const run = runConfigScript(tmp, "config-check.ts");
    expect(run.out).not.toContain("searched now");
    expect(run.out).not.toContain("not in preferences.yaml places");
  });
});
