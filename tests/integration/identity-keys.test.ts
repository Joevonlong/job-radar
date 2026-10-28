import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { registerFixtureChannel, type FixturePosting } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { runCycle } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getRuntimeState } from "@/lib/db/repos/runtime-state";
import { syncCompanyDisplayNames } from "@/lib/pipeline/company-names";
import { refreshIdentityKeysIfStale, refreshStoredIdentityKeys, runPipeline, splitMergedJobsOf } from "@/lib/pipeline";
import { IDENTITY_KEYS_STATE_KEY, IDENTITY_KEYS_VERSION, legacyCompanyKey, legacyTitleKey } from "@/lib/pipeline/identity-keys";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config, quietLogger } from "../cycle/helpers";
import { shippedPipeline } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");

const posting = (id: string, extra: Partial<FixturePosting> = {}): FixturePosting => ({
  id,
  title: `Job ${id}`,
  company: "Acme GmbH",
  city: "Berlin",
  country: "DE",
  remote: false,
  description: "Build things",
  url: `https://jobs.example.test/${id}`,
  posted_at: "2026-10-06T08:00:00Z",
  ...extra,
});

/** One ATS-like fixture channel delivering `postings`. */
function registryOf(postings: FixturePosting[]): ChannelRegistry {
  const registry = new ChannelRegistry();
  registerFixtureChannel(registry, { id: "fx-keys", family: "ats", kind: "ats", usesQueries: false, postings });
  return registry;
}

const run = (registry: ChannelRegistry) => runCycle("manual", { registry, config: config(), logger: quietLogger, sleep: async () => {} });

const pipelineConfig = shippedPipeline();
const suffixes = pipelineConfig.company.legal_suffixes;

const allJobs = () => getDb().select().from(schema.jobs).orderBy(schema.jobs.id);
const allCompanies = () => getDb().select().from(schema.companies).orderBy(schema.companies.id);
const allSources = () => getDb().select().from(schema.jobSources).orderBy(schema.jobSources.id);
const allLookups = () => getDb().select().from(schema.salaryLookups).orderBy(schema.salaryLookups.id);
const companyNamed = async (name: string) => (await allCompanies()).find((c) => c.name === name)!;
const jobTitled = async (title: string) => (await allJobs()).find((job) => job.title === title)!;

/** A finished salary lookup of the job, as the ai-worker stores it. */
async function insertLookup(jobId: number, companyId: number, lookupKey: string): Promise<number> {
  const [row] = await getDb()
    .insert(schema.salaryLookups)
    .values({ companyId, jobId, lookupKey, status: "done", promptVersion: "salary-v1", expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: schema.salaryLookups.id });
  return row!.id;
}
const forgetKeyVersion = () => getDb().delete(schema.runtimeState).where(eq(schema.runtimeState.key, IDENTITY_KEYS_STATE_KEY));

/** What `pnpm reprocess --split-merged` does before its pipeline run, then that run (only the pending postings). */
async function reprocessSplitMerged(registry: ChannelRegistry) {
  const options = { config: pipelineConfig, registry, logger: quietLogger };
  const keys = await refreshStoredIdentityKeys(getDb(), options);
  const split = await splitMergedJobsOf(getDb(), options);
  const pipeline = await runPipeline(getDb(), options);
  return { keys, split, pipeline };
}

/** Put the stored keys back to what key version 1 wrote, as an installation from before the upgrade has them. */
async function writeVersion1Keys(): Promise<void> {
  for (const company of await allCompanies()) {
    await getDb().update(schema.companies).set({ nameNorm: legacyCompanyKey(company.name, suffixes) }).where(eq(schema.companies.id, company.id));
  }
  for (const job of await allJobs()) {
    await getDb().update(schema.jobs).set({ titleNorm: legacyTitleKey(job.title) }).where(eq(schema.jobs.id, job.id));
  }
  await forgetKeyVersion();
}

/**
 * Fold the jobs `others` (and their companies, when `companyToo`) into `into`, the way key version 1 had merged them: their
 * postings hang on `into`, the other jobs and companies are gone.
 */
async function mergeAsVersion1(into: number, others: number[], companyToo = false): Promise<void> {
  const db = getDb();
  const target = (await db.select().from(schema.jobs).where(eq(schema.jobs.id, into)))[0]!;
  const moved = await db.select().from(schema.jobs).where(inArray(schema.jobs.id, others));
  await db.update(schema.jobSources).set({ jobId: into }).where(inArray(schema.jobSources.jobId, others));
  await db.delete(schema.jobs).where(inArray(schema.jobs.id, others));
  if (companyToo) {
    const otherCompanies = [...new Set(moved.map((job) => job.companyId))].filter((id) => id !== target.companyId);
    if (otherCompanies.length > 0) await db.delete(schema.companies).where(inArray(schema.companies.id, otherCompanies));
  }
}

let temp: TempConfig;
const resetTables = () => getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  temp = makeTempConfig();
  await resetTables();
  await forgetKeyVersion();
  registerBuiltinCycleSteps();
});

afterEach(() => {
  resetCycleSteps();
  temp.cleanup();
});

afterAll(async () => {
  await resetTables();
  await forgetKeyVersion();
  await closeDb();
});

describe("company and title keys in other scripts, through a cycle", () => {
  it("four different Japanese roles at one company in one city stay four jobs", async () => {
    await run(registryOf([
      posting("a1", { company: "Mercari Inc.", title: "バックエンドエンジニア", description: "Go microservices payments backend platform team" }),
      posting("a2", { company: "Mercari Inc.", title: "プロダクトデザイナー", description: "Figma user research mobile app design system" }),
      posting("a3", { company: "Mercari Inc.", title: "シニアAIエンジニア", description: "LLM ranking recommendation" }),
      posting("a4", { company: "Mercari Inc.", title: "AIリサーチャー", description: "research papers vision models" }),
    ]));
    const jobs = await allJobs();
    expect(jobs.map((job) => job.title).sort()).toEqual(["AIリサーチャー", "シニアAIエンジニア", "バックエンドエンジニア", "プロダクトデザイナー"].sort());
    expect(new Set(jobs.map((job) => job.titleNorm)).size).toBe(4);
    expect(await allCompanies()).toHaveLength(1);
  });

  it("two employers named in Cyrillic and Japanese are two companies", async () => {
    await run(registryOf([
      posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" }),
      posting("m1", { company: "株式会社メルカリ", title: "エンジニア", description: "Marketplace payments in Go" }),
    ]));
    expect((await allCompanies()).map((c) => [c.name, c.nameNorm])).toEqual([
      ["Яндекс", "яндекс"],
      ["株式会社メルカリ", "株式会社メルカリ"],
    ]);
    expect(await allJobs()).toHaveLength(2);
  });

  it("titles without letters or digits never match each other by the exact key", async () => {
    await run(registryOf([
      posting("e1", { title: "(m/w/d)", description: "First role" }),
      posting("e2", { title: "***", description: "Second role" }),
    ]));
    const jobs = await allJobs();
    expect(jobs.map((job) => job.titleNorm)).toEqual(["", ""]);
    expect(jobs).toHaveLength(2);
  });
});

describe("recomputing the stored keys after the upgrade", () => {
  const latinPostings = [
    posting("l1", { company: "Acme GmbH", title: "Applied AI Engineer (m/w/d)" }),
    posting("l2", { company: "Müller & Söhne UG (haftungsbeschränkt)", title: "KI-Entwickler*in", description: "Modelle bauen" }),
    posting("l3", { company: "Société Générale S.A.", title: "C++ Engineer", city: "Paris", country: "FR" }),
    posting("l4", { company: "SIGNAL Works, G.m.b.H.", title: "Größe & Übung Engineer", city: "München" }),
  ];

  it("changes nothing on a database whose names and titles are all in Latin script", async () => {
    const registry = registryOf(latinPostings);
    await run(registry);
    await forgetKeyVersion();
    const before = { companies: await allCompanies(), jobs: await allJobs(), sources: await allSources() };
    expect(before.jobs).toHaveLength(4);

    const result = await refreshIdentityKeysIfStale(getDb(), { config: pipelineConfig, logger: quietLogger });
    expect(result).toEqual({ companiesRekeyed: 0, companiesFolded: 0, companiesKeptUnderLatinKey: 0, jobsRekeyed: 0, aborted: false });
    const split = await splitMergedJobsOf(getDb(), { config: pipelineConfig, registry, logger: quietLogger });
    expect(split).toMatchObject({ jobsChecked: 0, jobsSplit: 0, sourcesUnlinked: 0, rawRequeued: 0 });

    expect({ companies: await allCompanies(), jobs: await allJobs(), sources: await allSources() }).toEqual(before);
    expect((await getRuntimeState(getDb(), IDENTITY_KEYS_STATE_KEY))?.value).toBe(IDENTITY_KEYS_VERSION);
  });

  it("gives the rows of other scripts their own keys, once, and folds rows that now share a key", async () => {
    await run(registryOf([
      ...latinPostings,
      posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" }),
      posting("o1", { company: "Ørsted A/S", title: "Ingeniør", city: "Kopenhagen", country: "DK" }),
      posting("s1", { company: "Mercari Inc.", title: "シニアAIエンジニア", city: "Tokyo", country: "JP" }),
      // a combining mark key version 1 did not fold: "ac-me" then, "acme" now, the key of "Acme GmbH"
      posting("c1", { company: "Ac\u20ddme", title: "Platform Engineer", description: "Run the platform" }),
    ]));
    await writeVersion1Keys();
    const db = getDb();
    // version 1 had filed "Ac\u20ddme" as a company of its own (key "ac-me"); this one is watched: the row it folds into takes that over
    const [marked] = await db.insert(schema.companies).values({ name: "Ac\u20ddme", nameNorm: "ac-me", watched: true }).returning();
    await db.update(schema.jobs).set({ companyId: marked!.id }).where(eq(schema.jobs.title, "Platform Engineer"));
    // a company the new code created before the keys were recomputed (the "" row "Яндекс" folds into it)
    const [early] = await db.insert(schema.companies).values({ name: "ЯНДЕКС", nameNorm: "яндекс" }).returning();
    expect((await allCompanies()).map((c) => c.nameNorm)).toEqual(["acme", "muller-and-sohne-ug-haftungsbeschrankt", "societe-generale", "signal-works", "", "rsted-a-s", "mercari", "ac-me", "яндекс"]);
    const yandexJob = (await allJobs()).find((job) => job.title === "Разработчик")!;

    const result = await refreshIdentityKeysIfStale(db, { config: pipelineConfig, logger: quietLogger });
    expect(result).toEqual({ companiesRekeyed: 1, companiesFolded: 2, companiesKeptUnderLatinKey: 0, jobsRekeyed: 3, aborted: false });

    const companies = await allCompanies();
    expect(companies.map((c) => [c.name, c.nameNorm])).toEqual([
      ["Acme GmbH", "acme"],
      ["Müller & Söhne UG (haftungsbeschränkt)", "muller-and-sohne-ug-haftungsbeschrankt"],
      ["Société Générale S.A.", "societe-generale"],
      ["SIGNAL Works, G.m.b.H.", "signal-works"],
      ["Ørsted A/S", "ørsted-a-s"],
      ["Mercari Inc.", "mercari"],
      ["ЯНДЕКС", "яндекс"],
    ]);
    const acme = companies[0]!;
    expect(acme).toMatchObject({ watched: true, aliases: ["Ac\u20ddme"] });
    expect(companies.find((c) => c.id === early!.id)!.aliases).toEqual(["Яндекс"]);
    expect((await allJobs()).find((job) => job.id === yandexJob.id)!.companyId).toBe(early!.id);
    expect((await allJobs()).filter((job) => job.title === "Platform Engineer").map((job) => job.companyId)).toEqual([acme.id]);
    expect((await allJobs()).map((job) => job.titleNorm)).toEqual([
      "applied ai engineer", "ki entwickler", "c++ engineer", "grosse and ubung engineer", "разработчик", "ingeniør", "シニアaiエンジニア", "platform engineer",
    ]);

    // once per key version; a forced run finds nothing more to do
    expect(await refreshIdentityKeysIfStale(db, { config: pipelineConfig, logger: quietLogger })).toBeNull();
    expect(await refreshIdentityKeysIfStale(db, { config: pipelineConfig, logger: quietLogger, force: true })).toEqual({ companiesRekeyed: 0, companiesFolded: 0, companiesKeptUnderLatinKey: 0, jobsRekeyed: 0, aborted: false });
  });

  it("the cycle's pipeline step recomputes the keys before it files new postings", async () => {
    const first = [posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" })];
    await run(registryOf(first));
    await writeVersion1Keys();
    expect((await allCompanies()).map((c) => c.nameNorm)).toEqual([""]);

    await run(registryOf([...first, posting("y2", { company: "Яндекс", title: "Аналитик", description: "Metrics and dashboards" })]));
    expect((await allCompanies()).map((c) => [c.name, c.nameNorm])).toEqual([["Яндекс", "яндекс"]]);
    expect((await allJobs()).map((job) => job.titleNorm)).toEqual(["разработчик", "аналитик"]);
  });
});

describe("splitting what key version 1 merged (reprocess --split-merged)", () => {
  it("separates Japanese roles merged under one title key into their own jobs, keeping the merged jobs", async () => {
    const registry = registryOf([
      posting("a1", { company: "Mercari Inc.", title: "バックエンドエンジニア", description: "Go microservices payments backend platform team" }),
      posting("a2", { company: "Mercari Inc.", title: "プロダクトデザイナー", description: "Figma user research mobile app design system" }),
      posting("a3", { company: "Mercari Inc.", title: "シニアAIエンジニア", description: "LLM ranking recommendation" }),
      posting("a4", { company: "Mercari Inc.", title: "AIリサーチャー", description: "research papers vision models" }),
    ]);
    await run(registry);
    const [j1, j2, j3, j4] = (await allJobs()).map((job) => job.id) as [number, number, number, number];
    // key version 1: titles "" (a1, a2) and "ai" (a3, a4)
    await mergeAsVersion1(j1, [j2]);
    await mergeAsVersion1(j3, [j4]);
    await writeVersion1Keys();
    expect((await allJobs()).map((job) => [job.id, job.titleNorm])).toEqual([[j1, ""], [j3, "ai"]]);

    const { keys, split, pipeline } = await reprocessSplitMerged(registry);
    expect(keys).toMatchObject({ ok: true, result: { jobsRekeyed: 2 } });
    expect(split).toMatchObject({ jobsChecked: 2, jobsSplit: 2, sourcesUnlinked: 2, rawRequeued: 2, splitWithUserState: [], needsReview: [] });
    // only the detached postings are filed again; the postings that stay are not touched
    expect(pipeline).toMatchObject({ processed: 2, created: 2 });

    const jobs = await allJobs();
    expect(jobs).toHaveLength(4);
    expect(jobs.slice(0, 2).map((job) => job.id)).toEqual([j1, j3]); // the merged jobs (and what hangs on them) stay
    const sources = await allSources();
    expect(new Set(sources.map((s) => s.jobId)).size).toBe(4);
    expect(sources).toHaveLength(4);
  });

  it("moves the jobs of a second employer that shared the company keyed \"\" to a company of its own", async () => {
    const registry = registryOf([
      posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" }),
      posting("m1", { company: "株式会社メルカリ", title: "エンジニア", description: "Marketplace payments in Go" }),
      posting("m2", { company: "株式会社メルカリ", title: "デザイナー", description: "Design system for the app" }),
    ]);
    await run(registry);
    const [yandex, mercariEngineer, mercariDesigner] = (await allJobs()).map((job) => job.id) as [number, number, number];
    // key version 1: one company "", the titles "" -> all three postings on the first job
    await mergeAsVersion1(yandex, [mercariEngineer, mercariDesigner], true);
    await writeVersion1Keys();
    expect((await allCompanies()).map((c) => [c.name, c.nameNorm])).toEqual([["Яндекс", ""]]);

    const { split } = await reprocessSplitMerged(registry);
    expect(split).toMatchObject({ jobsChecked: 1, jobsSplit: 1, sourcesUnlinked: 2, rawRequeued: 2 });

    const companies = await allCompanies();
    expect(companies.map((c) => [c.name, c.nameNorm])).toEqual([
      ["Яндекс", "яндекс"],
      ["株式会社メルカリ", "株式会社メルカリ"],
    ]);
    const jobs = await allJobs();
    expect(jobs.map((job) => [job.title, companies.find((c) => c.id === job.companyId)!.name])).toEqual([
      ["Разработчик", "Яндекс"],
      ["エンジニア", "株式会社メルカリ"],
      ["デザイナー", "株式会社メルカリ"],
    ]);
    expect(jobs[0]!.id).toBe(yandex);
  });
});

describe("what a recompute and a fold keep", () => {
  it("a folded company's salary lookups move to the company it is folded into, with the new keys", async () => {
    await run(registryOf([posting("g1", { company: "Grossmann GmbH", title: "Data Engineer" }), posting("g2", { company: "Großmann GmbH", title: "ML Engineer" })]));
    // version 1 filed "Großmann GmbH" under "gro-mann", a company of its own
    const db = getDb();
    const ml = await jobTitled("ML Engineer");
    const [old] = await db.insert(schema.companies).values({ name: "Großmann GmbH", nameNorm: "gro-mann" }).returning();
    await db.update(schema.jobs).set({ companyId: old!.id }).where(eq(schema.jobs.id, ml.id));
    const lookup = await insertLookup(ml.id, old!.id, "gro-mann|ml_engineer|ml engineer|unknown|de|berlin");
    await forgetKeyVersion();

    expect(await refreshIdentityKeysIfStale(db, { config: pipelineConfig, logger: quietLogger })).toMatchObject({ companiesFolded: 1 });
    const target = await companyNamed("Grossmann GmbH");
    expect(await allLookups()).toMatchObject([{ id: lookup, companyId: target.id, jobId: ml.id, lookupKey: "grossmann|ml_engineer|ml engineer|unknown|de|berlin" }]);
    expect(target.aliases).toEqual(["Großmann GmbH"]);
  });

  it("a recomputed company and title take their salary lookups' keys along", async () => {
    await run(registryOf([posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" })]));
    await writeVersion1Keys();
    const job = await jobTitled("Разработчик");
    const lookup = await insertLookup(job.id, job.companyId, "-|-|-|unknown|de|berlin");
    await refreshIdentityKeysIfStale(getDb(), { config: pipelineConfig, logger: quietLogger });
    expect(await allLookups()).toMatchObject([{ id: lookup, companyId: job.companyId, lookupKey: "яндекс|-|разработчик|unknown|de|berlin" }]);
  });

  it("merging a board's token row into its company (display names) keeps the token row's lookups", async () => {
    await run(registryOf([posting("d1", { company: "databricks", title: "Data Engineer" })]));
    const db = getDb();
    const token = await companyNamed("databricks");
    const [proper] = await db.insert(schema.companies).values({ name: "Databricks Labs", nameNorm: "databricks-labs" }).returning();
    const job = await jobTitled("Data Engineer");
    const lookup = await insertLookup(job.id, token.id, "databricks|-|data engineer|unknown|de|berlin");
    const result = await syncCompanyDisplayNames(db, { companies: [{ name: "Databricks Labs", token: "databricks", ats: "greenhouse" } as never], pipeline: pipelineConfig });
    expect(result.merged).toBe(1);
    expect(await allLookups()).toMatchObject([{ id: lookup, companyId: proper!.id, lookupKey: "databricks-labs|-|data engineer|unknown|de|berlin" }]);
  });

  it("a blacklisted company named in two scripts stays blacklisted for its Latin spelling", async () => {
    const full = "Mercari, Inc. (株式会社メルカリ)";
    await run(registryOf([posting("m1", { company: full, title: "Backend Engineer" })]));
    await writeVersion1Keys();
    const db = getDb();
    expect((await allCompanies()).map((c) => [c.name, c.nameNorm])).toEqual([[full, "mercari"]]);
    await db.update(schema.companies).set({ blacklisted: true }).where(eq(schema.companies.name, full));

    expect(await refreshIdentityKeysIfStale(db, { config: pipelineConfig, logger: quietLogger })).toMatchObject({ companiesRekeyed: 1, companiesKeptUnderLatinKey: 1 });
    // a posting with the Latin spelling alone, and one with the full spelling: both land on a blacklisted row
    await run(registryOf([posting("m1", { company: full, title: "Backend Engineer" }), posting("m2", { company: "Mercari Inc.", title: "Product Designer" })]));
    const companies = await allCompanies();
    expect(companies.map((c) => [c.name, c.nameNorm, c.blacklisted, c.aliases])).toEqual([
      [full, "mercari-inc-株式会社メルカリ", true, ["Mercari, Inc."]],
      ["Mercari, Inc.", "mercari", true, [full]],
    ]);
    expect((await jobTitled("Product Designer")).companyId).toBe(companies[1]!.id);
  });

  it("files nothing while the keys cannot be recomputed, and catches up once they can", async () => {
    await run(registryOf([posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" })]));
    await writeVersion1Keys();
    const db = getDb();
    await db.execute(sql`create function block_company_keys() returns trigger language plpgsql as $$ begin raise exception 'blocked for the test'; end $$`);
    await db.execute(sql`create trigger block_company_keys before update on companies for each row execute function block_company_keys()`);
    try {
      const registry = registryOf([posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" }), posting("y2", { company: "Яндекс", title: "Аналитик", description: "Metrics and dashboards" })]);
      const cycle = await run(registry);
      expect(cycle.results.pipeline).toMatchObject({ filed: 0 });
      expect(await allJobs()).toHaveLength(1);
      expect((await allCompanies()).map((c) => c.nameNorm)).toEqual([""]);
      const pending = await db.select().from(schema.rawPostings).where(eq(schema.rawPostings.parseStatus, "pending"));
      expect(pending).toHaveLength(1);
      // pnpm reprocess refuses in the same state (the same function decides)
      expect(await refreshStoredIdentityKeys(db, { config: pipelineConfig, logger: quietLogger, force: true })).toMatchObject({ ok: false });
    } finally {
      await db.execute(sql`drop trigger block_company_keys on companies`);
      await db.execute(sql`drop function block_company_keys()`);
    }
    await run(registryOf([posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" }), posting("y2", { company: "Яндекс", title: "Аналитик", description: "Metrics and dashboards" })]));
    expect((await allCompanies()).map((c) => [c.name, c.nameNorm])).toEqual([["Яндекс", "яндекс"]]);
    expect((await allJobs()).map((job) => job.titleNorm)).toEqual(["разработчик", "аналитик"]);
  });
});

describe("splitting leaves alone what the user acted on and what was merged for other reasons", () => {
  it("two Japanese cities at one company and title are two jobs, and a merge of them is split", async () => {
    const registry = registryOf([
      posting("t1", { company: "Mercari Inc.", title: "エンジニア", city: "東京", country: "JP", description: "Tokyo office role" }),
      posting("o1", { company: "Mercari Inc.", title: "エンジニア", city: "大阪", country: "JP", description: "Osaka office role" }),
    ]);
    await run(registry);
    const [tokyo, osaka] = (await allJobs()).map((job) => job.id) as [number, number];
    expect(osaka).toBeDefined();
    await mergeAsVersion1(tokyo, [osaka]);
    await writeVersion1Keys();
    const { split } = await reprocessSplitMerged(registry);
    expect(split).toMatchObject({ jobsSplit: 1, sourcesUnlinked: 1 });
    expect(await allJobs()).toHaveLength(2);
  });

  it("a job the user applied to keeps its company and application; a merge by SimHash is not split", async () => {
    const registry = registryOf([
      posting("y1", { company: "Яндекс", title: "Разработчик", description: "Search backend in C++" }),
      posting("m1", { company: "株式会社メルカリ", title: "エンジニア", description: "Marketplace payments in Go" }),
      posting("p1", { company: "Acme GmbH", title: "Platform Engineer", description: "Run the platform" }),
      posting("p2", { company: "Acme GmbH", title: "Platform Engineer (Remote)", description: "Run the platform" }),
    ]);
    await run(registry);
    const db = getDb();
    const yandex = await jobTitled("Разработчик");
    const mercari = await jobTitled("エンジニア");
    // version 1: one company "", both postings on one job that took the Mercari title (the winning posting)
    await mergeAsVersion1(yandex.id, [mercari.id], true);
    await db.update(schema.jobs).set({ title: "エンジニア" }).where(eq(schema.jobs.id, yandex.id));
    await db.insert(schema.applications).values({ jobId: yandex.id, status: "applied", notesMd: "called them" });
    // two Latin postings merged by SimHash (a different title): never split, never requeued
    const platform = (await allJobs()).filter((job) => job.title.startsWith("Platform Engineer"));
    if (platform.length === 2) await mergeAsVersion1(platform[0]!.id, [platform[1]!.id]);
    await writeVersion1Keys();
    const companyBefore = (await allJobs()).find((job) => job.id === yandex.id)!.companyId;

    const { split } = await reprocessSplitMerged(registry);
    expect(split.needsReview).toEqual([yandex.id]);
    expect(split.sourcesUnlinked).toBe(0);
    const after = (await allJobs()).find((job) => job.id === yandex.id)!;
    expect(after.companyId).toBe(companyBefore);
    expect(await db.select().from(schema.applications)).toMatchObject([{ jobId: yandex.id, notesMd: "called them" }]);
    const platformSources = (await allSources()).filter((source) => source.jobId === platform[0]!.id);
    expect(platformSources).toHaveLength(2);
  });

  it("a job the user acted on loses only the postings the old keys merged into it", async () => {
    const registry = registryOf([
      posting("a1", { company: "Mercari Inc.", title: "バックエンドエンジニア", description: "Go microservices payments backend platform team" }),
      posting("a2", { company: "Mercari Inc.", title: "プロダクトデザイナー", description: "Figma user research mobile app design system" }),
    ]);
    await run(registry);
    const [j1, j2] = (await allJobs()).map((job) => job.id) as [number, number];
    await mergeAsVersion1(j1, [j2]);
    await getDb().insert(schema.jobFavorites).values({ jobId: j1 });
    await writeVersion1Keys();
    const companyBefore = (await allJobs())[0]!.companyId;
    const { split } = await reprocessSplitMerged(registry);
    expect(split).toMatchObject({ jobsSplit: 1, sourcesUnlinked: 1, splitWithUserState: [j1] });
    const jobs = await allJobs();
    expect(jobs.map((job) => job.id)).toContain(j1);
    expect(jobs.find((job) => job.id === j1)!.companyId).toBe(companyBefore);
    expect(jobs).toHaveLength(2);
  });
});
