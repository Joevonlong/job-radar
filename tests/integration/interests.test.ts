import { withRebuiltCurrentScores } from "../helpers/current-scores";
import fs from "node:fs";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { searchPlan } from "../fixtures/job-search";
import { ChannelRegistry } from "@/lib/channels/registry";
import { getConfigPath, loadConfig, reloadConfig, writeConfig, type NotifyConfig } from "@/lib/config";
import { runCycle } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, listTodayJobs, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { addWatchedCompany, deleteView, describeWatchedCompanies, removeWatchedCompany, renameView, saveView, saveVocabulary, setDefaultView, suggestCompanyNames } from "@/lib/interests/service";
import { loadInterestsPage } from "@/lib/interests/view";
import { configToDraft, newCategoryDraft, type CategoryDraft, type VocabularyDraft } from "@/lib/interests/vocabulary-draft";
import { createNotifyStep } from "@/lib/notify/step";
import { createTelegramClient } from "@/lib/notify/telegram-client";
import { resolveCompanyName } from "@/lib/pipeline/company";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { FAKE_TOKEN, FakeBotApi } from "../notify/fake-bot-api";
import { notifyConfig } from "../notify/helpers";
import { loadPipeline } from "@/lib/market";

const url = inject("testDatabaseUrl");
const db = () => getDb();
const CHAT = "777";
const api = new FakeBotApi();
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  await api.start();
});

const resetTables = () => db().execute(sql`truncate table jobs, companies, cycles, channels, notifications, applications, signals, scores, ai_usage restart identity cascade`);

beforeEach(async () => {
  temp = makeTempConfig();
  await resetTables();
  api.reset();
  resetCycleSteps();
});

afterEach(() => {
  resetCycleSteps();
  temp.cleanup();
});

afterAll(async () => {
  await api.stop();
  await resetTables();
  await closeDb();
});

const yaml = () => fs.readFileSync(getConfigPath("interests"), "utf8");
const stateOf = (state: Awaited<ReturnType<typeof saveView>>) => state.status;

// ---------------------------------------------------------------- seed helpers

async function seedCompany(name: string): Promise<number> {
  const { nameNorm } = resolveCompanyName(name, loadPipeline());
  await db().insert(schema.companies).values({ name, nameNorm }).onConflictDoNothing({ target: schema.companies.nameNorm });
  const [company] = await db().select().from(schema.companies).where(eq(schema.companies.nameNorm, nameNorm));
  return company!.id;
}

async function seedJob(job: { title: string; company?: string; rank?: number; match?: number; bonus?: number; tiers?: Array<"T1" | "T2" | "T3" | "T4">; firstSeenAt?: Date; city?: string }): Promise<number> {
  const companyId = await seedCompany(job.company ?? "Acme GmbH");
  const [row] = await db()
    .insert(schema.jobs)
    .values({
      companyId,
      title: job.title,
      titleNorm: job.title.toLowerCase(),
      locationsJson: [{ label: `${job.city ?? "Berlin"}, Germany`, city: job.city ?? "Berlin", countryCode: "DE", isPrimary: true }],
      workplace: "hybrid",
      firstSeenAt: job.firstSeenAt ?? new Date(Date.now() + 60_000),
    })
    .returning();
  const id = row!.id;
  if (job.rank !== undefined) {
    await withRebuiltCurrentScores(db(), db().insert(schema.scores).values({ jobId: id, filterResult: "passed", score: job.match ?? job.rank, signalBonus: job.bonus ?? 0, rankValue: job.rank, summaryZh: `${job.title} 的摘要` }));
  }
  for (const tier of job.tiers ?? []) await db().insert(schema.signals).values({ jobId: id, tier, kind: "test", quote: "quoted text", extractor: "rule" });
  return id;
}

/** A category of a draft. */
const cat = (draft: VocabularyDraft, id: string): CategoryDraft => {
  const found = draft.categories.find((c) => c.id === id);
  if (!found) throw new Error(`no category ${id}`);
  return found;
};
/** A category of the config file. */
const configCategory = (id: string) => reloadConfig("interests").signals.categories.find((c) => c.id === id);

const scoreOf = async (jobId: number) => (await db().select().from(schema.scores).where(eq(schema.scores.jobId, jobId)))[0]!;

// ---------------------------------------------------------------- vocabulary

describe("saveVocabulary", () => {
  it("changes a T2 keyword and weight: the YAML is updated (comments stay) and the rank values are recomputed without AI", async () => {
    const withEquity = await seedJob({ title: "Equity Role", rank: 78, match: 70, bonus: 8, tiers: ["T2"] });
    const plain = await seedJob({ title: "Plain Role", rank: 60, match: 60 });

    const draft = configToDraft(loadConfig("interests"));
    cat(draft, "T2").keywords.push("Anteile");
    cat(draft, "T2").weight = "5";
    const before = yaml();
    expect(before).toContain("# T2：股权或期权");

    const result = await saveVocabulary(draft);
    expect(result).toMatchObject({ status: "saved", section: "vocabulary", recompute: { reconciled: true, checked: 1, updated: 1, rescanPending: true } });

    const after = yaml();
    expect(after).toContain("Anteile");
    expect(after).toMatch(/- id: T2\n(?:\s+.*\n)*?\s+weight: 5\n/);
    expect(after).toContain("# T2：股权或期权");
    expect(configCategory("T2")).toMatchObject({ weight: 5 });
    const t2 = configCategory("T2");
    expect(t2?.kind === "keyword" && t2.keywords).toContain("Anteile");

    expect(await scoreOf(withEquity)).toMatchObject({ signalBonus: 5, rankValue: 75 });
    expect(await scoreOf(plain)).toMatchObject({ signalBonus: 0, rankValue: 60 });
  });

  it("a lower cap and a weights-only change recompute the ranking and need no re-scan", async () => {
    const job = await seedJob({ title: "Equity Role", rank: 78, match: 70, bonus: 8, tiers: ["T2"] });
    const draft = configToDraft(loadConfig("interests"));
    draft.bonusCap = "3";
    const result = await saveVocabulary(draft);
    expect(result).toMatchObject({ status: "saved", recompute: { reconciled: true, updated: 1, rescanPending: false } });
    expect(await scoreOf(job)).toMatchObject({ signalBonus: 3, rankValue: 73 });
  });

  it("invalid input comes back as field errors and leaves the file untouched", async () => {
    const draft = configToDraft(loadConfig("interests"));
    cat(draft, "T3").patterns = ["", "(unclosed"];
    cat(draft, "T1").weight = "ten";
    const before = yaml();
    const result = await saveVocabulary(draft);
    expect(result).toMatchObject({ status: "error", section: "vocabulary", formError: null });
    if (result.status !== "error") return;
    expect(result.fieldErrors).toEqual(expect.arrayContaining([{ path: "categories.2.patterns.1", key: "regex" }, { path: "categories.0.weight", key: "number" }]));
    expect(yaml()).toBe(before);
    expect(await saveVocabulary({ nope: true })).toMatchObject({ status: "error", formError: "invalidPayload" });
  });

  it.each([
    ["T2", "(\\w+\\s*)*budget"],
    ["T1", "(\\d+[.,]?)+\\s*k"],
    ["T2", "(\\d+)+x"],
  ])("refuses a slow pattern in %s (%s) with a field error and leaves the file untouched", async (id, pattern) => {
    const draft = configToDraft(loadConfig("interests"));
    const index = draft.categories.findIndex((category) => category.id === id);
    const tag = draft.categories.findIndex((category) => category.id === "tag");
    cat(draft, id).patterns.push(pattern);
    cat(draft, "tag").tagPatterns.push({ name: "Learning budget", pattern: "(?:\\w+\\s?)+budget" });
    const before = yaml();
    const result = await saveVocabulary(draft);
    expect(result).toMatchObject({ status: "error", section: "vocabulary", formError: null });
    if (result.status !== "error") return;
    expect(result.fieldErrors).toEqual([
      { path: `categories.${index}.patterns.${cat(draft, id).patterns.length - 1}`, key: "slowPattern" },
      { path: `categories.${tag}.tagPatterns.${cat(draft, "tag").tagPatterns.length - 1}.pattern`, key: "slowPattern" },
    ]);
    expect(yaml()).toBe(before);
  });

  it("keeps views and watched companies that were saved in between", async () => {
    await addWatchedCompany({ name: "Acme" });
    const draft = configToDraft(loadConfig("interests")); // read before the view exists
    await saveView({ name: "Berlin", filters: { city: "Berlin" } });
    cat(draft, "T3").weight = "4";
    expect(await saveVocabulary(draft)).toMatchObject({ status: "saved" });
    const config = reloadConfig("interests");
    expect(config.views.map((v) => v.name)).toEqual(["Berlin"]);
    expect(config.watched_companies).toEqual(["Acme"]);
    expect(configCategory("T3")?.weight).toBe(4);
  });
});

describe("saveVocabulary with user-defined categories", () => {
  it("adds a keyword category: saved with its fields, the next cycle rescans, the AI prompt gets a new version", async () => {
    const draft = configToDraft(loadConfig("interests"));
    draft.categories.push({ ...newCategoryDraft({ id: "visa", kind: "keyword", labelZh: "签证担保", labelEn: "Visa sponsorship", color: "violet" }), keywords: ["visa sponsorship"], aiDefinition: "the employer sponsors a work visa", weight: "4", highValue: true });
    const result = await saveVocabulary(draft);
    expect(result).toMatchObject({ status: "saved", recompute: { rescanPending: true, reviewPending: true } });
    expect(configCategory("visa")).toMatchObject({ kind: "keyword", color: "violet", weight: 4, high_value: true, keywords: ["visa sponsorship"] });
    expect(yaml()).toMatch(/- id: visa\n\s+kind: keyword\n\s+label:/);
  });

  it("names, colours, weights and high value change neither the vocabulary nor the prompt", async () => {
    const draft = configToDraft(loadConfig("interests"));
    Object.assign(cat(draft, "T3"), { labelEn: "Good pay", color: "pink", weight: "5", highValue: true, icon: "👍" });
    expect(await saveVocabulary(draft)).toMatchObject({ status: "saved", recompute: { rescanPending: false, reviewPending: false } });
    expect(configCategory("T3")).toMatchObject({ label: { zh: "有竞争力", en: "Good pay" }, color: "pink", weight: 5, high_value: true, icon: "👍" });
  });

  it("deleting moves the category to retired_categories; its stored signals stay; a kind change or a dropped id is refused", async () => {
    const job = await seedJob({ title: "Competitive", rank: 63, match: 60, bonus: 3, tiers: ["T3"] });
    const draft = configToDraft(loadConfig("interests"));
    const t3 = cat(draft, "T3");
    draft.categories = draft.categories.filter((c) => c.id !== "T3");
    draft.retired.push(t3);
    expect(await saveVocabulary(draft)).toMatchObject({ status: "saved", recompute: { rescanPending: true } });
    const config = reloadConfig("interests");
    expect(config.signals.retired_categories.map((c) => c.id)).toEqual(["T3"]);
    expect(await db().select().from(schema.signals).where(eq(schema.signals.jobId, job))).toHaveLength(1);
    // the hidden category brings no points any more
    expect(await scoreOf(job)).toMatchObject({ signalBonus: 0, rankValue: 60 });
    expect((await loadInterestsPage()).signalCounts).toMatchObject({ T3: { signals: 1, jobs: 1 } });

    const kind = configToDraft(config);
    cat(kind, "T2").kind = "tag";
    expect(await saveVocabulary(kind)).toMatchObject({ status: "error", fieldErrors: [{ path: "categories.1.kind", key: "kindLocked" }] });
    const dropped = configToDraft(config);
    dropped.retired = [];
    expect(await saveVocabulary(dropped)).toMatchObject({ status: "error", formError: "categoryMissing" });
  });
});

// ---------------------------------------------------------------- views

describe("saved views", () => {
  it("saves the current filters as a view, optionally as the default, and keeps at most one default", async () => {
    expect(await saveView({ name: "High pay Berlin", filters: { high: true, city: "Berlin" } })).toMatchObject({ status: "saved", id: "high-pay-berlin" });
    expect(await saveView({ name: "Remote", filters: { workplace: "remote" }, makeDefault: true })).toMatchObject({ status: "saved", id: "remote" });
    let views = reloadConfig("interests").views;
    expect(views).toEqual([
      { id: "high-pay-berlin", name: "High pay Berlin", default: false, filters: { high: true, city: "Berlin" } },
      { id: "remote", name: "Remote", default: true, filters: { workplace: "remote" } },
    ]);
    expect(yaml()).toContain("# 保存的筛选视图");

    expect(await setDefaultView({ id: "high-pay-berlin", value: true })).toMatchObject({ status: "saved" });
    views = reloadConfig("interests").views;
    expect(views.map((v) => [v.id, v.default])).toEqual([["high-pay-berlin", true], ["remote", false]]);
    expect(await setDefaultView({ id: "high-pay-berlin", value: false })).toMatchObject({ status: "saved" });
    expect(reloadConfig("interests").views.some((v) => v.default)).toBe(false);
  });

  it("writes one value as a scalar (the file as before) and several as a list, comments kept; scalar views stay scalar", async () => {
    await saveView({ name: "One city", filters: { city: "München", workplace: "remote" } });
    expect(yaml()).toMatch(/- id: one-city\n(\s+.*\n)*?\s+city: München\n/);
    expect(yaml()).not.toMatch(/city:\s*\n\s*- /);
    const afterFirst = yaml();

    await saveView({ name: "Two cities", filters: { city: ["Berlin", "München"], workplace: ["hybrid", "remote"], app: ["new"] } });
    const text = yaml();
    expect(text).toMatch(/city:\s*\n\s+- Berlin\n\s+- München\n/);
    expect(text).toMatch(/workplace:\s*\n\s+- hybrid\n\s+- remote\n/);
    expect(text).toContain("# 保存的筛选视图");
    // the first view's lines are untouched by the second save
    const firstView = afterFirst.slice(afterFirst.indexOf("- id: one-city"));
    expect(text).toContain(firstView.trimEnd().split("\n").slice(0, 1)[0]);
    expect(text).toMatch(/city: München\n\s+workplace: remote\n/);

    expect(reloadConfig("interests").views.map((v) => [v.id, v.filters])).toEqual([
      ["one-city", { city: "München", workplace: "remote" }],
      ["two-cities", { city: ["Berlin", "München"], workplace: ["hybrid", "remote"], app: ["new"] }],
    ]);
  });

  it("an unrelated change to the file (weights) does not turn scalar views into lists", async () => {
    await saveView({ name: "One city", filters: { city: "Berlin" } });
    const draft = configToDraft(loadConfig("interests"));
    cat(draft, "T3").weight = "4";
    expect(await saveVocabulary(draft)).toMatchObject({ status: "saved" });
    expect(yaml()).toMatch(/city: Berlin\n/);
    expect(reloadConfig("interests").views[0]?.filters).toEqual({ city: "Berlin" });
  });

  it("a multi-value view narrows the Today list to the union of its cities", async () => {
    await seedJob({ title: "Berlin Role", city: "Berlin", rank: 70 });
    await seedJob({ title: "Köln Role", city: "Köln", rank: 80 });
    await seedJob({ title: "Hamburg Role", city: "Hamburg", rank: 60 });
    const now = new Date(Date.now() + 60_000);
    const two = await listTodayJobs(db(), { now, timezone: "UTC", extra: { cities: ["Berlin", "Köln"] } });
    expect(two.map((job) => job.title).sort()).toEqual(["Berlin Role", "Köln Role"]);
  });

  it("refuses a taken name unless asked to overwrite; overwriting keeps id and position", async () => {
    await saveView({ name: "Berlin", filters: { city: "Berlin" } });
    await saveView({ name: "Other", filters: { q: "rust" } });
    expect(await saveView({ name: "berlin", filters: { city: "Köln" } })).toMatchObject({ status: "error", formError: "nameTaken" });
    expect(await saveView({ name: "berlin", filters: { city: "Köln" }, overwrite: true })).toMatchObject({ status: "saved", id: "berlin" });
    expect(reloadConfig("interests").views.map((v) => [v.id, v.name, v.filters])).toEqual([
      ["berlin", "Berlin", { city: "Köln" }],
      ["other", "Other", { q: "rust" }],
    ]);
  });

  it("refuses nonsense: no filters, an empty name, unknown filter keys", async () => {
    expect(await saveView({ name: "Empty", filters: {} })).toMatchObject({ formError: "noFilters" });
    expect(await saveView({ name: "   ", filters: { high: true } })).toMatchObject({ formError: "invalidName" });
    expect(await saveView({ name: "x".repeat(61), filters: { high: true } })).toMatchObject({ formError: "invalidName" });
    expect(await saveView({ name: "Bad", filters: { sort: "rank" } })).toMatchObject({ formError: "invalidPayload" });
    expect(reloadConfig("interests").views).toEqual([]);
  });

  it("renames and deletes; an unknown id is reported", async () => {
    await saveView({ name: "A", filters: { high: true } });
    await saveView({ name: "B", filters: { salary: true } });
    expect(await renameView({ id: "a", name: "B" })).toMatchObject({ formError: "nameTaken" });
    expect(await renameView({ id: "a", name: "Alpha" })).toMatchObject({ status: "saved" });
    expect(await renameView({ id: "zzz", name: "Z" })).toMatchObject({ formError: "viewNotFound" });
    expect(await deleteView({ id: "b" })).toMatchObject({ status: "saved" });
    expect(await deleteView({ id: "b" })).toMatchObject({ formError: "viewNotFound" });
    expect(reloadConfig("interests").views.map((v) => v.name)).toEqual(["Alpha"]);
  });

  it("concurrent saves are all kept", async () => {
    const results = await Promise.all(["One", "Two", "Three", "Four"].map((name, i) => saveView({ name, filters: { q: `q${i}` } })));
    expect(results.map(stateOf)).toEqual(["saved", "saved", "saved", "saved"]);
    expect(reloadConfig("interests").views.map((v) => v.name).sort()).toEqual(["Four", "One", "Three", "Two"]);
  });

  it("a view's filters narrow the Today list (and its dates are ignored)", async () => {
    await seedJob({ title: "Berlin Role", city: "Berlin", rank: 70 });
    await seedJob({ title: "Köln Role", city: "Köln", rank: 80 });
    const now = new Date(Date.now() + 60_000);
    const all = await listTodayJobs(db(), { now, timezone: "UTC" });
    expect(all.map((job) => job.title)).toEqual(["Köln Role", "Berlin Role"]);
    const berlin = await listTodayJobs(db(), { now, timezone: "UTC", extra: { cities: ["Berlin"] } });
    expect(berlin.map((job) => job.title)).toEqual(["Berlin Role"]);
    const none = await listTodayJobs(db(), { now, timezone: "UTC", extra: { search: searchPlan("rust") } });
    expect(none).toEqual([]);
  });
});

// ---------------------------------------------------------------- watched companies

describe("watched companies", () => {
  it("adds and removes a company in interests.yaml, without duplicates (case and legal form ignored)", async () => {
    expect(await addWatchedCompany({ name: "  Watched   AG " })).toMatchObject({ status: "saved", section: "watched" });
    expect(yaml()).toMatch(/watched_companies:\s*\n\s*- Watched AG/);
    expect(yaml()).toContain("# 关注公司");
    expect(await addWatchedCompany({ name: "watched ag" })).toMatchObject({ status: "error", formError: "alreadyWatched" });
    expect(await addWatchedCompany({ name: "  " })).toMatchObject({ formError: "invalidName" });
    expect(reloadConfig("interests").watched_companies).toEqual(["Watched AG"]);
    expect(await removeWatchedCompany({ name: "Nope" })).toMatchObject({ formError: "watchedNotFound" });
    expect(await removeWatchedCompany({ name: "Watched AG" })).toMatchObject({ status: "saved" });
    expect(reloadConfig("interests").watched_companies).toEqual([]);
  });

  it("autocompletes from the companies table and shows how many jobs a watched name matches", async () => {
    await seedJob({ title: "A1", company: "Acme GmbH" });
    await seedJob({ title: "A2", company: "Acme GmbH" });
    await seedJob({ title: "B1", company: "Beta Acme AG" });
    await seedCompany("Zeta Corp");
    expect(await suggestCompanyNames("acme")).toEqual(["Acme GmbH", "Beta Acme AG"]); // prefix first, then more jobs
    expect(await suggestCompanyNames("zeta")).toEqual(["Zeta Corp"]);
    expect(await suggestCompanyNames("")).toEqual([]);
    expect(await suggestCompanyNames("100%_")).toEqual([]);
    expect(await suggestCompanyNames(42)).toEqual([]);

    expect(await describeWatchedCompanies(["acme", "Unknown Inc"])).toMatchObject([
      { name: "acme", match: { name: "Acme GmbH", jobCount: 2 }, hasBoard: false },
      { name: "Unknown Inc", match: null, hasBoard: false },
    ]);
  });

  it("says which watched companies have an enabled ATS board, by the push step's company key", async () => {
    const board = (name: string, token: string, enabled: boolean) => ({ name, ats: "greenhouse" as const, token, enabled });
    await writeConfig("channels", { ...loadConfig("channels"), ats_boards: [board("Anthropic", "anthropic", true), board("Acme", "acme", false), board("Globex Corp", "globex", true)] });
    expect(await describeWatchedCompanies(["Anthropic Inc", "Acme GmbH", "globex", "Google"])).toMatchObject([
      { name: "Anthropic Inc", match: null, hasBoard: true },
      { name: "Acme GmbH", match: null, hasBoard: false }, // the board is disabled
      { name: "globex", match: null, hasBoard: true },
      { name: "Google", match: null, hasBoard: false },
    ]);
  });

  it("the /interests page data reflects the file", async () => {
    await saveView({ name: "Berlin", filters: { city: "Berlin" } });
    await addWatchedCompany({ name: "Acme" });
    const page = await loadInterestsPage();
    expect(page.loadError).toBeNull();
    expect(page.views.map((v) => v.name)).toEqual(["Berlin"]);
    expect(page.watched.map((w) => w.name)).toEqual(["Acme"]);
    expect(page.vocabulary?.draft.categories[0]).toMatchObject({ id: "T1", weight: "10" });
    fs.writeFileSync(getConfigPath("interests"), "weights: nonsense\n");
    expect((await loadInterestsPage()).loadError).not.toBeNull();
    expect(await addWatchedCompany({ name: "X" })).toMatchObject({ formError: "unreadable" });
  });
});

// ---------------------------------------------------------------- the notifier reads the watch list from interests.yaml

describe("push selection reads interests.yaml `watched_companies`", () => {
  const texts = () => api.of("sendMessage").map((c) => String(c.body.text ?? ""));

  function notify(): NotifyConfig {
    return notifyConfig((c) => {
      Object.assign(c.telegram, { enabled: true, api_base_url: api.url, message_gap_ms: 0, max_retries: 0, poll_timeout_seconds: 1 });
      Object.assign(c.quiet_hours, { enabled: false });
    });
  }

  async function cycle() {
    registerCycleStep(
      "notify",
      createNotifyStep({
        loadNotifyConfig: notify,
        createRuntime: () => ({ client: createTelegramClient({ token: FAKE_TOKEN, baseUrl: api.url, requestTimeoutMs: 3000, maxRetries: 0, sleep: async () => {} }), chatId: CHAT }),
        sleep: async () => {},
      }),
    );
    return runCycle("manual", { registry: new ChannelRegistry(), config: cycleConfig(), logger: quietLogger, sleep: async () => {} });
  }

  it("pushes a watched company's job although its rank is below the threshold, and stops once the company is removed", async () => {
    await seedJob({ title: "Strong Role", company: "Big Corp", rank: 90 });
    await seedJob({ title: "Weak Role", company: "Other Corp", rank: 40 });
    await seedJob({ title: "Watched Weak Role", company: "Watched AG", rank: 40 });

    // not watched yet: only the strong job passes the threshold
    await cycle();
    expect(texts().join("\n")).toContain("Strong Role");
    expect(texts().join("\n")).not.toMatch(/Weak Role/);

    // watch the company through the interests service (the name is matched like the company table's key)
    expect(await addWatchedCompany({ name: "watched ag" })).toMatchObject({ status: "saved" });
    api.reset();
    await cycle();
    const sent = texts();
    expect(sent.join("\n")).toContain("Watched Weak Role");
    expect(sent.join("\n")).toContain("👀 关注");
    expect(sent.join("\n")).not.toContain("Other Corp");

    // a later job of that company is pushed too; after removing the company it is not
    await seedJob({ title: "Second Watched Role", company: "Watched AG", rank: 35 });
    api.reset();
    await cycle();
    expect(texts().join("\n")).toContain("Second Watched Role");

    expect(await removeWatchedCompany({ name: "watched ag" })).toMatchObject({ status: "saved" }); // stored as typed
    await seedJob({ title: "Third Watched Role", company: "Watched AG", rank: 35 });
    api.reset();
    await cycle();
    expect(texts().join("\n")).not.toContain("Third Watched Role");
  });
});


it("counts only enabled company-capable channels that opted in, respecting the global switch", async () => {
  const current = loadConfig("channels");
  // every other company-capable channel is off, whatever the shipped defaults enable
  await writeConfig("channels", {
    ...current,
    linkedin: { ...current.linkedin, brightdata: { ...current.linkedin.brightdata, enabled: false }, apify: { ...current.linkedin.apify, enabled: false }, session: { ...current.linkedin.session, enabled: true, company_queries: true }, guest: { ...current.linkedin.guest, enabled: true, company_queries: false } },
    sources: { ...current.sources, arbeitsagentur: { ...current.sources.arbeitsagentur, enabled: false }, indeed: { ...current.sources.indeed, enabled: false }, jobspy_google: { ...current.sources.jobspy_google, enabled: false }, jsearch: { ...current.sources.jsearch, enabled: false }, stepstone: { ...current.sources.stepstone, enabled: false }, xing: { ...current.sources.xing, enabled: false } },
  });
  await writeConfig("search", { ...loadConfig("search"), watched_company_queries: { ...loadConfig("search").watched_company_queries, enabled: true } });
  expect((await describeWatchedCompanies(["Acme"]))[0]?.companyQueryChannels).toBe(1);
  await writeConfig("search", { ...loadConfig("search"), watched_company_queries: { ...loadConfig("search").watched_company_queries, enabled: false } });
  expect((await describeWatchedCompanies(["Acme"]))[0]?.companyQueryChannels).toBe(0);
});
