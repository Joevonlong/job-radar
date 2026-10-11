// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadModelCatalog, resetModelCatalogMemo } from "@/lib/ai/catalog";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let temp: TempConfig;
beforeEach(() => {
  temp = makeTempConfig();
  resetModelCatalogMemo();
});
afterEach(() => {
  temp.cleanup();
  resetModelCatalogMemo();
});

describe("loadModelCatalog", () => {
  it("returns null at once for a broken models.yaml (not the last good value) and recovers when it is fixed", () => {
    // models.yaml is a shipped file, read from the defaults directory
    const file = path.join(temp.defaultsDir, "models.yaml");
    const good = fs.readFileSync(file, "utf8");
    expect(loadModelCatalog()?.providers.deepseek.models.length).toBeGreaterThan(0);
    fs.writeFileSync(file, good.replace(/\n\s+price: \{ input_per_mtok: 0\.3, output_per_mtok: 1\.2 \}/, ""));
    expect(loadModelCatalog()).toBeNull();
    fs.writeFileSync(file, good + "\n# touched\n");
    expect(loadModelCatalog()?.providers.deepseek.models.length).toBeGreaterThan(0);
    fs.rmSync(file);
    expect(loadModelCatalog()).toBeNull();
  });
});
