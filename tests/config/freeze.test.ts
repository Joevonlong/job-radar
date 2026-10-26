// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyConfigMigrations, ensureConfigFiles, ensureProfileFiles, getProfileExampleDir, getUserConfigPath, hashConfigText, loadConfig, readConfigText, readProfileText, reloadConfig, writeConfig, writeConfigText, resetConfigToDefault } from "@/lib/config";
import { EXISTING_INSTALL_LANGUAGE_YAML } from "@/lib/config/migrations/language/existing-install";
import { atomicWrite } from "@/lib/config/write";
import { freezeConfig, unfreezeConfig, upgradeFreezePath } from "@/lib/config/write-lock";
import { configToDraft } from "@/lib/settings/draft";
import { saveSettingsAction } from "@/app/settings/actions";
import { saveAdvanced } from "@/lib/settings/advanced/service";
import { saveProfileStep } from "@/lib/setup/steps/profile";
import { finishStep, setupFrozen } from "@/lib/setup/steps/common";
import { readSetupState, resetSetupStateCache } from "@/lib/setup/state";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const TARGET = "a".repeat(40);
const TOKEN = "1".repeat(32);
let tmp: TempConfig;
let savedToken: string | undefined;
beforeEach(() => { tmp = makeTempConfig({ user: "empty" }); savedToken = process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN; delete process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN; });
afterEach(() => { if (savedToken === undefined) delete process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN; else process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN = savedToken; vi.restoreAllMocks(); tmp.cleanup(); });

const textOptions = () => ({ baseHash: hashConfigText(readConfigText("ui")), baseLayer: "default" as const, maxBytes: 1000000, backupsKeep: 2 });

describe("upgrade freeze at real write entry points", () => {
  it("reads existing-install language defaults while fills are deferred, and preserves them after config-write", async () => {
    resetSetupStateCache();
    const defaultFile = path.join(tmp.defaultsDir, "language.yaml");
    fs.writeFileSync(defaultFile, fs.readFileSync(defaultFile, "utf8").replace("default_locale: zh", "default_locale: en").replace("output: zh", "output: en").replace("target: zh", "target: en").replace("summary_also: [en]", "summary_also: [zh]"));
    const fresh = readConfigText("language");
    expect(fresh).toBe(fs.readFileSync(defaultFile, "utf8"));
    expect(reloadConfig("language").ui.default_locale).toBe("en");
    fs.copyFileSync(path.join(tmp.defaultsDir, "notify.yaml"), getUserConfigPath("notify"));
    await freezeConfig(TARGET, TOKEN);
    expect(await ensureConfigFiles()).toEqual([]);
    expect(readConfigText("language")).toBe(EXISTING_INSTALL_LANGUAGE_YAML);
    const during = reloadConfig("language");
    expect(during).toMatchObject({ ui: { default_locale: "zh" }, ai: { output: "zh", summary_also: ["en"] }, translation: { target: "zh" } });
    expect(readSetupState()).toMatchObject({ pending: false, source: "existing_install" });
    expect(fs.existsSync(getUserConfigPath("language"))).toBe(false);
    process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN = TOKEN;
    await ensureConfigFiles();
    expect(reloadConfig("language")).toEqual(during);
    expect(readConfigText("language")).toBe(EXISTING_INSTALL_LANGUAGE_YAML);
    // A real user language file takes precedence even while frozen.
    fs.writeFileSync(getUserConfigPath("language"), fresh);
    expect(readConfigText("language")).toBe(fresh);
  });

  it.each([
    { kind: "current", json: '{"pending":0,"problems":0}\n', status: 0 },
    { kind: "pending", json: '{"pending":1,"problems":0}\n', status: 0 },
    { kind: "problem", json: '{"pending":0,"problems":1}\n', status: 1 },
  ])("pins the real config:migrate --json deploy contract: $kind", ({ kind, json, status }) => {
    if (kind === "pending") fs.copyFileSync(path.resolve(import.meta.dirname, "../fixtures/config/interests.v1.yaml"), getUserConfigPath("interests"));
    if (kind === "problem") fs.writeFileSync(getUserConfigPath("ui"), "config_version: 999\n");
    const before = fs.readdirSync(tmp.configDir).map((name) => [name, fs.readFileSync(path.join(tmp.configDir, name), "utf8")]);
    expect(runConfigScript(tmp, "config-migrate.ts", ["--json"])).toEqual({ status, out: json });
    expect(fs.readdirSync(tmp.configDir).map((name) => [name, fs.readFileSync(path.join(tmp.configDir, name), "utf8")])).toEqual(before);
  });

  it("returns the frozen error when deployment starts after the wizard's early check but before marking progress", async () => {
    resetSetupStateCache();
    expect(setupFrozen("language")).toBeNull();
    const before = readSetupState();
    await freezeConfig(TARGET, TOKEN);
    expect(await finishStep("language")).toMatchObject({ status: "error", formError: "frozen" });
    expect(readSetupState().state).toEqual(before.state);
    expect(fs.existsSync(getUserConfigPath("setup"))).toBe(false);
  });
  it("refuses settings, profile, raw editor, reset and migration writes without creating backups", async () => {
    await freezeConfig(TARGET, TOKEN);
    await expect(writeConfig("search", loadConfig("search"))).rejects.toMatchObject({ kind: "frozen" });
    await expect(writeConfig("me", loadConfig("me"))).rejects.toMatchObject({ kind: "frozen" });
    await expect(writeConfigText("ui", readConfigText("ui"), textOptions())).rejects.toMatchObject({ kind: "frozen" });
    await expect(resetConfigToDefault("ui", textOptions())).rejects.toMatchObject({ kind: "frozen" });
    await expect(applyConfigMigrations({ pending: [], problems: [], current: [] })).rejects.toMatchObject({ kind: "frozen" });
    await expect(atomicWrite(getUserConfigPath("search"), "changed")).rejects.toMatchObject({ kind: "frozen" });
    expect(fs.readdirSync(tmp.configDir)).toEqual([".upgrade-freeze"]);
    expect(fs.readdirSync(tmp.profileDir)).toEqual([]);
  });

  it("the settings Server Action and editor return frozen for the localized UI message; wizard does too", async () => {
    await freezeConfig(TARGET, TOKEN);
    const result = await saveSettingsAction({ status: "idle" }, { tab: "search", draft: configToDraft("search", loadConfig("search")), baseHash: hashConfigText(readConfigText("search")) });
    expect(result).toMatchObject({ status: "error", formError: "frozen" });
    const raw = readConfigText("ui");
    expect(await saveAdvanced({ file: "ui", text: raw, baseHash: hashConfigText(raw), baseLayer: "default", confirmOverride: true })).toEqual({ status: "frozen" });
    expect(await saveProfileStep({})).toMatchObject({ status: "error", formError: "frozen" });
    for (const language of ["en", "zh"]) {
      const messages = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../../messages/${language}.json`), "utf8")) as { settings: { formErrors: { frozen: string } } };
      expect(messages.settings.formErrors.frozen).toContain("pnpm ops:unfreeze");
    }
  });

  it("startup fills skip without throwing, and missing profiles read the template in memory", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await freezeConfig(TARGET, TOKEN);
    expect(await ensureConfigFiles()).toEqual([]);
    expect(await ensureProfileFiles()).toEqual([]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(tmp.configDir)).toEqual([".upgrade-freeze"]);
    for (const name of ["me", "preferences"] as const) {
      expect(readProfileText(name)).toBe(fs.readFileSync(path.join(getProfileExampleDir(), `${name}.yaml`), "utf8"));
      expect(() => loadConfig(name)).not.toThrow();
      expect(fs.existsSync(getUserConfigPath(name))).toBe(false);
    }
    await unfreezeConfig();
    expect(readProfileText("me")).toBe(fs.readFileSync(path.join(getProfileExampleDir(), "me.yaml"), "utf8"));
  });

  it("the operation CLIs keep tokens private and only the owning deploy can clear its freeze", async () => {
    const allowed = { JOB_RADAR_UPGRADE_FREEZE_TOKEN: TOKEN };
    const freeze = runConfigScript(tmp, "ops-freeze.ts", ["--target", TARGET], allowed);
    expect(freeze.status, freeze.out).toBe(0);
    expect(freeze.out).not.toContain(TOKEN);
    expect(fs.existsSync(upgradeFreezePath())).toBe(true);
    const refused = runConfigScript(tmp, "ops-freeze.ts", ["--unfreeze", "--owned"], { JOB_RADAR_UPGRADE_FREEZE_TOKEN: "2".repeat(32) });
    expect(refused.status).toBe(1);
    expect(fs.existsSync(upgradeFreezePath())).toBe(true);
    const clear = runConfigScript(tmp, "ops-freeze.ts", ["--unfreeze", "--owned"], allowed);
    expect(clear.status, clear.out).toBe(0);
    expect(clear.out).toContain("pnpm config:migrate --write");
    expect(clear.out.indexOf("pnpm config:init")).toBeGreaterThanOrEqual(0);
    expect(clear.out.indexOf("pnpm config:init")).toBeLessThan(clear.out.indexOf("pnpm config:migrate --write"));
    expect(clear.out).not.toContain(TOKEN);
    expect(fs.existsSync(upgradeFreezePath())).toBe(false);
  });

  it("wrong or malformed tokens fail closed, a matching token authorizes real CLI init and migration", async () => {
    await freezeConfig(TARGET, TOKEN);
    const old = fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/config/interests.v1.yaml"), "utf8");
    fs.writeFileSync(path.join(tmp.configDir, "interests.yaml"), old);
    const wrong = { JOB_RADAR_UPGRADE_FREEZE_TOKEN: "2".repeat(32) };
    expect(runConfigScript(tmp, "config-init.ts", [], wrong).status).toBe(1);
    expect(runConfigScript(tmp, "config-migrate.ts", ["--write"], wrong).status).toBe(1);
    expect(fs.readFileSync(path.join(tmp.configDir, "interests.yaml"), "utf8")).toBe(old);
    const allowed = { JOB_RADAR_UPGRADE_FREEZE_TOKEN: TOKEN };
    expect(runConfigScript(tmp, "config-init.ts", [], allowed).status).toBe(0);
    expect(runConfigScript(tmp, "config-migrate.ts", ["--write"], allowed).status).toBe(0);
    expect(fs.existsSync(path.join(tmp.profileDir, "me.yaml"))).toBe(true);
    expect(fs.readFileSync(path.join(tmp.configDir, "interests.yaml"), "utf8")).not.toBe(old);
    expect(fs.existsSync(upgradeFreezePath())).toBe(true);
    fs.writeFileSync(upgradeFreezePath(), "invalid marker");
    process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN = TOKEN;
    await expect(writeConfig("search", loadConfig("search"))).rejects.toMatchObject({ kind: "frozen" });
  });
});
