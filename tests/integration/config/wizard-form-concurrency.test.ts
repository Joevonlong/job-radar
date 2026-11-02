import fs from "node:fs";
import path from "node:path";

import type { Sql } from "postgres";
import { parse } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { getUserConfigPath, loadConfig, resetConfigCache } from "@/lib/config";
import { setConfigWriteLockProviderForTests } from "@/lib/config/write-lock";
import { closeDb } from "@/lib/db";
import { acquireConfigWriteLock } from "@/lib/db/config-write-lock";
import { meConfigToDraft, preferencesConfigToDraft } from "@/lib/profile/draft";
import { saveProfile } from "@/lib/profile/service";
import { saveMarketStep } from "@/lib/setup/steps/market";

import { makeTempConfig, type TempConfig } from "../../config/helpers";
import { createIsolatedDb, type IsolatedDb } from "../../helpers/isolated-db";

import { connect, lockHolder, prepareInstall, waitUntil } from "./write-lock-helpers";

/**
 * A wizard step and a form save in one web process, with the real database lock. A hook holds the form's save between
 * the file lock it already has and the write lock it asks for next. A wizard step that held the write lock while it
 * waited for that file lock would deadlock the two until `lock_wait_seconds` ran out.
 */
const LOCK_WAIT_SECONDS = 3;

let iso: IsolatedDb;
let probe: Sql;
let temp: TempConfig;
let savedDatabaseUrl: string | undefined;

/** The real lock, except that the first caller stops before asking for it until `release()`. */
function holdFirstLockRequest(url: string): { stopped: Promise<void>; release: () => void; requests: () => number } {
  let release = (): void => {};
  let announce = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stopped = new Promise<void>((resolve) => { announce = resolve; });
  let requests = 0;
  setConfigWriteLockProviderForTests(async ({ waitSeconds }) => {
    requests += 1;
    if (requests === 1) {
      announce();
      await gate;
    }
    const result = await acquireConfigWriteLock(url, { waitSeconds });
    return result.acquired ? { acquired: true, lock: result.lock } : { acquired: false, holder: result.holder?.application ?? null };
  });
  return { stopped, release, requests: () => requests };
}

function marketInput(locations: string[]): unknown {
  return { market: { pack: "de", country: "DE", currency: "EUR", home_language: "de" }, locations, remote_scope: "none", timezone: "Europe/Berlin" };
}

const preferences = (): Record<string, unknown> => parse(fs.readFileSync(path.join(temp.profileDir, "preferences.yaml"), "utf8")) as Record<string, unknown>;

beforeAll(async () => {
  iso = await createIsolatedDb(inject("testDatabaseUrl"), "wizardform");
  probe = connect(iso.url);
  savedDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = iso.url; // the profile history's snapshots
}, 60_000);

afterAll(async () => {
  await closeDb();
  await probe?.end({ timeout: 2 });
  await iso?.drop();
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

beforeEach(() => {
  temp = makeTempConfig({ user: "init" });
  prepareInstall(temp, LOCK_WAIT_SECONDS);
  resetConfigCache();
});

afterEach(() => {
  setConfigWriteLockProviderForTests(null);
  temp.cleanup();
});

describe("a wizard step next to a settings form", () => {
  it("the same file: both finish well inside lock_wait_seconds, nobody is busy, and the file is one writer's whole result", async () => {
    const hook = holdFirstLockRequest(iso.url);
    const draft = { ...preferencesConfigToDraft(loadConfig("preferences")), locations: ["Form Town"] };

    const form = saveProfile("preferences", draft);
    await hook.stopped;
    const wizard = saveMarketStep(marketInput(["Wizard Town"]));

    // The step has done its first write (the pending setup file), and now waits for the form's file lock.
    await waitUntil("the wizard's pending setup file", () => fs.existsSync(getUserConfigPath("setup")));
    await waitUntil("the wizard to let go of the lock", async () => (await lockHolder(probe)) === null);
    const requests = hook.requests();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hook.requests(), "the step must wait for the file lock without asking for the write lock again").toBe(requests);
    expect(await lockHolder(probe), "the step must not hold the write lock while it waits for the file lock").toBeNull();

    const released = Date.now();
    hook.release();
    const [formResult, wizardResult] = await Promise.all([form, wizard]);
    expect(Date.now() - released).toBeLessThan(LOCK_WAIT_SECONDS * 1000);

    expect(formResult.status).toBe("saved");
    expect(JSON.stringify(wizardResult)).not.toContain("busy");
    expect(wizardResult.status === "saved" || (wizardResult.status === "error" && wizardResult.formError === "writeFailed"), JSON.stringify(wizardResult)).toBe(true);

    const file = preferences();
    expect(file.locations).toEqual(wizardResult.status === "saved" ? ["Wizard Town"] : ["Form Town"]);
    expect(file.target_titles).toBeDefined(); // the rest of the file is still there
    expect(await lockHolder(probe)).toBeNull();
  });

  it("different files: the step does not wait for the form at all, and both are saved", async () => {
    const hook = holdFirstLockRequest(iso.url);
    const draft = { ...meConfigToDraft(loadConfig("me")), city: "Form City" };

    const form = saveProfile("me", draft);
    await hook.stopped;

    const wizardResult = await saveMarketStep(marketInput(["Wizard Town"]));
    expect(wizardResult.status, JSON.stringify(wizardResult)).toBe("saved");

    hook.release();
    expect((await form).status).toBe("saved");

    expect(preferences().locations).toEqual(["Wizard Town"]);
    expect((parse(fs.readFileSync(path.join(temp.profileDir, "me.yaml"), "utf8")) as Record<string, unknown>).city).toBe("Form City");
  });
});
