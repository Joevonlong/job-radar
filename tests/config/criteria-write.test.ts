// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, writeConfig } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig | null = null;
afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

describe("ai.yaml scoring.criteria", () => {
  it("reads a file without criteria as empty lists, and saving it does not add the key (a rollback keeps working)", async () => {
    tmp = makeTempConfig();
    const file = path.join(tmp.configDir, "ai.yaml");
    expect(fs.readFileSync(file, "utf8")).not.toContain("criteria");
    const ai = loadConfig("ai");
    expect(ai.scoring.criteria).toEqual({ priorities: [], dealbreakers: [], nice_to_have: [] });
    await writeConfig("ai", { ...ai, scoring: { ...ai.scoring, jd_max_chars: ai.scoring.jd_max_chars + 1 } });
    expect(fs.readFileSync(file, "utf8")).not.toContain("criteria");
    await writeConfig("ai", { ...ai, scoring: { ...ai.scoring, criteria: { priorities: ["Applied ML"], dealbreakers: [], nice_to_have: [] } } });
    expect(fs.readFileSync(file, "utf8")).toContain("Applied ML");
    expect(loadConfig("ai").scoring.criteria.priorities).toEqual(["Applied ML"]);
  });
});
