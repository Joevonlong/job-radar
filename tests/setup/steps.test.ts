// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureProfileFiles, getConfigPath, reloadConfig, setOnProfileSaved, type ConfigName } from "@/lib/config";
import { meConfigToDraft } from "@/lib/profile/draft";
import { countryDefaults, loadSetupView, profileDraft, readinessOf } from "@/lib/setup/view";
import { resetPackCache } from "@/lib/market";
import { readSetupState, resetSetupStateCache } from "@/lib/setup/state";
import { saveAiStep } from "@/lib/setup/steps/ai";
import { saveLanguageStep } from "@/lib/setup/steps/language";
import { saveMarketStep } from "@/lib/setup/steps/market";
import { saveProfileStep } from "@/lib/setup/steps/profile";
import { finishSetup, skipSetupStep } from "@/lib/setup/steps/review";
import { saveSourcesStep } from "@/lib/setup/steps/sources";
import { saveTargetsStep } from "@/lib/setup/steps/targets";
import { saveTelegramStep } from "@/lib/setup/steps/telegram";
import type { MarketInput, TargetsInput } from "@/lib/setup/inputs";

import { UNREACHABLE_DATABASE_URL } from "@/lib/db/test-guard";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
const savedUrl = process.env.DATABASE_URL;

beforeEach(async () => {
  // no database in unit tests (an unreachable URL, never "unset", which once meant the compose database): the profile
  // history snapshot fails and the file still counts as written
  process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
  tmp = makeTempConfig();
  await ensureProfileFiles();
  resetSetupStateCache();
});
afterEach(() => {
  setOnProfileSaved(null);
  tmp.cleanup();
  if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
});

const text = (name: ConfigName): string => fs.readFileSync(getConfigPath(name), "utf8");
const snapshot = (...names: ConfigName[]): string[] => names.map(text);
const stepStatus = (id: string): string | undefined => (readSetupState().state?.steps as Record<string, { status: string } | undefined> | undefined)?.[id]?.status;

const MARKET: MarketInput = { market: { pack: "generic", country: "NL", currency: "EUR", home_language: "nl" }, locations: ["Amsterdam", "Utrecht"], remote_scope: "region:eu", timezone: "Europe/Amsterdam" };

describe("language", () => {
  it("saves the interface language and marks the step", async () => {
    const result = await saveLanguageStep({ ui_locale: "en" });
    expect(result).toMatchObject({ status: "saved", step: "language", locale: "en" });
    expect(stepStatus("language")).toBe("done");
  });

  it("writes the default interface language, the AI output and the translation target to language.yaml", async () => {
    expect(await saveLanguageStep({ ui_locale: "zh", ai_output: "de", translation_target: "pt-BR" })).toMatchObject({ status: "saved", locale: "zh" });
    const language = reloadConfig("language");
    expect(language.ui.default_locale).toBe("zh");
    expect(language.ai.output).toBe("de");
    expect(language.ai.summary_also).not.toContain("de");
    expect(language.translation.target).toBe("pt-BR");
  });

  it("rejects a bad language code and anything that is not the step's input", async () => {
    expect(await saveLanguageStep({ ui_locale: "en", ai_output: "English!" })).toMatchObject({ status: "error", fieldErrors: [{ path: "ai_output", key: "languageCode" }] });
    expect(await saveLanguageStep({ ui_locale: "fr" })).toMatchObject({ status: "error", formError: "invalidPayload" });
    expect(await saveLanguageStep("en")).toMatchObject({ status: "error", formError: "invalidPayload" });
    expect(stepStatus("language")).toBeUndefined();
  });
});

describe("market", () => {
  it("writes the market, cities and remote scope to preferences and search, the time zone to schedule", async () => {
    expect(await saveMarketStep(MARKET)).toEqual({ status: "saved", step: "market" });
    const prefs = reloadConfig("preferences");
    expect(prefs.market).toEqual({ pack: "generic", country: "NL", currency: "EUR", home_language: "nl" });
    expect(prefs.locations).toEqual(["Amsterdam", "Utrecht"]);
    expect(prefs.remote_scope).toEqual({ region: ["eu"] });
    const search = reloadConfig("search");
    expect(search.locations).toEqual(["Amsterdam", "Utrecht"]);
    expect(search.remote_scope).toEqual({ region: ["eu"] });
    expect(reloadConfig("schedule").timezone).toBe("Europe/Amsterdam");
    expect(stepStatus("market")).toBe("done");
  });

  it.each([
    ["an unknown time zone", { ...MARKET, timezone: "Mars/Olympus" }, "timezone"],
    ["no city", { ...MARKET, locations: [] }, "locations"],
    ["an unknown pack", { ...MARKET, market: { ...MARKET.market, pack: "atlantis" } }, "market.pack"],
    ["a generic pack without a country", { ...MARKET, market: { pack: "generic", country: "", currency: "EUR", home_language: "nl" } }, "market.country"],
  ])("reports %s next to the field and writes nothing", async (_name, input, path) => {
    const before = snapshot("preferences", "search", "schedule");
    const result = await saveMarketStep(input);
    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors.map((e) => e.path) : []).toContain(path);
    expect(snapshot("preferences", "search", "schedule")).toEqual(before);
    expect(stepStatus("market")).toBeUndefined();
  });
});

describe("market defaults of a picked country", () => {
  it("proposes the currency of the country's own pack or of the country table, and the country's main city", () => {
    const geography = path.join(tmp.defaultsDir, "packs", "generic", "geography.yaml");
    fs.writeFileSync(geography, fs.readFileSync(geography, "utf8").replace("{code: GB, name:", "{code: GB, currency: GBP, name:"));
    resetPackCache();
    const defaults = countryDefaults();
    expect(defaults.GB).toEqual({ currency: "GBP", city: "London" });
    expect(defaults.DE).toEqual({ currency: "EUR", city: "Berlin" });
    // a country the tables know nothing about has no entry: the step then asks for a currency
    expect(defaults.AQ).toBeUndefined();
  });

  it("the profile step starts with a city of the market step until it is saved once", () => {
    const draft = { ...meConfigToDraft(reloadConfig("me")), city: "New York" };
    expect(profileDraft(draft, ["London", "Manchester"]).city).toBe("London");
    expect(profileDraft(draft, ["new york"]).city).toBe("New York");
    // saved once (null), or no city chosen: left alone
    expect(profileDraft(draft, null).city).toBe("New York");
    expect(profileDraft(draft, []).city).toBe("New York");
  });
});

describe("profile", () => {
  it("writes me.yaml with the comments kept", async () => {
    const draft = { ...meConfigToDraft(reloadConfig("me")), summary: "Backend engineer.", skills: [{ name: "Python", years: "5" }], years_experience: "7", city: "Utrecht" };
    expect(await saveProfileStep(draft)).toEqual({ status: "saved", step: "profile" });
    const me = reloadConfig("me");
    expect(me).toMatchObject({ summary: "Backend engineer.", skills: [{ name: "Python", years: 5 }], years_experience: 7, city: "Utrecht" });
    expect(text("me")).toContain("#");
    expect(stepStatus("profile")).toBe("done");
  });

  it("reports field errors with the profile page's keys", async () => {
    const before = text("me");
    const draft = { ...meConfigToDraft(reloadConfig("me")), years_experience: "many", city: "" };
    const result = await saveProfileStep(draft);
    expect(result.status).toBe("error");
    const errors = result.status === "error" ? result.fieldErrors : [];
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "years_experience", ns: "profile", key: "number" }), expect.objectContaining({ path: "city", ns: "profile", key: "required" })]));
    expect(text("me")).toBe(before);
  });
});

describe("targets", () => {
  const targets = (extra: Partial<TargetsInput> = {}): TargetsInput => ({
    target_titles: ["Data Engineer", "Analytics Engineer"],
    seniority: "senior",
    workplace: ["hybrid", "remote"],
    salary_floor_year: "60000",
    contracts: { permanent: "allow", fixed_term: "none", freelance: "none", temp_agency: "exclude" },
    exclude_student_roles: true,
    exclude_companies: ["Example Staffing"],
    exclude_keywords: ["unpaid"],
    ...extra,
  });

  it("writes preferences and replaces the shipped keyword groups with the titles", async () => {
    expect(await saveTargetsStep(targets())).toEqual({ status: "saved", step: "targets" });
    const prefs = reloadConfig("preferences");
    expect(prefs).toMatchObject({ target_titles: ["Data Engineer", "Analytics Engineer"], seniority: "senior", workplace: ["hybrid", "remote"], salary_floor_year: 60000, contracts: { allow: ["permanent"], exclude: ["temp_agency"] } });
    expect(reloadConfig("search").keyword_groups).toEqual({ targets: ["Data Engineer", "Analytics Engineer"] });
  });

  it("keeps keyword groups the user changed", async () => {
    const search = structuredClone(reloadConfig("search"));
    const { writeConfig } = await import("@/lib/config");
    await writeConfig("search", { ...search, keyword_groups: { mine: ["Platform Engineer"] } });
    await saveTargetsStep(targets());
    expect(reloadConfig("search").keyword_groups).toEqual({ mine: ["Platform Engineer"], targets: ["Data Engineer", "Analytics Engineer"] });
  });

  it("reports a bad salary and no titles, writing nothing", async () => {
    const before = snapshot("preferences", "search");
    const result = await saveTargetsStep(targets({ salary_floor_year: "lots", target_titles: [] }));
    const paths = result.status === "error" ? result.fieldErrors.map((e) => e.path) : [];
    expect(paths).toEqual(expect.arrayContaining(["salary_floor_year", "target_titles"]));
    expect(snapshot("preferences", "search")).toEqual(before);
  });
});

describe("sources", () => {
  it("switches channels and adds a career board", async () => {
    const result = await saveSourcesStep({ channels: { greenhouse: false, lever: true }, boards: [{ name: "Example Co", ats: "greenhouse", token: "exampleco" }] });
    expect(result).toEqual({ status: "saved", step: "sources" });
    const channels = reloadConfig("channels");
    expect(channels.sources.greenhouse.enabled).toBe(false);
    expect(channels.sources.lever.enabled).toBe(true);
    expect(channels.ats_boards.some((b) => b.ats === "greenhouse" && b.token === "exampleco" && b.enabled)).toBe(true);
  });

  it("refuses to switch a scraping channel on without the acknowledgement and writes nothing", async () => {
    await saveSourcesStep({ channels: { indeed: false, stepstone: false } });
    const before = text("channels");
    const result = await saveSourcesStep({ channels: { indeed: true, greenhouse: false } });
    expect(result.status).toBe("error");
    const errors = result.status === "error" ? result.fieldErrors : [];
    expect(errors).toEqual([expect.objectContaining({ path: "acknowledge", key: "consentRequired" })]);
    expect(text("channels")).toBe(before);
  });

  it("switches a scraping channel on once the acknowledgement is given, and does not ask again for one that is already on", async () => {
    await saveSourcesStep({ channels: { indeed: false } });
    expect(await saveSourcesStep({ channels: { indeed: true }, acknowledge: true })).toEqual({ status: "saved", step: "sources" });
    expect(reloadConfig("channels").sources.indeed.enabled).toBe(true);
    // the step was saved before and indeed is on: submitting it as it is needs no new acknowledgement
    expect(await saveSourcesStep({ channels: { indeed: true, greenhouse: false } })).toEqual({ status: "saved", step: "sources" });
  });

  it("refuses an unknown channel, a duplicate board and a bad ATS before writing anything", async () => {
    const before = text("channels");
    const existing = reloadConfig("channels").ats_boards[0];
    const result = await saveSourcesStep({
      channels: { nope: true, greenhouse: false },
      boards: [
        ...(existing ? [{ name: "Again", ats: existing.ats, token: existing.token.toUpperCase() }] : []),
        { name: "X", ats: "workday", token: "x" },
      ],
    });
    const errors = result.status === "error" ? result.fieldErrors : [];
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "channels.nope", key: "invalidChoice" })]));
    if (existing) expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "boards.0.token", key: "boardDuplicate" })]));
    expect(errors.some((e) => e.path.endsWith(".ats"))).toBe(true);
    expect(text("channels")).toBe(before);
  });
});

describe("readiness of the channels", () => {
  it("an ATS channel without any company board does not make the channels ready", () => {
    const config = structuredClone(reloadConfig("channels"));
    for (const block of [config.linkedin.brightdata, config.linkedin.apify, config.linkedin.monid, config.linkedin.session, config.linkedin.guest, ...Object.values(config.sources)]) block.enabled = false;
    config.sources.greenhouse.enabled = true;
    config.ats_boards = [];
    const heartbeats = { runnerOnline: true, worker: null };
    expect(readinessOf({ channels: config, ai: null, heartbeats, env: {} }).find((i) => i.id === "channels")).toMatchObject({ status: "fail", params: { state: "none" } });
    config.ats_boards = [{ name: "Example Co", ats: "greenhouse", token: "exampleco", enabled: true }];
    expect(readinessOf({ channels: config, ai: null, heartbeats, env: {} }).find((i) => i.id === "channels")?.status).toBe("ok");
  });
});

describe("ai", () => {
  it("switches providers, sets the order and the models", async () => {
    const result = await saveAiStep({ order: ["claude-cli", "api", "codex-cli"], providers: { mimo: { enabled: false }, "claude-cli": { enabled: true, model: "claude-sonnet-5-5", strong_model: "claude-opus-5-5" } } });
    expect(result).toEqual({ status: "saved", step: "ai" });
    const ai = reloadConfig("ai");
    expect(ai.order).toEqual(["claude-cli", "api", "codex-cli"]);
    expect(ai.providers.mimo.enabled).toBe(false);
    expect(ai.providers.claude_cli).toMatchObject({ model: "claude-sonnet-5-5", strong_model: "claude-opus-5-5" });
  });

  it("refuses a model that is not in models.yaml and an empty order", async () => {
    const before = text("ai");
    const result = await saveAiStep({ providers: { "claude-cli": { enabled: true, model: "claude-imaginary-9" } } });
    expect(result).toMatchObject({ status: "error", fieldErrors: [{ path: "providers.claude-cli.model", key: "notInCatalog", params: { model: "claude-imaginary-9" } }] });
    expect(await saveAiStep({ order: [], providers: {} })).toMatchObject({ status: "error", fieldErrors: [{ path: "order", key: "orderEmpty" }] });
    expect(text("ai")).toBe(before);
  });
});

describe("telegram, skip and finish", () => {
  it("switches Telegram and sets the message language", async () => {
    const before = reloadConfig("notify").telegram.enabled;
    expect(await saveTelegramStep({ enabled: !before, notify_locale: "en" })).toEqual({ status: "saved", step: "telegram" });
    expect(reloadConfig("notify").telegram.enabled).toBe(!before);
    expect(reloadConfig("language").notify.locale).toBe("en");
    await saveTelegramStep({ enabled: !before, notify_locale: null });
    expect(reloadConfig("language").notify.locale).toBeNull();
  });

  it("skip records the step and writes no config", async () => {
    const files: ConfigName[] = ["ai", "channels", "notify", "search", "schedule", "preferences", "me"];
    const before = snapshot(...files);
    expect(await skipSetupStep("ai")).toEqual({ status: "skipped", step: "ai" });
    expect(stepStatus("ai")).toBe("skipped");
    expect(snapshot(...files)).toEqual(before);
    expect(await skipSetupStep("nope")).toMatchObject({ status: "error", formError: "invalidPayload" });
  });

  it("skipping Telegram switches it off unless a bot is configured", async () => {
    const saved = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
    try {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
      await saveTelegramStep({ enabled: true });
      expect(reloadConfig("notify").telegram.enabled).toBe(true);
      expect(await skipSetupStep("telegram")).toEqual({ status: "skipped", step: "telegram" });
      expect(reloadConfig("notify").telegram.enabled).toBe(false);
      expect(stepStatus("telegram")).toBe("skipped");

      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      await saveTelegramStep({ enabled: true });
      await skipSetupStep("telegram");
      expect(reloadConfig("notify").telegram.enabled).toBe(true);
    } finally {
      if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = saved.token;
      if (saved.chat === undefined) delete process.env.TELEGRAM_CHAT_ID;
      else process.env.TELEGRAM_CHAT_ID = saved.chat;
    }
  });

  it("finish completes the setup; skipping the wizard says so", async () => {
    expect(readSetupState().pending).toBe(true);
    expect(await finishSetup("wizard")).toEqual({ status: "saved", step: "review" });
    expect(readSetupState()).toMatchObject({ pending: false, state: { completed_by: "wizard", steps: { review: { status: "done" } } } });
  });

  it("skipping the wizard marks it complete without touching the config", async () => {
    const before = snapshot("ai", "search", "preferences");
    await finishSetup("skipped");
    expect(readSetupState()).toMatchObject({ pending: false, state: { completed_by: "skipped" } });
    expect(readSetupState().state?.steps.review).toBeUndefined();
    expect(snapshot("ai", "search", "preferences")).toEqual(before);
    expect(fs.existsSync(path.join(tmp.configDir, "setup.yaml"))).toBe(true);
  });
});

describe("existing installs", () => {
  it("the view marks an install from before the wizard, a fresh one is not", async () => {
    expect((await loadSetupView({ locale: "en", acceptLanguage: null })).existingInstall).toBe(false);
    await finishSetup("wizard");
    expect((await loadSetupView({ locale: "en", acceptLanguage: null })).existingInstall).toBe(false);
    fs.writeFileSync(path.join(tmp.configDir, "setup.yaml"), "completed_at: 2026-10-09T08:00:00.000Z\ncompleted_by: existing_install\nsteps: {}\n");
    resetSetupStateCache();
    expect((await loadSetupView({ locale: "en", acceptLanguage: null })).existingInstall).toBe(true);
  });
});
