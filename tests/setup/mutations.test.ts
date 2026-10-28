// @vitest-environment node
import fs from "node:fs";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isNode, parseDocument } from "yaml";

import { ensureProfileFiles, getUserConfigPath, reloadConfig, type ConfigName } from "@/lib/config";
import { withFileLock } from "@/lib/config/write";
import { preferencesConfigToDraft } from "@/lib/profile/draft";
import { syncSearchLocations } from "@/lib/profile/search-locations";
import { completeSetup, markStep, resetSetupStateCache } from "@/lib/setup/state";
import { saveAiStep } from "@/lib/setup/steps/ai";
import { saveLanguageStep, writeNotifyLocale } from "@/lib/setup/steps/language";
import { saveMarketStep } from "@/lib/setup/steps/market";
import { saveTargetsStep } from "@/lib/setup/steps/targets";
import { disableTelegramIfUnconfigured, saveTelegramStep } from "@/lib/setup/steps/telegram";

import { makeTempConfig, type TempConfig } from "../config/helpers";

vi.mock("@/lib/profile/snapshots", () => ({ registerProfileSnapshotHook: () => undefined }));

let tmp: TempConfig;
beforeEach(async () => {
  tmp = makeTempConfig();
  await ensureProfileFiles();
  resetSetupStateCache();
});
afterEach(() => tmp.cleanup());

const market = { market: { pack: "generic", country: "NL", currency: "EUR", home_language: "nl" }, locations: ["Amsterdam"], remote_scope: "home_country", timezone: "Europe/Amsterdam" };
function targets() {
  const { seniority, workplace, salary_floor_year, contracts, exclude_student_roles, exclude_companies, exclude_keywords } = preferencesConfigToDraft(reloadConfig("preferences"));
  return { target_titles: ["Data Engineer"], seniority, workplace, salary_floor_year, contracts, exclude_student_roles, exclude_companies, exclude_keywords };
}

/** Queue the wizard behind a writer that finishes after the wizard has started. */
async function interleave<T>(name: ConfigName, run: () => Promise<T>, update: (file: string) => void): Promise<T> {
  const file = getUserConfigPath(name);
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = withFileLock(file, async () => { enter(); await gate; update(file); });
  await entered;
  const result = run();
  try { await new Promise<void>((resolve) => setImmediate(resolve)); } finally { release(); }
  await writer;
  return result;
}

function setKey(file: string, key: string[], value: unknown): void {
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  doc.setIn(key, value);
  fs.writeFileSync(file, String(doc));
}

it("keeps cities synced by another tab while the targets profile save is waiting", async () => {
  const file = getUserConfigPath("preferences");
  let release: () => void = () => undefined;
  let enter: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const writer = withFileLock(file, async () => { enter(); await gate; });
  await entered;
  const saving = saveTargetsStep({ ...targets(), target_titles: ["Platform Engineer"] });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await syncSearchLocations(["Austin"])).toMatchObject({ status: "done" });
  } finally { release(); }
  await writer;
  expect(await saving).toMatchObject({ status: "saved" });
  expect(reloadConfig("search")).toMatchObject({ locations: ["Austin"], keyword_groups: { targets: ["Platform Engineer"] } });
});

it.each([
  { name: "preferences" as const, run: () => saveTargetsStep(targets()), key: ["locations"], value: ["Austin"] },
  { name: "preferences" as const, run: () => saveMarketStep(market), key: ["target_titles"], value: ["Platform Engineer"] },
  { name: "search" as const, run: () => saveMarketStep(market), key: ["keyword_groups"], value: { custom: ["Platform Engineer"] } },
  { name: "schedule" as const, run: () => saveMarketStep(market), key: ["manual_triggers", "min_interval_seconds"], value: 77 },
  { name: "language" as const, run: () => saveLanguageStep({ ui_locale: "zh" }), key: ["notify", "locale"], value: "en" },
  { name: "language" as const, run: () => writeNotifyLocale("zh"), key: ["translation", "target"], value: "fr" },
  { name: "ai" as const, run: () => saveAiStep({ providers: { mimo: { enabled: false } } }), key: ["order"], value: ["api", "codex-cli"] },
  { name: "notify" as const, run: () => saveTelegramStep({ enabled: false }), key: ["push_min_score"], value: 73 },
  { name: "notify" as const, run: () => disableTelegramIfUnconfigured({}), key: ["push_min_score"], value: 73 },
])("preserves another writer's $name settings when the step is queued ($key)", async ({ name, run, key, value }) => {
  if (name === "notify") setKey(getUserConfigPath(name), ["telegram", "enabled"], true);
  await interleave<unknown>(name, run, (file) => setKey(file, key, value));
  const doc = parseDocument(fs.readFileSync(getUserConfigPath(name), "utf8"));
  const node = doc.getIn(key, true);
  expect(isNode(node) ? node.toJSON() : node).toEqual(value);
});

it("preserves parallel progress updates and the first completion", async () => {
  await interleave("setup", () => Promise.all([markStep("language", "done"), markStep("ai", "skipped"), completeSetup("wizard")]), (file) => {
    setKey(file, ["completed_at"], "2026-10-09T08:00:00.000Z");
    setKey(file, ["completed_by"], "cli");
  });
  expect(reloadConfig("setup")).toMatchObject({ completed_by: "cli", steps: { language: { status: "done" }, ai: { status: "skipped" } } });
});
