// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfigText } from "@/lib/config";
import { setConfigWriteLockProviderForTests } from "@/lib/config/write-lock";
import { readSetupState, resetSetupStateCache } from "@/lib/setup/state";
import { saveLanguageStep } from "@/lib/setup/steps/language";
import { finishSetup, skipSetupStep } from "@/lib/setup/steps/review";

import { inProcessConfigWriteLock } from "../config/in-process-lock";
import { makeTempConfig, type TempConfig } from "../config/helpers";

/**
 * A step's last commit is the mark in setup.yaml. When only that commit fails, the step's own files are written, setup.yaml
 * stays pending, and the step reports the problem instead of `saved`.
 */
let tmp: TempConfig;
const setupFile = () => path.join(tmp.configDir, "setup.yaml");
const languageFile = () => path.join(tmp.configDir, "language.yaml");
const setup = () => parseConfigText("setup", fs.readFileSync(setupFile(), "utf8"));

beforeEach(() => {
  tmp = makeTempConfig({ user: "empty" });
  resetSetupStateCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  setConfigWriteLockProviderForTests(inProcessConfigWriteLock);
  tmp.cleanup();
});

/**
 * The ownership check says the lock was lost for every commit that starts once `after()` is true. The mark replaces an
 * existing setup.yaml, the creation of that file and the step's own file come earlier, so `after` tells them apart.
 */
function loseLockWhen(after: () => boolean): void {
  setConfigWriteLockProviderForTests(async () => ({ acquired: true, lock: { fence: async () => !after(), release: async () => {} } }));
}

/** The commit of an existing setup.yaml fails with an I/O error (the first creation publishes with a link, not a rename). */
function failSetupRename(): void {
  const rename = fs.renameSync.bind(fs);
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (path.basename(String(to)) === "setup.yaml") throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
    return rename(from, to);
  });
}

describe("the language step when the mark cannot be committed", () => {
  it("with an I/O error: `setupUnreadable`, no locale, the language written, the setup still pending and the step not marked", async () => {
    failSetupRename();
    const result = await saveLanguageStep({ ui_locale: "en", ai_output: "de" });
    expect(result).toEqual({ status: "error", step: "language", fieldErrors: [], formError: "setupUnreadable" });
    expect(result).not.toHaveProperty("locale");
    expect(parseConfigText("language", fs.readFileSync(languageFile(), "utf8")).ai.output).toBe("de");
    expect(setup()).toMatchObject({ completed_at: null, steps: {} });
    expect(readSetupState().pending).toBe(true);
    // no temp file left behind
    expect(fs.readdirSync(tmp.configDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("with a lost lock session: `busy`, same state", async () => {
    loseLockWhen(() => fs.existsSync(languageFile()));
    const result = await saveLanguageStep({ ui_locale: "en", ai_output: "de" });
    expect(result).toEqual({ status: "error", step: "language", fieldErrors: [], formError: "busy" });
    expect(result).not.toHaveProperty("locale");
    expect(parseConfigText("language", fs.readFileSync(languageFile(), "utf8")).ai.output).toBe("de");
    expect(setup()).toMatchObject({ completed_at: null, steps: {} });
  });

  it("the next save, once the commit works again, marks the step", async () => {
    failSetupRename();
    await saveLanguageStep({ ui_locale: "en" });
    vi.restoreAllMocks();
    resetSetupStateCache();
    expect(await saveLanguageStep({ ui_locale: "en" })).toMatchObject({ status: "saved", locale: "en" });
    expect(setup().steps.language?.status).toBe("done");
  });
});

describe("skipping a step when the mark cannot be committed", () => {
  it("with an I/O error: `setupUnreadable`, not `skipped`, and the step is not marked", async () => {
    failSetupRename();
    expect(await skipSetupStep("ai")).toEqual({ status: "error", step: "ai", fieldErrors: [], formError: "setupUnreadable" });
    expect(setup()).toMatchObject({ completed_at: null, steps: {} });
  });

  it("with a lost lock session: `busy`", async () => {
    loseLockWhen(() => fs.existsSync(setupFile()));
    expect(await skipSetupStep("ai")).toEqual({ status: "error", step: "ai", fieldErrors: [], formError: "busy" });
    expect(setup()).toMatchObject({ completed_at: null, steps: {} });
  });
});

describe("finishing the setup when the mark cannot be committed", () => {
  it("never reports it done and leaves the setup pending", async () => {
    failSetupRename();
    expect(await finishSetup("wizard")).toMatchObject({ status: "error", step: "review", formError: "setupUnreadable" });
    expect(setup()).toMatchObject({ completed_at: null, completed_by: null, steps: {} });
    expect(readSetupState().pending).toBe(true);
  });

  it("with a lost lock session: `busy`", async () => {
    loseLockWhen(() => fs.existsSync(setupFile()));
    expect(await finishSetup("wizard")).toMatchObject({ status: "error", step: "review", formError: "busy" });
    expect(readSetupState().pending).toBe(true);
  });
});
