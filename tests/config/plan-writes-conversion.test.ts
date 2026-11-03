// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEPLOY_WRITE_PLAN, legacyFormatVersion, planConfigWrites } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
  // a whole file with nothing structural left to do: only the conversion is pending
  const text = fs.readFileSync(path.join(temp.defaultsDir, "ui.yaml"), "utf8").replace(/^config_version: \d+/m, `config_version: ${legacyFormatVersion("ui")}`);
  fs.writeFileSync(path.join(temp.configDir, "ui.yaml"), text);
});
afterEach(() => temp.cleanup());

describe("a file with only the conversion pending", () => {
  it("the deploy plan counts it", () => {
    expect(DEPLOY_WRITE_PLAN.convertOverlays).toBe(true);
    const plan = planConfigWrites({ convertOverlays: true, init: false });
    expect(plan.problems).toEqual([]);
    expect(plan.writes).toMatchObject([{ kind: "convert", name: "ui", from: legacyFormatVersion("ui"), to: legacyFormatVersion("ui") + 1 }]);
  });

  it("a plain plan does not", () => {
    expect(planConfigWrites({ convertOverlays: false, init: false }).writes).toEqual([]);
  });
});
