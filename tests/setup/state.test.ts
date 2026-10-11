// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureConfigFiles, existingInstallSetupYaml, parseConfigText, setupSchema } from "@/lib/config";
import { completeSetup, markStep, readSetupState, resetSetupStateCache } from "@/lib/setup/state";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
const user = (file: string): string => path.join(tmp.configDir, file);
const NOW = new Date("2026-10-09T08:00:00.000Z");

beforeEach(() => {
  tmp = makeTempConfig({ user: "empty" });
  resetSetupStateCache();
});
afterEach(() => tmp.cleanup());

describe("setup.yaml schema", () => {
  it("accepts the shipped pending state and a completed one with steps", () => {
    expect(setupSchema.parse({ completed_at: null })).toEqual({ completed_at: null, completed_by: null, steps: {} });
    const done = { completed_at: "2026-10-09T08:00:00.000Z", completed_by: "wizard", steps: { language: { status: "done", at: "2026-10-09T07:59:00Z" }, ai: { status: "skipped", at: "2026-10-09T07:59:30+02:00" } } };
    expect(setupSchema.parse(done).steps.ai?.status).toBe("skipped");
  });

  it.each([
    ["an unknown step", { completed_at: null, steps: { nope: { status: "done", at: "2026-10-09T08:00:00Z" } } }],
    ["an unknown status", { completed_at: null, steps: { language: { status: "maybe", at: "2026-10-09T08:00:00Z" } } }],
    ["a time that is not ISO", { completed_at: "yesterday", completed_by: "cli" }],
    ["completed without completed_by", { completed_at: "2026-10-09T08:00:00Z" }],
    ["an unknown key", { completed_at: null, done: true }],
    ["an unknown completed_by", { completed_at: "2026-10-09T08:00:00Z", completed_by: "robot" }],
  ])("rejects %s", (_name, value) => {
    expect(setupSchema.safeParse(value).success).toBe(false);
  });
});

describe("first start: fresh vs existing install", () => {
  it("an empty user directory gets the shipped (pending) setup.yaml", async () => {
    const results = await ensureConfigFiles({ now: NOW });
    expect(results.find((r) => r.name === "setup")).toMatchObject({ created: true, reason: "user" });
    expect(parseConfigText("setup", fs.readFileSync(user("setup.yaml"), "utf8")).completed_at).toBeNull();
    expect(readSetupState()).toMatchObject({ pending: true, source: "user" });
  });

  it("a directory that already holds config files (no setup.yaml) is marked complete as an existing install", async () => {
    fs.copyFileSync(path.join(tmp.defaultsDir, "ui.yaml"), user("ui.yaml"));
    const results = await ensureConfigFiles({ now: NOW });
    expect(results.find((r) => r.name === "setup")).toMatchObject({ created: true, reason: "existing_install" });
    const state = parseConfigText("setup", fs.readFileSync(user("setup.yaml"), "utf8"));
    expect(state).toMatchObject({ completed_at: NOW.toISOString(), completed_by: "existing_install" });
    expect(readSetupState().pending).toBe(false);
  });

  it("never touches an existing setup.yaml, pending or not", async () => {
    fs.copyFileSync(path.join(tmp.defaultsDir, "ui.yaml"), user("ui.yaml"));
    fs.writeFileSync(user("setup.yaml"), "completed_at: null\n");
    const results = await ensureConfigFiles({ now: NOW });
    expect(results.find((r) => r.name === "setup")?.created).toBe(false);
    expect(fs.readFileSync(user("setup.yaml"), "utf8")).toBe("completed_at: null\n");
    expect(readSetupState().pending).toBe(true);
  });

  it("two starts at the same time write setup.yaml once", async () => {
    fs.copyFileSync(path.join(tmp.defaultsDir, "ui.yaml"), user("ui.yaml"));
    const [a, b] = await Promise.all([ensureConfigFiles({ now: NOW }), ensureConfigFiles({ now: new Date("2026-10-09T09:00:00.000Z") })]);
    const created = [a, b].map((r) => r.find((x) => x.name === "setup")?.created);
    expect(created.filter(Boolean)).toHaveLength(1);
    expect(setupSchema.safeParse(parseConfigText("setup", fs.readFileSync(user("setup.yaml"), "utf8"))).success).toBe(true);
  });

  it("the existing-install text is a valid setup.yaml", () => {
    expect(parseConfigText("setup", existingInstallSetupYaml(NOW))).toMatchObject({ completed_at: NOW.toISOString(), completed_by: "existing_install", steps: {} });
  });
});

describe("readSetupState: never locks an install into the wizard", () => {
  it("no user file but other config files: completed (existing install, the runner reads it like this before the web writes it)", () => {
    fs.copyFileSync(path.join(tmp.defaultsDir, "search.yaml"), user("search.yaml"));
    expect(readSetupState()).toMatchObject({ pending: false, source: "existing_install", error: null });
  });

  it("an empty user directory reads the shipped default: pending", () => {
    expect(readSetupState()).toMatchObject({ pending: true, source: "default" });
  });

  it("an invalid or unparsable setup.yaml counts as completed and reports the problem", () => {
    fs.writeFileSync(user("setup.yaml"), "completed_at: tomorrow\ncompleted_by: robot\n");
    expect(readSetupState()).toMatchObject({ pending: false, state: null, source: "user" });
    expect(readSetupState().error).not.toBeNull();
    fs.writeFileSync(user("setup.yaml"), "completed_at: [\n");
    expect(readSetupState()).toMatchObject({ pending: false, state: null });
  });

  it("no setup.yaml anywhere counts as completed", () => {
    fs.rmSync(path.join(tmp.defaultsDir, "setup.yaml"));
    expect(readSetupState()).toMatchObject({ pending: false, source: "missing" });
  });

  it("sees a change made by another process", () => {
    fs.writeFileSync(user("setup.yaml"), "completed_at: null\n");
    expect(readSetupState().pending).toBe(true);
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(user("setup.yaml"), 'completed_at: "2026-10-09T08:00:00Z"\ncompleted_by: cli\n');
    fs.utimesSync(user("setup.yaml"), later, later);
    expect(readSetupState().pending).toBe(false);
  });
});

describe("markStep / completeSetup", () => {
  it("records steps and completion on a fresh install", async () => {
    expect((await markStep("language", "done", NOW)).ok).toBe(true);
    expect((await markStep("ai", "skipped", NOW)).ok).toBe(true);
    let status = readSetupState();
    expect(status.pending).toBe(true);
    expect(status.state?.steps).toEqual({ language: { status: "done", at: NOW.toISOString() }, ai: { status: "skipped", at: NOW.toISOString() } });
    expect((await completeSetup("wizard", NOW)).ok).toBe(true);
    status = readSetupState();
    expect(status).toMatchObject({ pending: false, state: { completed_at: NOW.toISOString(), completed_by: "wizard" } });
    // the shipped comments survive (the file is written like every other config)
    expect(fs.readFileSync(user("setup.yaml"), "utf8")).toContain("# First-run setup");
  });

  it("a second completion keeps the first time and how", async () => {
    await completeSetup("skipped", NOW);
    await completeSetup("wizard", new Date("2026-10-10T08:00:00.000Z"));
    expect(readSetupState().state).toMatchObject({ completed_at: NOW.toISOString(), completed_by: "skipped" });
  });

  it("marking a step on an existing install without setup.yaml writes it as completed, never pending", async () => {
    fs.copyFileSync(path.join(tmp.defaultsDir, "ui.yaml"), user("ui.yaml"));
    await markStep("profile", "done", NOW);
    expect(readSetupState()).toMatchObject({ pending: false, state: { completed_by: "existing_install", steps: { profile: { status: "done" } } } });
  });

  it("refuses to overwrite an invalid setup.yaml", async () => {
    fs.writeFileSync(user("setup.yaml"), "completed_at: [\n");
    expect(await markStep("language", "done", NOW)).toEqual({ ok: false, reason: "unreadable" });
    expect(await completeSetup("cli", NOW)).toEqual({ ok: false, reason: "unreadable" });
    expect(fs.readFileSync(user("setup.yaml"), "utf8")).toBe("completed_at: [\n");
  });
});
