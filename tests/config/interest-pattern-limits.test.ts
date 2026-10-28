// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { loadConfig, writeConfig } from "@/lib/config";
import { SIGNAL_PROBE_DEFAULTS } from "@/lib/config/schemas/interests";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig | null = null;
afterEach(() => {
  tmp?.cleanup();
  tmp = null;
});

describe("interests.yaml optional pattern limits", () => {
  it("leaves schema defaults absent on save and preserves explicit keys and overrides", async () => {
    tmp = makeTempConfig();
    const file = path.join(tmp.configDir, "interests.yaml");
    const original = parseDocument(fs.readFileSync(file, "utf8"));
    for (const key of Object.keys(SIGNAL_PROBE_DEFAULTS)) original.deleteIn(["limits", key]);
    fs.writeFileSync(file, original.toString());
    const interests = loadConfig("interests");
    expect(interests.limits).toMatchObject(SIGNAL_PROBE_DEFAULTS);
    await writeConfig("interests", { ...interests, bonus_cap: interests.bonus_cap + 1 });
    const saved = parseDocument(fs.readFileSync(file, "utf8"));
    for (const key of Object.keys(SIGNAL_PROBE_DEFAULTS)) expect(saved.hasIn(["limits", key])).toBe(false);

    await writeConfig("interests", { ...loadConfig("interests"), limits: { ...interests.limits, pattern_probe_chars: 3000, pattern_job_ms: 100 } });
    const overrides = parseDocument(fs.readFileSync(file, "utf8"));
    expect(overrides.getIn(["limits", "pattern_probe_chars"])).toBe(3000);
    expect(overrides.getIn(["limits", "pattern_job_ms"])).toBe(100);
    // Resetting a key that already exists keeps that explicit choice in the file.
    await writeConfig("interests", { ...loadConfig("interests"), limits: { ...interests.limits } });
    const explicit = parseDocument(fs.readFileSync(file, "utf8"));
    expect(explicit.getIn(["limits", "pattern_job_ms"])).toBe(SIGNAL_PROBE_DEFAULTS.pattern_job_ms);
    expect(explicit.getIn(["limits", "pattern_probe_chars"])).toBe(SIGNAL_PROBE_DEFAULTS.pattern_probe_chars);
    expect(explicit.hasIn(["limits", "pattern_probe_ms"])).toBe(false);
    expect(explicit.hasIn(["limits", "pattern_probe_retry_ms"])).toBe(false);
  });
});
