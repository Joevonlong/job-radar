// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfigPath, parseConfigText, reloadConfig } from "@/lib/config";
import { currentConfigWriteLock } from "@/lib/config/write-lock";
import { UNREACHABLE_DATABASE_URL } from "@/lib/db/test-guard";
import { meConfigToDraft } from "@/lib/profile/draft";
import { readSetupState, resetSetupStateCache } from "@/lib/setup/state";
import { saveAiStep } from "@/lib/setup/steps/ai";
import { withStepWrite } from "@/lib/setup/steps/common";
import { saveLanguageStep } from "@/lib/setup/steps/language";
import { saveMarketStep } from "@/lib/setup/steps/market";
import { saveProfileStep } from "@/lib/setup/steps/profile";
import { finishSetup } from "@/lib/setup/steps/review";
import { saveSourcesStep } from "@/lib/setup/steps/sources";
import { saveTargetsStep } from "@/lib/setup/steps/targets";
import { saveTelegramStep } from "@/lib/setup/steps/telegram";
import { stepError, type SetupStepResult } from "@/lib/setup/types";
import type { SetupStepId } from "@/lib/setup/steps";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
const savedUrl = process.env.DATABASE_URL;
const REPO = path.resolve(import.meta.dirname, "../..");
const setupFile = () => path.join(tmp.configDir, "setup.yaml");

beforeEach(() => {
  // the profile history snapshot fails without a database, and the file still counts as written
  process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
  tmp = makeTempConfig({ user: "empty" });
  resetSetupStateCache();
});
afterEach(() => {
  tmp.cleanup();
  if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
});

const MARKET = { market: { pack: "generic", country: "NL", currency: "EUR", home_language: "nl" }, locations: ["Amsterdam"], remote_scope: "region:eu", timezone: "Europe/Amsterdam" };
const TARGETS = { target_titles: ["Data Engineer"], seniority: "senior", workplace: ["remote"], salary_floor_year: "60000", contracts: { permanent: "allow", fixed_term: "none", freelance: "none", temp_agency: "exclude" }, exclude_student_roles: true, exclude_companies: [], exclude_keywords: [] };

/** The seven saving steps, each with an input that is valid on an empty directory. */
const STEPS: [SetupStepId, () => Promise<SetupStepResult>][] = [
  ["language", () => saveLanguageStep({ ui_locale: "en" })],
  ["market", () => saveMarketStep(MARKET)],
  ["profile", () => saveProfileStep({ ...meConfigToDraft(reloadConfig("me")), summary: "Backend engineer." })],
  ["targets", () => saveTargetsStep(TARGETS)],
  ["sources", () => saveSourcesStep({ channels: { greenhouse: false } })],
  ["ai", () => saveAiStep({ order: ["claude-cli", "api", "codex-cli"], providers: {} })],
  ["telegram", () => saveTelegramStep({ enabled: false })],
];

function setup() {
  return parseConfigText("setup", fs.readFileSync(setupFile(), "utf8"));
}

describe("every step's save, on an empty directory", () => {
  it.each(STEPS)("%s: creates the pending setup.yaml and marks only its own step", async (id, save) => {
    expect(fs.existsSync(setupFile())).toBe(false);
    const result = await save();
    expect(result).toMatchObject({ status: "saved", step: id });
    expect(setup()).toMatchObject({ completed_at: null, completed_by: null });
    expect(Object.keys(setup().steps)).toEqual([id]);
    expect(setup().steps[id]?.status).toBe("done");
    expect(readSetupState().pending).toBe(true);
  });

  it("run one after the other, the setup stays pending until the review step finishes it", async () => {
    const done: string[] = [];
    for (const [id, save] of STEPS) {
      expect(await save()).toMatchObject({ status: "saved" });
      done.push(id);
      expect(Object.keys(setup().steps).sort()).toEqual([...done].sort());
      expect(readSetupState().pending).toBe(true);
    }
    expect(await finishSetup("wizard")).toEqual({ status: "saved", step: "review" });
    expect(setup()).toMatchObject({ completed_by: "wizard", completed_at: expect.any(String), steps: { review: { status: "done" } } });
    expect(readSetupState().pending).toBe(false);
  });

  it("the review step alone on an empty directory completes a setup.yaml it created first", async () => {
    expect(await finishSetup("wizard")).toEqual({ status: "saved", step: "review" });
    expect(setup()).toMatchObject({ completed_by: "wizard", steps: { review: { status: "done" } } });
    expect(fs.existsSync(getConfigPath("setup"))).toBe(true);
  });
});

describe("the steps' source", () => {
  const stepFiles = fs.readdirSync(path.join(REPO, "src/lib/setup/steps")).filter((name) => name.endsWith(".ts"));
  const source = (name: string) => fs.readFileSync(path.join(REPO, "src/lib/setup/steps", name), "utf8");

  it("covers the steps this test lists", () => {
    for (const [id] of STEPS) expect(stepFiles).toContain(`${id}.ts`);
  });

  it.each(["language", "market", "profile", "targets", "sources", "ai", "telegram"])("%s.ts saves through withStepWrite", (name) => {
    expect(source(`${name}.ts`)).toMatch(/\bwithStepWrite\(/);
  });

  it("no step file takes a lock or writes a file itself: every write goes through a service that does", () => {
    for (const name of stepFiles) {
      expect(source(name), name).not.toMatch(/\b(withConfigWriteLock|commitConfigFile|atomicWrite|writeFileSync|writeFile|renameSync|copyFileSync)\b/);
    }
  });

  it("the review file's actions make the pending setup.yaml first", () => {
    const review = source("review.ts");
    expect(review.match(/ensurePendingSetupFile\(\)/g)).toHaveLength(2);
  });

  it("withStepWrite's own source does not take the config write lock", () => {
    const text = source("common.ts");
    const body = text.slice(text.indexOf("export async function withStepWrite"));
    expect(body).not.toMatch(/withConfigWriteLock|withFileLock/);
  });
});

describe("withStepWrite", () => {
  it("runs the step's writes outside any lock, with the pending setup.yaml already there", async () => {
    let held: unknown = "unset";
    let setupThere = false;
    const result = await withStepWrite("language", async () => {
      held = currentConfigWriteLock();
      setupThere = fs.existsSync(setupFile());
      return null;
    });
    expect(result).toEqual({ status: "saved", step: "language" });
    expect(held).toBeNull();
    expect(setupThere).toBe(true);
  });

  it("calls onSaved with the saved result and returns what it returns", async () => {
    const onSaved = vi.fn((result: SetupStepResult) => ({ ...result, extra: 1 }));
    const result = await withStepWrite("language", async () => null, onSaved);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({ status: "saved", step: "language" });
    expect(result).toEqual({ status: "saved", step: "language", extra: 1 });
  });

  it("does not call onSaved, nor mark the step, when the write reports a problem; the problem comes back as it is", async () => {
    const onSaved = vi.fn((result: SetupStepResult) => result);
    const problem = stepError("language", "writeFailed");
    expect(await withStepWrite("language", async () => problem, onSaved)).toBe(problem);
    expect(onSaved).not.toHaveBeenCalled();
    expect(setup().steps).toEqual({});
  });

  it("the language step's result carries the locale of the saved step", async () => {
    expect(await saveLanguageStep({ ui_locale: "zh" })).toEqual({ status: "saved", step: "language", locale: "zh" });
  });
});
