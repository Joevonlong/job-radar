import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { buildWatchedCompanyKeys } from "@/lib/companies/marks";
import { loadCompanyOverview } from "@/lib/companies/overview";
import type { CompanySort } from "@/lib/companies/search-params";
import { ensureProfileFiles, loadConfig, writeConfig, type PipelineConfig } from "@/lib/config";
import { closeDb, countJobList, getDb, getOrCreateCompany, getPushCandidate, listCompanyOverview, schema, type CompanyOverviewOptions } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { compileFilter, evaluateJob } from "@/lib/filter/rules";
import { removeWatchedCompanies } from "@/lib/interests/service";
import { resolveViewCompanyIds } from "@/lib/jobs/job-filters";
import { isWatched } from "@/lib/notify/select";
import { resolveCompanyName } from "@/lib/pipeline/company";

import { makeTempConfig } from "../config/helpers";
import { job as filterJob, prefs } from "../filter/helpers";
import { pipelineWith } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
const SEEN = new Date("2026-10-01T00:00:00Z");
const pipeline = (aliases: Record<string, string[]> = {}) => pipelineWith((raw) => {
  raw.company = { ...(raw.company as object), legal_suffixes: ["gmbh"], aliases };
});
const plain = pipeline();
const overview = (options: Partial<CompanyOverviewOptions> = {}) => listCompanyOverview(getDb(), { q: "", sort: "jobs", dir: "desc", page: 1, pageSize: 50, timezone: "UTC", ...options });

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
afterAll(closeDb);

/** Reuse the pipeline normalization and company repo, as the company-filter integration fixtures do. */
async function addCompany(name: string, options: { nameNorm?: string; watched?: boolean; blacklisted?: boolean; pipeline?: PipelineConfig } = {}) {
  const resolved = resolveCompanyName(name, options.pipeline ?? plain);
  const company = await getOrCreateCompany(getDb(), { ...resolved, nameNorm: options.nameNorm ?? resolved.nameNorm });
  await getDb().update(schema.companies).set({ watched: options.watched ?? false, blacklisted: options.blacklisted ?? false }).where(eq(schema.companies.id, company.id));
  return company.id;
}

interface JobInput {
  seen?: Date;
  status?: "active" | "possibly_closed" | "closed";
  override?: "closed" | "open";
  scores?: Array<{ filterResult: "passed" | "filtered_out"; rankValue?: number; score?: number }>;
}

async function addJob(companyId: number, input: JobInput = {}): Promise<number> {
  const [job] = await getDb().insert(schema.jobs).values({
    companyId, title: "Engineer", titleNorm: "engineer", status: input.status ?? "active",
    firstSeenAt: input.seen ?? SEEN, lastSeenAt: input.seen ?? SEEN,
  }).returning({ id: schema.jobs.id });
  const id = job!.id;
  for (const [index, score] of (input.scores ?? []).entries()) {
    await withRebuiltCurrentScores(getDb(), getDb().insert(schema.scores).values({ jobId: id, filterResult: score.filterResult, rankValue: score.rankValue ?? null, score: score.score ?? null, createdAt: new Date(SEEN.getTime() + index * 60_000) }));
  }
  if (input.override) {
    await getDb().insert(schema.jobClosureOverrides).values({ jobId: id, action: "closed" });
    if (input.override === "open") await getDb().update(schema.jobClosureOverrides).set({ action: "open" }).where(eq(schema.jobClosureOverrides.jobId, id));
  }
  return id;
}

describe("company overview sorting and pagination", () => {
  const sorts: Array<{ sort: CompanySort; asc: string[]; desc: string[] }> = [
    { sort: "jobs", asc: ["beta", "delta", "unscored", "gamma", "tie1", "tie2", "alpha"], desc: ["alpha", "gamma", "tie1", "tie2", "beta", "delta", "unscored"] },
    { sort: "score", asc: ["delta", "alpha", "gamma", "tie1", "tie2", "beta", "unscored"], desc: ["beta", "alpha", "gamma", "tie1", "tie2", "delta", "unscored"] },
    { sort: "recent", asc: ["unscored", "delta", "alpha", "gamma", "tie1", "tie2", "beta"], desc: ["beta", "alpha", "gamma", "tie1", "tie2", "delta", "unscored"] },
  ];

  it.each(sorts)("sorts by $sort in both directions with stable ties and no paging gaps", async ({ sort, asc, desc }) => {
    const ids: Record<string, number> = {};
    for (const [key, name, count, rank, day] of [
      ["alpha", "Alpha", 3, 80, 7], ["beta", "Beta", 1, 90, 8], ["gamma", "Gamma", 2, 80, 7],
      ["tie1", "Tie", 2, 80, 7], ["tie2", "Tie", 2, 80, 7], ["delta", "Delta", 1, 40, 6], ["unscored", "Unscored", 1, null, 5],
    ] as const) {
      const id = await addCompany(name, { nameNorm: key });
      ids[key] = id;
      for (let index = 0; index < count; index++) await addJob(id, { seen: new Date(`2026-10-0${day}T00:00:00Z`), scores: rank === null ? [] : [{ filterResult: "passed", score: 30, rankValue: rank }] });
    }
    for (const dir of ["asc", "desc"] as const) {
      const expected = (dir === "asc" ? asc : desc).map((key) => ids[key]);
      const full = await overview({ sort, dir });
      expect(full.rows.map((row) => row.id)).toEqual(expected);
      expect(full.rows.find((row) => row.id === ids.unscored)!.topRank).toBeNull();
      const walked: number[] = [];
      for (let page = 1; page <= 4; page++) {
        const current = await overview({ sort, dir, page, pageSize: 2 });
        expect(current).toMatchObject({ total: 7, page, pageCount: 4 });
        walked.push(...current.rows.map((row) => row.id));
      }
      expect(walked).toEqual(expected);
      expect(new Set(walked).size).toBe(7);
      const clamped = await overview({ sort, dir, page: 999, pageSize: 2 });
      expect(clamped.page).toBe(4);
      expect(clamped.rows.map((row) => row.id)).toEqual(expected.slice(6));
    }
  });

  it("searches only display names, ignoring case and treating LIKE wildcards and escapes literally", async () => {
    for (const name of ["Acme & Sons", "100% Labs", "100X Labs", "Under_score", "UnderXscore", "Back\\slash"]) await addJob(await addCompany(name));
    expect((await overview({ q: "aCMe" })).rows.map((row) => row.name)).toEqual(["Acme & Sons"]);
    for (const [q, name] of [["%", "100% Labs"], ["_", "Under_score"], ["\\", "Back\\slash"]]) {
      const result = await overview({ q, page: 99, pageSize: 1 });
      expect(result).toMatchObject({ total: 1, page: 1, pageCount: 1 });
      expect(result.rows.map((row) => row.name)).toEqual([name]);
    }
    expect(await overview({ q: "missing", page: 999 })).toEqual({ rows: [], total: 0, page: 1, pageCount: 1 });
    await addJob(await addCompany("Legacy GmbH", { pipeline: pipeline({ Rebranded: ["Legacy GmbH"] }) }));
    expect((await overview({ q: "Legacy" })).total).toBe(0);
  });
});

describe("company overview scope", () => {
  it("omits companies whose only visible jobs are dormant and removes dormant jobs from shared counts", async () => {
    const alone = await addCompany("Dormant Company");
    const mixed = await addCompany("Mixed Company");
    const old = await addJob(alone, { status: "possibly_closed" });
    const older = await addJob(mixed, { status: "possibly_closed" });
    await addJob(mixed);
    for (const id of [old, older]) await getDb().update(schema.jobs).set({ dormantAt: new Date("2026-10-20T00:00:00Z") }).where(eq(schema.jobs.id, id));
    const result = await overview();
    expect(result.rows.map((row) => [row.id, row.jobCount])).toEqual([[mixed, 1]]);
  });

  it("matches the default jobs list, including unscored, possibly closed, reopened and stale-score fallback jobs", async () => {
    const companyId = await addCompany("Acme");
    await addJob(companyId);
    await addJob(companyId, { status: "possibly_closed" });
    await addJob(companyId, { status: "closed", override: "open" });
    await addJob(companyId, { scores: [{ filterResult: "filtered_out", rankValue: 100 }, { filterResult: "passed", score: 50, rankValue: 70 }] });
    const lastVisible = new Date("2026-10-02T00:00:00Z");
    await addJob(companyId, { seen: lastVisible, scores: [{ filterResult: "passed", score: 60, rankValue: 85 }, { filterResult: "passed" }] });
    const hiddenSeen = new Date("2026-10-03T00:00:00Z");
    await addJob(companyId, { status: "closed", seen: hiddenSeen });
    await addJob(companyId, { override: "closed", seen: hiddenSeen });
    await addJob(companyId, { seen: hiddenSeen, scores: [{ filterResult: "passed", score: 100, rankValue: 100 }, { filterResult: "filtered_out" }] });
    await addCompany("Empty");
    await addJob(await addCompany("Closed only"), { status: "closed" });
    await addJob(await addCompany("Filtered only"), { scores: [{ filterResult: "filtered_out" }] });

    const result = await overview();
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({ id: companyId, jobCount: 5, topRank: 85, lastFirstSeenAt: lastVisible });
    const [companyIds] = await resolveViewCompanyIds(getDb(), [{ company: [result.rows[0]!.name] }], { pipeline: plain });
    expect(await countJobList(getDb(), { filters: { companyIds }, timezone: "UTC" })).toBe(result.rows[0]!.jobCount);
  });

  it("counts duplicate records separately while either case-different display-name link opens their union", async () => {
    const first = await addCompany("Acme", { nameNorm: "acme-old" });
    const second = await addCompany("ACME", { nameNorm: "acme-new" });
    await addJob(first);
    await addJob(second);
    await addJob(second);
    const result = await overview();
    expect(result.total).toBe(2);
    expect(result.rows.map(({ id, jobCount }) => ({ id, jobCount }))).toEqual([{ id: second, jobCount: 2 }, { id: first, jobCount: 1 }]);
    for (const row of result.rows) {
      const [companyIds] = await resolveViewCompanyIds(getDb(), [{ company: [row.name] }], { pipeline: plain });
      expect(companyIds).toEqual([first, second]);
      expect(await countJobList(getDb(), { filters: { companyIds }, timezone: "UTC" })).toBe(3);
    }
  });
});

describe("company overview marks and unwatch", () => {
  it("uses the push and hard-filter marks, including DB flags and persisted aliases", async () => {
    const flagged = await addCompany("Flagged", { watched: true });
    const watched = await addCompany("Acme");
    const blacklisted = await addCompany("Blocked", { blacklisted: true });
    const alias = await addCompany("Legacy GmbH", { pipeline: pipeline({ Rebranded: ["Legacy GmbH"] }) });
    const jobIds = new Map<number, number>();
    for (const id of [flagged, watched, blacklisted, alias]) jobIds.set(id, await addJob(id));
    const watchedCompanies = ["Acme GmbH"];
    const excludedCompanies = ["Legacy", "No matching record"];
    const result = await loadCompanyOverview({}, {
      loadSettings: () => ({ pageSize: 50, timezone: "UTC", pipeline: plain, watchedCompanies, excludedCompanies }),
      list: (options) => listCompanyOverview(getDb(), options),
    });
    expect(result.excludedCount).toBe(2);
    const compiled = compileFilter(prefs((raw) => { raw.exclude_companies = excludedCompanies; }), plain);
    for (const row of result.rows) {
      const push = await getPushCandidate(getDb(), jobIds.get(row.id)!);
      expect(row.watched).toBe(isWatched(push!, buildWatchedCompanyKeys(watchedCompanies, plain)));
      const verdict = evaluateJob(filterJob({ companyName: row.name, companyAliases: row.aliases, companyBlacklisted: row.blacklisted }), compiled);
      expect(row.excluded).toBe(verdict.reasons.some((reason) => reason.startsWith("blacklist_company:")));
    }
    expect(result.rows.find((row) => row.id === flagged)).toMatchObject({ watched: true, watchedByFlagOnly: true, companyFlagWatched: true, watchedEntries: [] });
    expect(result.rows.find((row) => row.id === watched)).toMatchObject({ watched: true, watchedByFlagOnly: false, companyFlagWatched: false, watchedEntries: ["Acme GmbH"] });
    expect(result.rows.filter((row) => row.excluded).map((row) => row.id).sort()).toEqual([blacklisted, alias].sort());
  });

  it("loads real settings and removes every original watch-list entry when the row omits its legal suffix", async () => {
    const temp = makeTempConfig();
    try {
      await ensureProfileFiles();
      await writeConfig("ui", { ...loadConfig("ui"), companies: { page_size: 1 } });
      await writeConfig("interests", { ...loadConfig("interests"), watched_companies: ["Acme", "Acme GmbH", "Other"] });
      await writeConfig("preferences", { ...loadConfig("preferences"), exclude_companies: ["Excluded"] });
      await addJob(await addCompany("Acme"));
      const before = await loadCompanyOverview({});
      expect(before).toMatchObject({ pageSize: 1, excludedCount: 1 });
      expect(before.rows[0]).toMatchObject({ name: "Acme", watched: true, watchedEntries: ["Acme", "Acme GmbH"], watchedByFlagOnly: false, href: "/jobs?company=Acme" });
      expect(await removeWatchedCompanies({ names: before.rows[0]!.watchedEntries })).toMatchObject({ status: "saved" });
      expect(loadConfig("interests").watched_companies).toEqual(["Other"]);
      expect((await loadCompanyOverview({})).rows[0]).toMatchObject({ watched: false, watchedEntries: [] });
    } finally {
      temp.cleanup();
    }
  });

  it("cannot watch a stored row after an alias changes the resolved key", async () => {
    const id = await addCompany("Legacy GmbH");
    await addJob(id);
    const list = (options: CompanyOverviewOptions) => listCompanyOverview(getDb(), options);
    const settings = { pageSize: 50, timezone: "UTC", pipeline: plain, watchedCompanies: [], excludedCompanies: [] };
    expect((await loadCompanyOverview({}, { loadSettings: () => settings, list })).rows[0]).toMatchObject({ id, nameNorm: "legacy", watchable: true });
    const changed = { ...settings, pipeline: pipeline({ Acme: ["Legacy GmbH"] }) };
    expect((await loadCompanyOverview({}, { loadSettings: () => changed, list })).rows[0]).toMatchObject({ id, nameNorm: "legacy", watched: false, watchedEntries: [], watchable: false });
  });
});
