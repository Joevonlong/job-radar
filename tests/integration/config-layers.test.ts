import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { configLayer, ensureProfileFiles, hashConfigText, loadConfig, readConfigText, reloadConfig, setOnProfileSaved } from "@/lib/config";
import { closeDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { addWatchedCompany } from "@/lib/interests/service";
import { preferencesConfigToDraft } from "@/lib/profile/draft";
import { saveProfile } from "@/lib/profile/service";
import { configToDraft } from "@/lib/settings/draft";
import { saveSettings } from "@/lib/settings/service";
import { setSourceEnabled } from "@/lib/sources/registry/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

/**
 * Acceptance: on a fresh install (empty user directory, everything read from the defaults) the web's saves
 * (settings, profile, interests, source registry) write the user and profile directories only; the shipped defaults
 * never change.
 */
const url = inject("testDatabaseUrl");
let temp: TempConfig;

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[path.relative(dir, path.join(entry.parentPath, entry.name))] = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
  }
  return out;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
  setOnProfileSaved(null);
});
afterEach(() => temp.cleanup());
afterAll(async () => {
  await closeDb();
});

describe("web saves land in the user directory", () => {
  it("settings, profile, interests and the source registry leave the defaults untouched", async () => {
    const defaults = snapshot(temp.defaultsDir);
    expect(configLayer("search")).toBe("default");

    const draft = configToDraft("search", loadConfig("search"));
    draft["window_hours.morning"] = "30";
    expect(await saveSettings({ tab: "search", draft, baseHash: hashConfigText(readConfigText("search")) })).toMatchObject({ status: "saved" });
    await ensureProfileFiles();
    expect(await saveProfile("preferences", { ...preferencesConfigToDraft(reloadConfig("preferences")), salary_floor_year: "75000" })).toMatchObject({ status: "saved" });
    expect(await addWatchedCompany({ name: "Layered GmbH" })).toMatchObject({ status: "saved" });
    expect(await setSourceEnabled({ id: "indeed", enabled: false })).toMatchObject({ status: "done" });

    expect(snapshot(temp.defaultsDir)).toEqual(defaults);
    expect(fs.readdirSync(temp.configDir).sort()).toEqual(["interests.yaml", "search.yaml", "sources.yaml"]);
    expect(fs.readFileSync(path.join(temp.configDir, "search.yaml"), "utf8")).toContain("morning: 30");
    expect(fs.readFileSync(path.join(temp.profileDir, "preferences.yaml"), "utf8")).toContain("75000");
    expect(reloadConfig("interests").watched_companies).toContain("Layered GmbH");
    expect(reloadConfig("channels").sources.indeed.enabled).toBe(false);
    // the files the user saved carry the shipped comments over
    expect(fs.readFileSync(path.join(temp.configDir, "sources.yaml"), "utf8")).toContain("# 熔断：连续失败 failures 次后");
  });
});
