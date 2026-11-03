// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { legacyFormatVersion, newFileFormat, overlayFormatVersion } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
const write = (name: string, text: string): void => fs.writeFileSync(path.join(temp.configDir, name), text);

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

describe("newFileFormat", () => {
  it("a new install: overlays", () => {
    expect(newFileFormat()).toBe("overlay");
  });

  it("every file at its overlay version: overlays", () => {
    write("ui.yaml", `config_version: ${overlayFormatVersion("ui")}\n`);
    write("search.yaml", `config_version: ${overlayFormatVersion("search")}\nfoo: !unset\n`);
    expect(newFileFormat()).toBe("overlay");
  });

  it.each([
    ["an older version", () => `config_version: ${legacyFormatVersion("ui")}\n`],
    ["no version", () => "trend_cycles: 3\n"],
    ["a file that does not parse", () => "a: [\n"],
  ])("%s anywhere: whole files", (_label, text) => {
    write("search.yaml", `config_version: ${overlayFormatVersion("search")}\n`);
    write("ui.yaml", text());
    expect(newFileFormat()).toBe("legacy");
  });

  it("models.yaml does not count: it has its own overlay", () => {
    write("models.yaml", "models: []\n");
    expect(newFileFormat()).toBe("overlay");
  });
});
