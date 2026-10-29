// @vitest-environment node
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { ConfigError, parseConfigText } from "@/lib/config";
import { configErrorDigest, configFileFromDigest } from "@/lib/config/error-digest";
import { pipelineBoardSchema } from "@/lib/config/schemas/pipeline-board";

const fixture = () => ({
  config_version: 1,
  density: { default: "comfortable", remember_days: 30 },
  compact: { title_lines: 3, next_action_lines: 2 },
  layout: { column_min_width_rem: 15.5, board_min_height_rem: 28.5 },
});

function paths(input: unknown): string[] {
  try {
    parseConfigText("pipelineBoard", stringify(input), "pipeline-board.yaml");
    return [];
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error.issues.map((issue) => issue.path);
  }
}

describe("pipeline board config", () => {
  it("accepts a complete config with fractional layout sizes and both densities", () => {
    expect(pipelineBoardSchema.safeParse(fixture()).success).toBe(true);
    expect(paths({ ...fixture(), density: { default: "compact", remember_days: 1 } })).toEqual([]);
    expect(configFileFromDigest(configErrorDigest("pipelineBoard"))).toBe("pipeline-board.yaml");
  });

  it.each([
    ["density", "default"], ["density", "remember_days"],
    ["compact", "title_lines"], ["compact", "next_action_lines"],
    ["layout", "column_min_width_rem"], ["layout", "board_min_height_rem"],
  ] as const)("requires %s.%s", (group, key) => {
    const input = fixture();
    Reflect.deleteProperty(input[group], key);
    expect(paths(input)).toContain(`${group}.${key}`);
  });

  it.each(["density", "compact", "layout"] as const)("requires the %s block and rejects unknown nested keys", (group) => {
    const missing = fixture();
    Reflect.deleteProperty(missing, group);
    expect(paths(missing)).toContain(group);
    expect(paths({ ...fixture(), [group]: { ...fixture()[group], typo: 1 } })).toContain(`${group}.typo`);
  });

  it("rejects unknown root keys and density values at their own paths", () => {
    expect(paths({ ...fixture(), typo: 1 })).toContain("typo");
    expect(paths({ ...fixture(), density: { default: "dense", remember_days: 20 } })).toContain("density.default");
  });

  it.each([
    ["density", "remember_days", 0], ["density", "remember_days", 3651], ["density", "remember_days", 1.5],
    ["compact", "title_lines", 0], ["compact", "title_lines", 5], ["compact", "title_lines", 1.5],
    ["compact", "next_action_lines", 0], ["compact", "next_action_lines", 4], ["compact", "next_action_lines", 1.5],
    ["layout", "column_min_width_rem", 9.9], ["layout", "column_min_width_rem", 24.1],
    ["layout", "board_min_height_rem", 11.9], ["layout", "board_min_height_rem", 60.1],
  ] as const)("rejects %s.%s = %s", (group, key, value) => {
    expect(paths({ ...fixture(), [group]: { ...fixture()[group], [key]: value } })).toContain(`${group}.${key}`);
  });
});
