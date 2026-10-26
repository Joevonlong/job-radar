// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import { configLayer, getDefaultConfigPath, getUserConfigPath, inspectConfigLayers, loadConfig, parseConfigText, readConfigText, readProfileText, resolveConfigPath, USER_CONFIG_NAMES, watchConfig, type ConfigChangeEvent } from "@/lib/config";
import { ConfigExampleError, readExample } from "@/lib/config/examples";
import { protectedChanges } from "@/lib/config/protected-check";
import { withConfigWriteLock, WRITE_LOCK_FILE } from "@/lib/config/write-lock";
import { profileCheck } from "@/lib/ops/doctor/checks/ai";
import { invalidProfileRequest } from "@/lib/profile/service";
import { loadProfilePage } from "@/lib/profile/view";
import { readProfileReadiness, readScoringProfile } from "@/lib/scoring/profile";
import { saveAdvanced } from "@/lib/settings/advanced/service";
import { advancedNameOfStem, ADVANCED_NAMES } from "@/lib/settings/advanced/view";
import { markStep, readSetupState, resetSetupStateCache } from "@/lib/setup/state";
import { readFresh } from "@/lib/setup/steps/common";

import { makeContext, only } from "../ops/doctor/helpers";
import { makeTempConfig, type TempConfig } from "./helpers";

vi.mock("@/lib/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db")>(),
  getDb: () => { throw new Error("database unavailable in this unit test"); },
}));

let tmp: TempConfig;
let stop: (() => void) | undefined;
beforeEach(() => { tmp = makeTempConfig({ user: "empty" }); resetSetupStateCache(); });
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); resetSetupStateCache(); tmp.cleanup(); });
const template = (name: string) => path.join(tmp.defaultsDir, "profile.example", `${name}.yaml`);

describe("profile templates are reader fallbacks, never a default config layer", () => {
  it.each([false, true])("profile readers work during another writer's lock without creating files: saved=%s", async (saved) => {
    fs.mkdirSync(tmp.profileDir);
    if (saved) for (const name of ["me", "preferences"]) fs.copyFileSync(template(name), path.join(tmp.profileDir, `${name}.yaml`));
    let entered = () => {};
    let release = () => {};
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = withConfigWriteLock(getUserConfigPath("me"), async () => { entered(); await gate; });
    await ready;
    try {
      expect(await readScoringProfile()).toMatchObject({ meYaml: fs.readFileSync(template("me"), "utf8") });
      expect(await loadProfilePage()).toMatchObject({ me: { loadError: null }, preferences: { loadError: null }, dbAvailable: false });
      expect(await invalidProfileRequest("me")).toMatchObject({ status: "error", formError: "invalidPayload" });
      expect(fs.readdirSync(tmp.profileDir).sort()).toEqual(saved ? [WRITE_LOCK_FILE, "me.yaml", "preferences.yaml"] : [WRITE_LOCK_FILE]);
    } finally { release(); await holding; }
  });

  it("keeps missing layer/path and notCopied reporting after reading a missing profile", async () => {
    for (const name of ["me", "preferences"] as const) {
      expect(readProfileText(name)).toBe(fs.readFileSync(template(name), "utf8"));
      expect(getDefaultConfigPath(name)).toBeNull();
      expect(configLayer(name)).toBe("missing");
      expect(resolveConfigPath(name)).toBe(getUserConfigPath(name));
    }
    const profile = await readScoringProfile();
    expect(profile.meYaml).toBe(fs.readFileSync(template("me"), "utf8"));
    expect(profile.preferencesYaml).toBe(fs.readFileSync(template("preferences"), "utf8"));
    const state = await inspectConfigLayers();
    expect(state.notCopied).toHaveLength(USER_CONFIG_NAMES.length);
    expect(state.notCopied).not.toContain("me.yaml");
    expect(state.notCopied).not.toContain("preferences.yaml");
    expect(state.userFiles).toBe(0);
    expect(fs.existsSync(tmp.profileDir)).toBe(false);
  });

  it("does not complete setup or mark profile progress when the wizard reads a missing profile", async () => {
    expect(readSetupState()).toMatchObject({ pending: true, source: "default", state: { steps: {} } });
    expect(readFresh("me")).not.toBeNull();
    expect(readFresh("preferences")).not.toBeNull();
    expect(readSetupState()).toMatchObject({ pending: true, source: "default", state: { steps: {} } });
    expect(await markStep("language", "done")).toMatchObject({ ok: true });
    expect(readSetupState()).toMatchObject({ pending: true, state: { steps: { language: { status: "done" } } } });
    expect(readSetupState().state?.steps.profile).toBeUndefined();
    expect(fs.existsSync(tmp.profileDir)).toBe(false);
  });

  it("raw config inspection still reports missing user profile files even when a template is available", () => {
    expect(() => readConfigText("me")).toThrow(expect.objectContaining({ kind: "missing", filePath: getUserConfigPath("me") }));
  });

  it("keeps profiles out of the advanced editor and its override-confirmation flow", async () => {
    for (const name of ["me", "preferences"] as const) {
      expect(ADVANCED_NAMES).not.toContain(name);
      expect(advancedNameOfStem(name)).toBeNull();
      expect(await saveAdvanced({ file: name, text: readProfileText(name), baseHash: "", baseLayer: "missing", confirmOverride: false })).toEqual({ status: "failed" });
    }
    expect(fs.existsSync(tmp.profileDir)).toBe(false);
  });

  it("still reports a missing profile as incomplete even when its template is populated", async () => {
    const value = parse(fs.readFileSync(template("me"), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(template("me"), stringify({ ...value, summary: "Example content is not a saved user profile.", skills: [] }));
    expect(readProfileReadiness()).toEqual({ usable: false, missing: ["summary", "skills"] });
    for (const waiting of [0, 2]) {
      const ctx = makeContext({ probes: { profile: async () => readProfileReadiness(), unscoredJobs: async () => waiting } });
      expect((await only(profileCheck, ctx)).status).toBe(waiting === 0 ? "warn" : "fail");
    }
    expect(fs.existsSync(tmp.profileDir)).toBe(false);
  });

  it("polling reports a user profile appearing with identical template text and reports its later removal", async () => {
    vi.useFakeTimers();
    loadConfig("me");
    const changes: ConfigChangeEvent[] = [];
    const errors: unknown[] = [];
    stop = watchConfig("me", (event) => changes.push(event), { fsWatch: false, pollMs: 10, onError: (error) => errors.push(error) });
    fs.mkdirSync(tmp.profileDir);
    const text = fs.readFileSync(template("me"), "utf8");
    fs.writeFileSync(getUserConfigPath("me"), text);
    await vi.advanceTimersByTimeAsync(10);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.filePath).toBe(getUserConfigPath("me"));
    fs.unlinkSync(getUserConfigPath("me"));
    await vi.advanceTimersByTimeAsync(10);
    expect(changes).toHaveLength(1);
    expect(errors).toMatchObject([{ kind: "missing" }]);
    expect(configLayer("me")).toBe("missing");
  });

  it("does not add profile protected keys or let config examples write profile files", () => {
    for (const name of ["me", "preferences"] as const) {
      expect(protectedChanges(name, parseConfigText(name, readProfileText(name)))).toEqual([]);
      const dir = path.join(tmp.defaultsDir, "examples", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "example.yaml"), "name: Sample\ndescription: Sample config.\n");
      fs.writeFileSync(path.join(dir, `${name}.yaml`), readProfileText(name));
      expect(() => readExample(name)).toThrow(ConfigExampleError);
    }
    expect(fs.existsSync(tmp.profileDir)).toBe(false);
  });
});
