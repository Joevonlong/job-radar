// @vitest-environment node
import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { configRegistry, LAYERED_CONFIG_NAMES, overlayFormatVersion } from "@/lib/config";

const LIB = path.resolve(import.meta.dirname, "../../scripts/ops/lib/config.sh");
const shellValue = (file: string): string => execFileSync("bash", ["-c", 'source "$0" >/dev/null 2>&1; cfg_overlay_format_version "$1"', LIB, file], { encoding: "utf8" });

describe("the shell's overlay version table", () => {
  it("equals the migration chains, file by file", () => {
    for (const name of LAYERED_CONFIG_NAMES) {
      const expected = overlayFormatVersion(name);
      expect([name, shellValue(configRegistry[name].file)]).toEqual([name, expected === null ? "" : String(expected)]);
    }
  });
});
