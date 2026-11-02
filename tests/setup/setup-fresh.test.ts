// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureConfigFiles, installedConfigFiles, parseConfigText } from "@/lib/config";
import { ARCHIVE_META_YAML } from "@/lib/ops/config-archive";
import { setConfigWriteLockProviderForTests, type ConfigWriteLockProvider } from "@/lib/config/write-lock";
import { readSetupState, resetSetupStateCache } from "@/lib/setup/state";
import { saveLanguageStep } from "@/lib/setup/steps/language";

import { inProcessConfigWriteLock } from "../config/in-process-lock";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { runConfigScript } from "../config/run-script";

/** A fresh install is whatever has no setup.yaml: the wizard is pending, whatever else the directory holds. */
let tmp: TempConfig;
const user = (file: string) => path.join(tmp.configDir, file);
const NOW = new Date("2026-10-09T08:00:00.000Z");
const COMPLETED_EXISTING = `config_version: 1\ncompleted_at: "2026-09-01T00:00:00.000Z"\ncompleted_by: existing_install\n`;

beforeEach(() => {
  tmp = makeTempConfig({ user: "empty" });
  resetSetupStateCache();
});
afterEach(() => {
  setConfigWriteLockProviderForTests(inProcessConfigWriteLock);
  tmp.cleanup();
});

function stepsOf(): Record<string, { status: string }> {
  return (readSetupState().state?.steps ?? {}) as Record<string, { status: string }>;
}

describe("an empty install", () => {
  it("is pending without any file", () => {
    expect(readSetupState()).toMatchObject({ pending: true, source: "default" });
    expect(fs.readdirSync(tmp.configDir)).toEqual([]);
  });

  it("the first real step (saveLanguageStep) creates the pending setup.yaml, writes language.yaml and marks the step", async () => {
    const result = await saveLanguageStep({ ui_locale: "en", ai_output: "de" });
    expect(result).toMatchObject({ status: "saved", step: "language", locale: "en" });
    expect(parseConfigText("setup", fs.readFileSync(user("setup.yaml"), "utf8"))).toMatchObject({ completed_at: null, steps: { language: { status: "done" } } });
    expect(readSetupState()).toMatchObject({ pending: true, source: "user" });
    expect(parseConfigText("language", fs.readFileSync(user("language.yaml"), "utf8")).ai.output).toBe("de");
    // only the two files of the step: nothing else was filled in (.backup holds the copy of the file the step replaced)
    expect(fs.readdirSync(tmp.configDir).filter((name) => name !== ".backup").sort()).toEqual(["language.yaml", "setup.yaml"]);
  });

  it("a second save does not touch the completed-ness: still pending", async () => {
    await saveLanguageStep({ ui_locale: "en" });
    await saveLanguageStep({ ui_locale: "zh" });
    expect(readSetupState().pending).toBe(true);
    expect(Object.keys(stepsOf())).toEqual(["language"]);
  });
});

describe("a step whose first commit fails", () => {
  const refuse = (provider: ConfigWriteLockProvider) => setConfigWriteLockProviderForTests(provider);

  it.each([
    ["the lock is held elsewhere", async () => ({ acquired: false as const, holder: "job-radar config-write pid=1 host=h" }), "busy"],
    ["the database cannot be reached", async () => { throw Object.assign(new Error("down"), { name: "DbUnavailable" }); }, "dbUnavailable"],
  ])("returns the form error and writes nothing when %s", async (_name, provider, formError) => {
    refuse(provider);
    expect(await saveLanguageStep({ ui_locale: "en" })).toMatchObject({ status: "error", step: "language", formError });
    expect(fs.readdirSync(tmp.configDir)).toEqual([]);
    expect(readSetupState().pending).toBe(true);
  });

  it("is `setupUnreadable` when there is no shipped setup.yaml to start from", async () => {
    fs.rmSync(path.join(tmp.defaultsDir, "setup.yaml"));
    resetSetupStateCache();
    expect(await saveLanguageStep({ ui_locale: "en" })).toMatchObject({ status: "error", formError: "setupUnreadable" });
    expect(fs.readdirSync(tmp.configDir)).toEqual([]);
  });
});

describe("what the directory holds does not decide anything", () => {
  it("only a language.yaml (an old install's leftover) is still pending, and a step then creates the pending setup.yaml", async () => {
    fs.copyFileSync(path.join(tmp.defaultsDir, "language.yaml"), user("language.yaml"));
    expect(readSetupState().pending).toBe(true);
    await saveLanguageStep({ ui_locale: "en" });
    expect(readSetupState()).toMatchObject({ pending: true, source: "user" });
    expect(fs.existsSync(user("setup.yaml"))).toBe(true);
  });

  it("a directory full of config files but no setup.yaml is pending too", () => {
    for (const name of ["ui.yaml", "schedule.yaml", "search.yaml"]) fs.copyFileSync(path.join(tmp.defaultsDir, name), user(name));
    expect(readSetupState()).toMatchObject({ pending: true, source: "default" });
  });

  it("a setup.yaml of an install from before the wizard (`existing_install`) is completed, and a step keeps it so", async () => {
    fs.writeFileSync(user("setup.yaml"), COMPLETED_EXISTING);
    resetSetupStateCache();
    expect(readSetupState().pending).toBe(false);
    await saveLanguageStep({ ui_locale: "en" });
    expect(readSetupState().pending).toBe(false);
    expect(readSetupState().state).toMatchObject({ completed_at: "2026-09-01T00:00:00.000Z", completed_by: "existing_install", steps: { language: { status: "done" } } });
  });
});

describe("config:init and the wizard's files", () => {
  const WIZARD = ["setup.yaml", "language.yaml"];

  it("ensureConfigFiles creates the other user files but not setup.yaml or language.yaml", async () => {
    const results = await ensureConfigFiles({ now: NOW });
    expect(results.filter((result) => result.created).length).toBeGreaterThan(3);
    for (const file of WIZARD) expect(fs.existsSync(user(file))).toBe(false);
    expect(results.filter((result) => WIZARD.includes(path.basename(result.path))).every((result) => !result.created && result.reason === null)).toBe(true);
    expect(readSetupState().pending).toBe(true);
  });

  it("the command does the same, and leaves a wizard file that exists alone", () => {
    fs.writeFileSync(user("setup.yaml"), "completed_at: null\n");
    const run = runConfigScript(tmp, "config-init.ts");
    expect(run.status).toBe(0);
    expect(fs.existsSync(user("ui.yaml"))).toBe(true);
    expect(fs.existsSync(user("language.yaml"))).toBe(false);
    expect(fs.readFileSync(user("setup.yaml"), "utf8")).toBe("completed_at: null\n");
  });
});

describe("config:init --from", () => {
  let from: string;
  beforeEach(() => {
    from = path.join(tmp.root, "from");
    fs.mkdirSync(from);
  });
  const put = (file: string, text = fs.readFileSync(path.join(tmp.defaultsDir, file), "utf8")) => fs.writeFileSync(path.join(from, file), text);
  const created = (results: Awaited<ReturnType<typeof ensureConfigFiles>>, file: string) => results.find((result) => path.basename(result.path) === file);

  it("copies setup.yaml and language.yaml like the rest when the directory has them", async () => {
    put("ui.yaml");
    put("setup.yaml", "completed_at: null\n");
    put("language.yaml");
    const results = await ensureConfigFiles({ from, now: NOW });
    expect(created(results, "setup.yaml")).toMatchObject({ created: true, reason: "user" });
    expect(created(results, "language.yaml")).toMatchObject({ created: true, reason: "user" });
    expect(fs.readFileSync(user("setup.yaml"), "utf8")).toBe("completed_at: null\n");
  });

  it("a directory from before the wizard (layered files, no setup.yaml, no marker) gets a completed setup.yaml and the old language.yaml", async () => {
    put("ui.yaml");
    const results = await ensureConfigFiles({ from, now: NOW });
    expect(created(results, "setup.yaml")).toMatchObject({ created: true, reason: "backfill" });
    expect(created(results, "language.yaml")).toMatchObject({ created: true, reason: "backfill" });
    expect(parseConfigText("setup", fs.readFileSync(user("setup.yaml"), "utf8"))).toMatchObject({ completed_at: NOW.toISOString(), completed_by: "existing_install" });
    expect(parseConfigText("language", fs.readFileSync(user("language.yaml"), "utf8")).ui.default_locale).toBe("zh");
    expect(readSetupState().pending).toBe(false);
  });

  it("one wizard file present, the other missing: the present one is copied, the missing one backfilled", async () => {
    put("ui.yaml");
    put("language.yaml", fs.readFileSync(path.join(tmp.defaultsDir, "language.yaml"), "utf8"));
    const results = await ensureConfigFiles({ from, now: NOW });
    expect(created(results, "language.yaml")).toMatchObject({ reason: "user" });
    expect(created(results, "setup.yaml")).toMatchObject({ reason: "backfill" });
  });

  it("an archive with the marker is restored as it is: no setup.yaml means the wizard is pending, and the marker is not copied", async () => {
    put("ui.yaml");
    put(".archive-meta.yaml", ARCHIVE_META_YAML);
    const results = await ensureConfigFiles({ from, now: NOW });
    expect(results.filter((result) => ["setup.yaml", "language.yaml"].includes(path.basename(result.path))).every((result) => !result.created)).toBe(true);
    expect(fs.existsSync(user("setup.yaml"))).toBe(false);
    expect(fs.existsSync(user(".archive-meta.yaml"))).toBe(false);
    expect(readSetupState().pending).toBe(true);
  });

  it("a marker that cannot be read is not a pre-wizard archive either: nothing is backfilled", async () => {
    put("ui.yaml");
    put(".archive-meta.yaml", "setup_semantics: soon\n");
    await ensureConfigFiles({ from, now: NOW });
    expect(fs.existsSync(user("setup.yaml"))).toBe(false);
  });

  it("a directory with no layered config file at all is not an install: nothing is backfilled", async () => {
    put("notes.txt", "x");
    expect(installedConfigFiles(from)).toEqual([]);
    await ensureConfigFiles({ from, now: NOW });
    expect(fs.existsSync(user("setup.yaml"))).toBe(false);
    expect(fs.existsSync(user("language.yaml"))).toBe(false);
  });

  it("a user directory that already has a setup.yaml keeps it, whatever the old directory says", async () => {
    fs.writeFileSync(user("setup.yaml"), "completed_at: null\n");
    put("ui.yaml");
    await ensureConfigFiles({ from, now: NOW });
    expect(fs.readFileSync(user("setup.yaml"), "utf8")).toBe("completed_at: null\n");
    expect(fs.existsSync(user("language.yaml"))).toBe(false);
  });
});
