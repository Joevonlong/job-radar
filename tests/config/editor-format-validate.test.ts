// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentConfigVersion, legacyFormatVersion, validateConfigText } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

const overlayVersion = (): number => currentConfigVersion("ui");

describe("validateConfigText by format", () => {
  it("an overlay is valid with few keys: it is merged over the shipped value", () => {
    const result = validateConfigText("ui", `config_version: ${overlayVersion()}\ntrend_cycles: 4\n`);
    expect(result.ok).toBe(true);
  });

  it("an overlay's marker is accepted; a bad value is on its own line", () => {
    expect(validateConfigText("schedule", `config_version: ${currentConfigVersion("schedule")}\nbackup:\n  max_age_hours: !unset\n`).ok).toBe(true);
    const bad = validateConfigText("ui", `config_version: ${overlayVersion()}\ntrend_cycles: nope\n`);
    expect(bad).toMatchObject({ ok: false, issues: [{ path: "trend_cycles", line: 2, exact: true }] });
  });

  it("a whole file of the older format is read by itself: the shipped file does not fill it", () => {
    const shipped = fs.readFileSync(path.join(temp.defaultsDir, "ui.yaml"), "utf8").replace(/^config_version: \d+/m, `config_version: ${legacyFormatVersion("ui")}`);
    expect(validateConfigText("ui", shipped).ok).toBe(true);
  });

  it("a marker in an older file is on its line and says what to add", () => {
    const result = validateConfigText("ui", `config_version: ${legacyFormatVersion("ui")}\ntrend_cycles: !unset\n`);
    expect(result).toMatchObject({ ok: false, issues: [{ path: "trend_cycles", line: 2 }] });
    expect(result.ok ? "" : result.issues[0]?.message).toContain(`config_version: ${overlayVersion()}`);
  });

  it("a shipped file that cannot be used is reported on line 1, not thrown", () => {
    fs.writeFileSync(path.join(temp.defaultsDir, "ui.yaml"), "a: [\n");
    const result = validateConfigText("ui", `config_version: ${overlayVersion()}\n`);
    expect(result).toMatchObject({ ok: false, issues: [{ line: 1 }] });
  });

  it("a version newer than the code is refused", () => {
    expect(validateConfigText("ui", `config_version: ${overlayVersion() + 1}\n`).ok).toBe(false);
  });
});
