// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configLayer,
  configSourcePath,
  displayConfigPath,
  displayConfigPathForWeb,
  ensureConfigFiles,
  getDefaultConfigPath,
  getAppRoot,
  getConfigPath,
  inspectConfigLayers,
  installedConfigFiles,
  isExistingInstall,
  loadConfig,
  readConfigText,
  readProfileText,
  reloadConfig,
  resolveConfigPath,
  SHIPPED_CONFIG_NAMES,
  USER_CONFIG_NAMES,
  watchConfig,
  writeConfig,
  type ConfigChangeEvent,
} from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig | null = null;
const stops: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  while (stops.length > 0) stops.pop()?.();
  tmp?.cleanup();
  tmp = null;
});

/** The current temp directories (every suite but the first makes them in beforeEach). */
const dirs = (): TempConfig => {
  if (tmp === null) throw new Error("no temp config");
  return tmp;
};
const user = (file: string) => path.join(dirs().configDir, file);
const shipped = (file: string) => path.join(dirs().defaultsDir, file);
const read = (file: string) => fs.readFileSync(file, "utf8");
/** Every file of a directory (recursively) with its text: the "nothing changed here" check. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      out[path.relative(dir, file)] = read(file);
    }
  }
  return out;
}

describe("the registry", () => {
  it("marks activity log, delivery audit, models, pipeline, pipeline board, signal presets and traps as shipped, the rest of the config files as user files", () => {
    expect([...SHIPPED_CONFIG_NAMES].sort()).toEqual(["activityLog", "deliveryAudit", "models", "pipeline", "pipelineBoard", "signalPresets", "traps"]);
    expect(USER_CONFIG_NAMES).toEqual(expect.arrayContaining(["schedule", "search", "channels", "ai", "notify", "interests", "ui", "breakdown", "resume", "insights", "language", "setup", "salary", "mcp"]));
    expect(USER_CONFIG_NAMES).toHaveLength(14);
  });
});

describe("resolution: the user file wins, else the shipped default", () => {
  beforeEach(() => {
    tmp = makeTempConfig({ user: "empty" });
  });

  it("reads the default while the user directory lacks the file, and the user's copy once it exists", () => {
    expect(configLayer("notify")).toBe("default");
    expect(resolveConfigPath("notify")).toBe(shipped("notify.yaml"));
    expect(loadConfig("notify").push_min_score).toBe(70);

    fs.writeFileSync(user("notify.yaml"), read(shipped("notify.yaml")).replace("push_min_score: 70", "push_min_score: 61"));
    expect(configLayer("notify")).toBe("user");
    expect(configSourcePath("notify")).toBe(user("notify.yaml"));
    expect(reloadConfig("notify").push_min_score).toBe(61);

    fs.rmSync(user("notify.yaml"));
    expect(reloadConfig("notify").push_min_score).toBe(70);
  });

  it("an existing user sources.yaml keeps its switches when the shipped default turns a channel off", () => {
    const withIndeed = (on: boolean) => read(shipped("sources.yaml")).replace(/(\n  indeed:\n    enabled: )(true|false)/, `$1${on}`);
    fs.writeFileSync(user("sources.yaml"), withIndeed(true));
    fs.writeFileSync(shipped("sources.yaml"), withIndeed(false));
    expect(reloadConfig("channels").sources.indeed.enabled).toBe(true);
    fs.rmSync(user("sources.yaml"));
    expect(reloadConfig("channels").sources.indeed.enabled).toBe(false);
  });

  it("names the user file when neither layer has it", () => {
    fs.rmSync(shipped("ui.yaml"));
    expect(configLayer("ui")).toBe("missing");
    expect(() => readConfigText("ui")).toThrow(expect.objectContaining({ kind: "missing", filePath: user("ui.yaml") }));
  });

  it("missing profile files read their shipped templates without creating user files", () => {
    for (const name of ["me", "preferences"] as const) {
      expect(getDefaultConfigPath(name)).toBeNull();
      expect(configLayer(name)).toBe("missing");
      expect(resolveConfigPath(name)).toBe(path.join(dirs().profileDir, `${name}.yaml`));
      expect(readProfileText(name)).toBe(read(shipped(`profile.example/${name}.yaml`)));
      expect(fs.existsSync(getConfigPath(name))).toBe(false);
    }
  });

  it("a write goes to the user directory only: the first save starts from the default (its comments) and the defaults never change", async () => {
    const defaultsBefore = snapshot(dirs().defaultsDir);
    const value = structuredClone(loadConfig("notify"));
    value.push_min_score = 64;
    await writeConfig("notify", value);
    expect(snapshot(dirs().defaultsDir)).toEqual(defaultsBefore);
    const written = read(user("notify.yaml"));
    expect(written).toContain("push_min_score: 64");
    // the shipped file's comments carried over
    const firstComment = read(shipped("notify.yaml")).split("\n")[0] ?? "";
    expect(firstComment.startsWith("#")).toBe(true);
    expect(written).toContain(firstComment);
    expect(getConfigPath("notify")).toBe(user("notify.yaml"));
    expect(reloadConfig("notify").push_min_score).toBe(64);
  });

  it("a shipped file saved by the app becomes a user override", async () => {
    const catalog = structuredClone(loadConfig("models"));
    await writeConfig("models", catalog);
    expect(configLayer("models")).toBe("user");
    expect(fs.existsSync(user("models.yaml"))).toBe(true);
  });

  it("displays paths inside the app relative to it and others as they are", () => {
    expect(displayConfigPath(path.join(getAppRoot(), "data", "config", "ai.yaml"))).toBe(path.join("data", "config", "ai.yaml"));
    expect(displayConfigPath(user("ai.yaml"))).toBe(user("ai.yaml"));
  });

  it("the web display shows a moved config or profile directory under its conventional name and leaves other paths alone", () => {
    expect(displayConfigPathForWeb(path.join(getAppRoot(), "data", "config", "ai.yaml"))).toBe(path.join("data", "config", "ai.yaml"));
    expect(displayConfigPathForWeb(user("ai.yaml"))).toBe(path.join("data", "config", "ai.yaml"));
    expect(displayConfigPathForWeb(path.join(dirs().profileDir, "me.yaml"))).toBe(path.join("data", "profile", "me.yaml"));
    expect(displayConfigPathForWeb(shipped("ai.yaml"))).toBe(path.join("config", "ai.yaml"));
    expect(displayConfigPathForWeb(path.join(path.dirname(dirs().configDir), "elsewhere", "ai.yaml"))).toBe(path.join(path.dirname(dirs().configDir), "elsewhere", "ai.yaml"));
  });
});

describe("hot reload watches both layers", () => {
  beforeEach(() => {
    tmp = makeTempConfig({ user: "empty" });
  });

  function watch() {
    vi.useFakeTimers();
    const events: ConfigChangeEvent[] = [];
    const errors: unknown[] = [];
    stops.push(watchConfig(["notify"], (event) => events.push(event), { debounceMs: 20, pollMs: 80, fsWatch: false, onError: (e) => errors.push(e) }));
    return { events, errors, tick: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
  }

  it("a user file that appears takes over; deleting it falls back to the default", async () => {
    loadConfig("notify");
    const { events, errors, tick } = watch();
    fs.writeFileSync(user("notify.yaml"), read(shipped("notify.yaml")).replace("push_min_score: 70", "push_min_score: 66"));
    await tick(500);
    expect(events.at(-1)?.filePath).toBe(user("notify.yaml"));
    expect(loadConfig("notify").push_min_score).toBe(66);

    fs.rmSync(user("notify.yaml"));
    await tick(500);
    expect(events.at(-1)?.filePath).toBe(shipped("notify.yaml"));
    expect(loadConfig("notify").push_min_score).toBe(70);
    expect(errors).toEqual([]);
  });

  it("a changed default is picked up while the user has no copy", async () => {
    loadConfig("notify");
    const { events, tick } = watch();
    fs.writeFileSync(shipped("notify.yaml"), read(shipped("notify.yaml")).replace("push_min_score: 70", "push_min_score: 72"));
    await tick(500);
    expect(events).toHaveLength(1);
    expect(loadConfig("notify").push_min_score).toBe(72);
  });

  it("a real fs.watch sees a user file created in a user directory that did not exist at start", async () => {
    fs.rmSync(dirs().configDir, { recursive: true });
    loadConfig("notify");
    const events: ConfigChangeEvent[] = [];
    stops.push(watchConfig(["notify"], (event) => events.push(event), { debounceMs: 20, pollMs: 50 }));
    fs.mkdirSync(dirs().configDir);
    fs.writeFileSync(user("notify.yaml"), read(shipped("notify.yaml")).replace("push_min_score: 70", "push_min_score: 67"));
    await vi.waitFor(() => expect(events.at(-1)?.value).toMatchObject({ push_min_score: 67 }), { timeout: 10_000 });
  });
});

describe("ensureConfigFiles (pnpm config:init)", () => {
  beforeEach(() => {
    tmp = makeTempConfig({ user: "empty" });
    fs.rmSync(dirs().configDir, { recursive: true });
  });

  it("creates the directory and copies the user files, not the shipped ones; a second run changes nothing", async () => {
    const first = await ensureConfigFiles();
    expect(first.filter((r) => r.created).map((r) => r.name).sort()).toEqual([...USER_CONFIG_NAMES].sort());
    for (const name of USER_CONFIG_NAMES) expect(configLayer(name)).toBe("user");
    expect(fs.existsSync(user("models.yaml"))).toBe(false);
    expect(fs.existsSync(user("pipeline.yaml"))).toBe(false);
    expect(read(user("sources.yaml"))).toBe(read(shipped("sources.yaml")));

    // the user edits a file; init never overwrites it
    fs.writeFileSync(user("ai.yaml"), `${read(user("ai.yaml"))}\n# mine\n`);
    const before = snapshot(dirs().configDir);
    const second = await ensureConfigFiles();
    expect(second.some((r) => r.created)).toBe(false);
    expect(snapshot(dirs().configDir)).toEqual(before);
  });

  it("refills only what is missing", async () => {
    await ensureConfigFiles();
    fs.rmSync(user("ui.yaml"));
    const again = await ensureConfigFiles();
    expect(again.filter((r) => r.created).map((r) => r.name)).toEqual(["ui"]);
  });

  it("--from copies the user files from that directory, plus the shipped files whose content differs from the default", async () => {
    const from = path.join(dirs().root, "old-config");
    fs.cpSync(dirs().defaultsDir, from, { recursive: true });
    fs.writeFileSync(path.join(from, "search.yaml"), `${read(path.join(from, "search.yaml"))}# live edit\n`);
    fs.writeFileSync(path.join(from, "models.yaml"), `${read(path.join(from, "models.yaml"))}# my own model\n`);
    fs.rmSync(path.join(from, "insights.yaml")); // an older checkout without this file: it comes from the defaults
    const results = await ensureConfigFiles({ from });
    expect(read(user("search.yaml"))).toContain("# live edit");
    expect(read(user("models.yaml"))).toContain("# my own model");
    expect(results.find((r) => r.name === "models")).toMatchObject({ created: true, reason: "override" });
    // pipeline.yaml is the same as the default: not copied (it keeps following product updates)
    expect(fs.existsSync(user("pipeline.yaml"))).toBe(false);
    expect(read(user("insights.yaml"))).toBe(read(shipped("insights.yaml")));
    expect((await inspectConfigLayers()).overrides).toEqual(["models.yaml"]);
  });

  it("--from the defaults directory itself is the same as no --from", async () => {
    const results = await ensureConfigFiles({ from: dirs().defaultsDir });
    expect(results.filter((r) => r.created).map((r) => r.name).sort()).toEqual([...USER_CONFIG_NAMES].sort());
  });

  it("a fresh install gets the shipped language.yaml; an existing install gets its earlier languages written", async () => {
    // the shipped default of this fixture is zh; make it the public English default to tell the two apart
    fs.writeFileSync(shipped("language.yaml"), read(shipped("language.yaml")).replace("default_locale: zh", "default_locale: en"));
    expect(isExistingInstall()).toBe(false);
    const fresh = await ensureConfigFiles();
    expect(fresh.find((r) => r.name === "language")).toMatchObject({ created: true, reason: "user" });
    expect(read(user("language.yaml"))).toBe(read(shipped("language.yaml")));

    // an install from before the language settings: config files, no language.yaml
    fs.rmSync(user("language.yaml"));
    expect(isExistingInstall()).toBe(true);
    expect(installedConfigFiles()).toContain("ai.yaml");
    const upgraded = await ensureConfigFiles();
    expect(upgraded.filter((r) => r.created).map((r) => r.name)).toEqual(["language"]);
    expect(upgraded.find((r) => r.name === "language")).toMatchObject({ created: true, reason: "upgrade", source: null });
    expect(loadConfig("language")).toEqual({
      ui: { default_locale: "zh" },
      ai: { output: "zh", summary_also: ["en"] },
      translation: { target: "zh" },
      notify: { locale: null },
      cli: { locale: null },
    });
    // never overwritten
    const again = await ensureConfigFiles();
    expect(again.some((r) => r.created)).toBe(false);
  });

  it("--from an old directory without language.yaml writes the earlier languages, not the default", async () => {
    const from = path.join(dirs().root, "old-config");
    fs.cpSync(dirs().defaultsDir, from, { recursive: true });
    fs.rmSync(path.join(from, "language.yaml"));
    fs.writeFileSync(shipped("language.yaml"), read(shipped("language.yaml")).replace("default_locale: zh", "default_locale: en"));
    const results = await ensureConfigFiles({ from });
    expect(results.find((r) => r.name === "language")).toMatchObject({ created: true, reason: "upgrade" });
    expect(read(user("language.yaml"))).toContain("default_locale: zh");
  });

  it("needs no write access once everything is there (the runner's read-only mount)", async () => {
    await ensureConfigFiles();
    fs.chmodSync(dirs().configDir, 0o555);
    try {
      await expect(ensureConfigFiles()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ created: false })]));
    } finally {
      fs.chmodSync(dirs().configDir, 0o755);
    }
  });
});

describe("inspectConfigLayers (doctor config.layers)", () => {
  beforeEach(() => {
    tmp = makeTempConfig();
  });

  it("reports the directories, what is not copied yet and the overrides", async () => {
    fs.rmSync(user("ui.yaml"));
    fs.copyFileSync(shipped("pipeline.yaml"), user("pipeline.yaml"));
    const state = await inspectConfigLayers();
    expect(state).toMatchObject({ userDirExists: true, userDirWritable: true, notCopied: ["ui.yaml"], overrides: ["pipeline.yaml"], pendingMigrations: [], problems: [] });
    expect(state.userDir).toBe(dirs().configDir);
    expect(state.userFiles).toBe(USER_CONFIG_NAMES.length);
  });

  it("says when the user directory does not exist", async () => {
    fs.rmSync(dirs().configDir, { recursive: true });
    expect(await inspectConfigLayers()).toMatchObject({ userDirExists: false, userDirWritable: null, userFiles: 0 });
  });
});
