import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCompaniesMerge, parsePlanText } from "@/lib/companies/merge-run";
import { buildWatchedCompanyKeys, isCompanyWatched } from "@/lib/companies/marks";
import { closeDb, getDb, schema, upsertRawPostings } from "@/lib/db";
import { withCycleLock } from "@/lib/db/cycle-lock";
import { runMigrations } from "@/lib/db/migrate";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { findLatestCompanyResearch } from "@/lib/db/repos/company-research";
import type { CompanyMergeContext } from "@/lib/db/repos/company-merges";
import { insertJob } from "@/lib/db/repos/jobs";
import { requeueRawPostings } from "@/lib/db/repos/raw-postings";
import { findLatestSalaryLookup } from "@/lib/db/repos/salary-lookups";
import { translatorFor } from "@/lib/i18n/node";
import { loadPipeline } from "@/lib/market";
import { companyOfPosting, REPLAY_RELIST, runPipeline } from "@/lib/pipeline";
import { normalizeCompanyKey } from "@/lib/pipeline/company";
import { salaryLookupKey } from "@/lib/salary/lookup-key";

import { quietLogger } from "../cycle/helpers";
import { pipelineWith } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
const db = () => getDb();
const NOW = new Date("2026-11-01T10:00:00Z");
const PROMPT = "test-v1";

const pipeline = pipelineWith((raw) => {
  raw.company = { ...(raw.company as object), aliases: {}, duplicate_tail_words: ["services", "group"] };
});
const emptyContext: CompanyMergeContext = { pipeline, watchedCompanies: [], excludedCompanies: [], trustedKeys: [] };

let planDir: string;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  planDir = mkdtempSync(path.join(os.tmpdir(), "company-merge-"));
});
afterAll(async () => {
  rmSync(planDir, { recursive: true, force: true });
  await closeDb();
});

async function run(argv: string[], context: CompanyMergeContext = emptyContext) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCompaniesMerge({ db: db(), argv, context: () => context, t: translatorFor("en", "cli.companiesMerge"), out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, text: out.join("\n"), errText: err.join("\n") };
}

const pair = (from: number, into: number): string[] => ["--pair", `${from}:${into}`];

async function company(name: string, over: Partial<typeof schema.companies.$inferInsert> = {}) {
  const row = await getOrCreateCompany(db(), { name, nameNorm: normalizeCompanyKey(name, pipeline.company.legal_suffixes) });
  if (Object.keys(over).length > 0) await db().update(schema.companies).set(over).where(eq(schema.companies.id, row.id));
  return { ...row, ...over } as typeof row;
}

async function job(companyId: number, title = "ML Engineer", over: Partial<typeof schema.jobs.$inferInsert> = {}) {
  return insertJob(db(), { companyId, title, titleNorm: title.toLowerCase().replaceAll(" ", "-"), firstSeenAt: NOW, lastListedAt: NOW, lastSeenAt: NOW, ...over });
}

const SALARY_RESULT = {
  query: { company: "x", title: "y", city: null, country: null, seniority: "unknown", currency: "EUR" },
  companyLevel: { level: "unknown", median: null, summary: "", sources: [] },
  roleBand: null,
  relatedRoles: [],
  sources: [],
  confidence: "low",
  notes: "",
  dropped: 0,
  observations: [],
};
const JOB_KEY = { titleNorm: "ml-engineer", seniority: "unknown", location: null };

async function salary(companyId: number, companyNorm: string, jobId: number | null, fetchedAt = NOW, lookupKey = salaryLookupKey({ ...JOB_KEY, companyNorm }, null)) {
  const [row] = await db().insert(schema.salaryLookups).values({ companyId, jobId, lookupKey, status: "done", resultJson: SALARY_RESULT, promptVersion: PROMPT, fetchedAt, expiresAt: new Date(NOW.getTime() + 1e10) }).returning();
  return row!;
}

async function research(companyId: number, fetchedAt = NOW) {
  const [row] = await db().insert(schema.companyResearch).values({ companyId, status: "ok", resultJson: { fields: {}, dropped: 0 }, promptVersion: 1, fetchedAt, expiresAt: new Date(NOW.getTime() + 1e10) }).returning();
  return row!;
}

const companies = () => db().select().from(schema.companies).orderBy(asc(schema.companies.id));
const jobs = () => db().select().from(schema.jobs).orderBy(asc(schema.jobs.id));
const lookups = () => db().select().from(schema.salaryLookups).orderBy(asc(schema.salaryLookups.id));
const backgrounds = () => db().select().from(schema.companyResearch).orderBy(asc(schema.companyResearch.id));
const merges = () => db().select().from(schema.companyMerges).orderBy(asc(schema.companyMerges.id));
const snapshot = async () => ({ companies: await companies(), jobs: await jobs(), salary: await lookups(), research: await backgrounds(), merges: await merges() });

/** A fixture channel whose postings the real pipeline reads. */
function channel(postings: Array<{ id: string; company: string; title: string; description?: string }>) {
  const registry = new ChannelRegistry();
  registerFixtureChannel(registry, { id: "fx", family: "ats", kind: "ats", usesQueries: false, postings: postings.map((p) => ({ city: "Testville", country: "DE", description: p.description ?? "", remote: false, posted_at: null, url: `https://example.com/${p.id}`, ...p })) });
  return registry;
}

async function ingest(postings: Array<{ id: string; company: string; title: string; description?: string }>, logger = quietLogger) {
  const registry = channel(postings);
  await db().insert(schema.channels).values({ id: "fx", family: "ats", kind: "ats" }).onConflictDoNothing();
  await upsertRawPostings(db(), { channelId: "fx", runId: null, items: postings.map((p) => ({ externalId: p.id, url: `https://example.com/${p.id}`, payload: { city: "Testville", country: "DE", description: p.description ?? "", remote: false, posted_at: null, url: `https://example.com/${p.id}`, ...p } })) });
  return runPipeline(db(), { relist: REPLAY_RELIST, config: pipeline, registry, logger });
}

/** What `pnpm reprocess --channel fx` does with a posting: back to pending, through the pipeline again. */
async function reprocess(postings: Array<{ id: string; company: string; title: string; description?: string }>) {
  await requeueRawPostings(db(), ["fx"]);
  return runPipeline(db(), { relist: REPLAY_RELIST, config: pipeline, registry: channel(postings), logger: quietLogger });
}

async function aPairWithEverything() {
  const from = await company("Alephalpha", { aliases: ["Aleph Alpha Research"], atsKind: "greenhouse", atsToken: "alephalpha" });
  const into = await company("Aleph Alpha");
  const j1 = await job(from.id);
  const j2 = await job(from.id, "Researcher", { status: "closed" });
  const j3 = await job(into.id);
  await db().insert(schema.applications).values({ jobId: j1.id });
  await db().insert(schema.jobFavorites).values({ jobId: j2.id });
  await db().insert(schema.scores).values({ jobId: j1.id, filterResult: "passed" });
  const lookup = await salary(from.id, from.nameNorm, j1.id);
  const background = await research(from.id);
  await db().insert(schema.applicationFitNotes).values({ jobId: j1.id, companyResearchId: background.id, materialsHash: "h", storyIds: [], items: [], promptVersion: "1" });
  return { from, into, j1, j2, j3, lookup, background };
}

describe("dry run", () => {
  it("writes nothing and takes no lock, and reports the numbers the merge then has", async () => {
    const { from, into, j1, j2, lookup, background } = await aPairWithEverything();
    const before = await snapshot();

    const dry = await run(pair(from.id, into.id));
    expect(dry.code).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(dry.text).toContain("jobs to move: 2 (1 open, 2 with an application or favourite)");
    expect(dry.text).toContain("with a title the kept company also has, staying separate: 1");
    expect(dry.text).toContain("salary lookups: 1; company backgrounds: 1; new aliases: Alephalpha, Aleph Alpha Research");

    const applied = await run([...pair(from.id, into.id), "--apply"]);
    expect(applied.code).toBe(0);
    const [record] = await merges();
    expect(record).toMatchObject({ fromCompanyId: from.id, intoCompanyId: into.id, undoneAt: null, moved: { jobIds: [j1.id, j2.id], salary: [{ id: lookup.id, lookupKey: lookup.lookupKey }], research: [background.id] } });
    const kept = (await companies()).find((row) => row.id === into.id)!;
    expect([...kept.aliases].sort()).toEqual(["Aleph Alpha Research", "Alephalpha"]);
    // the lines that describe the pair are the same before and after
    for (const line of dry.out.filter((l) => l.startsWith("  jobs") || l.startsWith("  salary"))) expect(applied.out).toContain(line);
  });

  it("works while a cycle holds the lock, in a transaction Postgres would refuse a write in", async () => {
    const from = await company("Alephalpha");
    const into = await company("Aleph Alpha");
    const locked = await withCycleLock(db(), "try", async () => run(pair(from.id, into.id)));
    expect(locked).toMatchObject({ acquired: true, value: { code: 0 } });
    await expect(db().transaction((tx) => tx.insert(schema.companies).values({ name: "x", nameNorm: "x" }), { accessMode: "read only" })).rejects.toThrow();
  });

  it("refuses in a dry run what the merge would refuse", async () => {
    const a = await company("A1");
    const b = await company("B1");
    const c = await company("C1");
    const result = await run([...pair(a.id, b.id), ...pair(c.id, a.id), ...pair(c.id, c.id), ...pair(99999, b.id)]);
    expect(result.code).toBe(1);
    expect(result.text).toContain("an earlier pair of this plan removes the row to keep");
    expect(result.text).toContain("the two ids are the same company");
    expect(result.text).toContain("the row to remove does not exist");
  });

  it("says when an earlier pair of the plan feeds this row", async () => {
    const a = await company("A1");
    const b = await company("B1");
    const c = await company("C1");
    const result = await run([...pair(a.id, b.id), ...pair(b.id, c.id)]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("an earlier pair of this plan merges into this row");
  });
});

describe("merge", () => {
  it("removes the row and moves everything, keeping what hangs on the jobs", async () => {
    const { from, into, j1, j2, j3, lookup, background } = await aPairWithEverything();
    const applicationsBefore = await db().select().from(schema.applications);
    const favoritesBefore = await db().select().from(schema.jobFavorites);
    const scoresBefore = await db().select().from(schema.scores);

    expect((await run([...pair(from.id, into.id), "--apply"])).code).toBe(0);

    expect((await companies()).map((row) => row.id)).toEqual([into.id]);
    expect((await jobs()).map((row) => [row.id, row.companyId])).toEqual([[j1.id, into.id], [j2.id, into.id], [j3.id, into.id]]);
    expect(await db().select().from(schema.applications)).toEqual(applicationsBefore);
    expect(await db().select().from(schema.jobFavorites)).toEqual(favoritesBefore);
    expect(await db().select().from(schema.scores)).toEqual(scoresBefore);

    const intoKey = salaryLookupKey({ ...JOB_KEY, companyNorm: into.nameNorm }, null);
    expect(await findLatestSalaryLookup(db(), { lookupKey: intoKey, promptVersion: PROMPT })).toMatchObject({ id: lookup.id });
    expect(await findLatestCompanyResearch(db(), { companyId: into.id, promptVersion: 1, now: NOW })).toMatchObject({ id: background.id });
    const [note] = await db().select().from(schema.applicationFitNotes);
    expect((await backgrounds()).map((row) => row.id)).toContain(note!.companyResearchId);
    // the kept row's ATS comes from the removed row when it has none
    expect((await companies())[0]).toMatchObject({ atsKind: "greenhouse", atsToken: "alephalpha" });
  });

  describe("conflicts", () => {
    it("merges the marks by or", async () => {
      const from = await company("A1", { blacklisted: true });
      const into = await company("B1");
      expect((await run([...pair(from.id, into.id), "--apply"])).code).toBe(0);
      expect((await companies())[0]).toMatchObject({ id: into.id, blacklisted: true, watched: false });
    });

    it.each([[{ watched: true }, { blacklisted: true }], [{ blacklisted: true }, { watched: true }]])("refuses a pair with %j and %j", async (a, b) => {
      const from = await company("A1", a);
      const into = await company("B1", b);
      const before = await snapshot();
      const result = await run([...pair(from.id, into.id), "--apply"]);
      expect(result.code).toBe(1);
      expect(result.text).toContain("one row is watched and the other blacklisted");
      expect(await snapshot()).toEqual(before);
    });

    it("refuses a watch-list entry on one side and a blacklist on the other", async () => {
      const from = await company("A1");
      const into = await company("B1", { blacklisted: true });
      expect((await run(pair(from.id, into.id), { ...emptyContext, watchedCompanies: ["A1"] })).code).toBe(1);
    });

    it("keeps the domain the user confirmed, of two the later one, and warns about the other", async () => {
      const early = new Date("2026-01-01T00:00:00Z");
      const late = new Date("2026-06-01T00:00:00Z");
      const from = await company("A1", { websiteDomain: "late.example", websiteDomainSource: "user", websiteDomainConfirmedAt: late });
      const into = await company("B1", { websiteDomain: "early.example", websiteDomainSource: "user", websiteDomainConfirmedAt: early });
      const dry = await run(pair(from.id, into.id));
      expect(dry.text).toContain("the website domain early.example loses");
      await run([...pair(from.id, into.id), "--apply"]);
      expect((await companies())[0]).toMatchObject({ websiteDomain: "late.example", websiteDomainConfirmedAt: late });

      const other = await company("C1", { websiteDomain: "inferred.example", websiteDomainSource: "inferred" });
      const result = await run([...pair(other.id, into.id), "--apply"]);
      expect(result.text).toContain("the website domain inferred.example loses");
      expect((await companies()).find((row) => row.id === into.id)).toMatchObject({ websiteDomain: "late.example", websiteDomainSource: "user" });
    });

    it("keeps both of two lookups with one key and reads the newest", async () => {
      const from = await company("A1");
      const into = await company("B1");
      const old = await salary(into.id, into.nameNorm, null, new Date("2026-01-01T00:00:00Z"));
      const fresh = await salary(from.id, from.nameNorm, null, new Date("2026-06-01T00:00:00Z"));
      await run([...pair(from.id, into.id), "--apply"]);
      expect((await lookups()).map((row) => row.id).sort()).toEqual([old.id, fresh.id].sort());
      const found = await findLatestSalaryLookup(db(), { lookupKey: salaryLookupKey({ ...JOB_KEY, companyNorm: into.nameNorm }, null), promptVersion: PROMPT });
      expect(found).toMatchObject({ id: fresh.id });
    });

    it("keeps both backgrounds and reads the newest", async () => {
      const from = await company("A1");
      const into = await company("B1");
      await research(into.id, new Date("2026-01-01T00:00:00Z"));
      const fresh = await research(from.id, new Date("2026-06-01T00:00:00Z"));
      await run([...pair(from.id, into.id), "--apply"]);
      expect(await backgrounds()).toHaveLength(2);
      expect(await findLatestCompanyResearch(db(), { companyId: into.id, promptVersion: 1, now: NOW })).toMatchObject({ id: fresh.id });
    });
  });

  describe("configuration that names companies", () => {
    it("keeps a company watched that only the removed row's watch-list entry matched, and says so", async () => {
      const from = await company("Alephalpha");
      const into = await company("Aleph Alpha");
      const context = { ...emptyContext, watchedCompanies: ["Alephalpha"] };
      const dry = await run(pair(from.id, into.id), context);
      expect(dry.text).toContain("watched_companies entries name the removed row and stop matching: Alephalpha");
      expect((await companies()).find((row) => row.id === into.id)?.watched).toBe(false);

      const result = await run([...pair(from.id, into.id), "--apply"], context);
      expect(result.text).toContain("edit interests.yaml");
      const [kept] = await companies();
      expect(kept?.watched).toBe(true);
      expect(isCompanyWatched(kept!, buildWatchedCompanyKeys(context.watchedCompanies, pipeline))).toBe(true);
    });

    it("warns when an exclusion of the removed row would spread to the kept company", async () => {
      const from = await company("Alephalpha");
      const into = await company("Aleph Alpha");
      const dry = await run(pair(from.id, into.id), { ...emptyContext, excludedCompanies: ["Alephalpha"] });
      expect(dry.code).toBe(0);
      expect(dry.text).toContain("after the merge it excludes the whole kept company");
      expect((await run(pair(from.id, into.id))).text).not.toContain("exclude_companies");
    });

    it("notes a trusted entry that stops matching", async () => {
      const from = await company("Alephalpha");
      const into = await company("Aleph Alpha");
      expect((await run(pair(from.id, into.id), { ...emptyContext, trustedKeys: [from.nameNorm] })).text).toContain("trusted_companies entry names the removed row");
    });
  });

  describe("batches", () => {
    it("a second run of a plan reports everything as merged and changes nothing", async () => {
      const a = await company("A1");
      const b = await company("B1");
      const c = await company("C1");
      await job(a.id);
      const file = path.join(planDir, "again.txt");
      writeFileSync(file, `# plan\n${a.id} ${b.id}  # A1 -> B1\n${b.id} ${c.id}\n`);
      expect((await run(["--plan", file, "--apply"])).code).toBe(0);
      const before = await snapshot();
      const second = await run(["--plan", file, "--apply"]);
      expect(second.code).toBe(0);
      expect(second.text).toContain("0 merged, 2 already merged, 0 failed");
      expect(await snapshot()).toEqual(before);
      const dry = await run(["--plan", file]);
      expect(dry.code).toBe(0);
      expect(dry.text).toContain("0 pairs can be merged, 2 already merged, 0 refused");
    });

    it("a pair with no row and no record fails, and the others still run", async () => {
      const a = await company("A1");
      const b = await company("B1");
      const c = await company("C1");
      const d = await company("D1");
      const result = await run([...pair(a.id, b.id), ...pair(99999, b.id), ...pair(c.id, d.id), "--apply"]);
      expect(result.code).toBe(1);
      expect(result.text).toContain("2 merged, 0 already merged, 1 failed");
      expect((await companies()).map((row) => row.id)).toEqual([b.id, d.id]);
    });

    it("the same row into another company later in the plan fails", async () => {
      const a = await company("A1");
      const b = await company("B1");
      const c = await company("C1");
      expect((await run([...pair(a.id, b.id), ...pair(a.id, c.id), "--apply"])).code).toBe(1);
      expect((await run([...pair(a.id, b.id), ...pair(a.id, c.id)])).code).toBe(1);
    });

    it("a pair that fails midway leaves no trace of itself, and the next one runs", async () => {
      const from = await aPairWithEverything();
      const c = await company("C1");
      const d = await company("D1");
      // the record is the last write of a merge; a failure there must take the whole pair back
      await db().execute(sql`create function refuse_merge_record() returns trigger language plpgsql as $$ begin if new.from_company_id = ${sql.raw(String(from.from.id))} then raise exception 'injected'; end if; return new; end $$`);
      await db().execute(sql`create trigger refuse_merge_record before insert on company_merges for each row execute function refuse_merge_record()`);
      try {
        const before = await snapshot();
        const result = await run([...pair(from.from.id, from.into.id), ...pair(c.id, d.id), "--apply"]);
        expect(result.code).toBe(1);
        expect(result.text).toContain("injected");
        expect(result.text).toContain("1 merged, 0 already merged, 1 failed");
        const after = await snapshot();
        expect(after.jobs).toEqual(before.jobs);
        expect(after.salary).toEqual(before.salary);
        expect(after.research).toEqual(before.research);
        const untouched = (rows: typeof before.companies) => rows.filter((row) => row.id === from.from.id || row.id === from.into.id);
        expect(untouched(after.companies)).toEqual(untouched(before.companies));
        expect(after.merges.map((row) => row.fromCompanyId)).toEqual([c.id]);
      } finally {
        await db().execute(sql`drop trigger refuse_merge_record on company_merges`);
        await db().execute(sql`drop function refuse_merge_record`);
      }
    });
  });

  describe("what stops a run", () => {
    const hold = async (fn: () => Promise<unknown>) => {
      const locked = await withCycleLock(db(), "try", fn);
      expect(locked.acquired).toBe(true);
    };

    it("a held cycle lock stops --apply and --undo --apply", async () => {
      const from = await company("A1");
      const into = await company("B1");
      const c = await company("C1");
      await run([...pair(c.id, into.id), "--apply"]);
      const [record] = await merges();
      const before = await snapshot();
      await hold(async () => {
        const merge = await run([...pair(from.id, into.id), "--apply"]);
        expect(merge.code).toBe(1);
        expect(merge.errText).toContain("A cycle or a reprocess is running");
        const undo = await run(["--undo", String(record!.id), "--apply"]);
        expect(undo.code).toBe(1);
        expect(undo.errText).toContain("A cycle or a reprocess is running");
      });
      expect(await snapshot()).toEqual(before);
    });

    it.each(["salary_lookup", "company_research"] as const)("a running %s stops --apply and --undo --apply; a pending one does not", async (kind) => {
      const from = await company("A1");
      const into = await company("B1");
      const c = await company("C1");
      await run([...pair(c.id, into.id), "--apply"]);
      const [record] = await merges();
      const [request] = await db().insert(schema.controlRequests).values({ kind, status: "running", payload: {} }).returning();
      const before = await snapshot();

      const merge = await run([...pair(from.id, into.id), "--apply"]);
      expect(merge.code).toBe(1);
      expect(merge.errText).toContain(`requests are running (${request!.id})`);
      expect((await run(["--undo", String(record!.id), "--apply"])).code).toBe(1);
      expect(await snapshot()).toEqual(before);

      await db().update(schema.controlRequests).set({ status: "pending" }).where(eq(schema.controlRequests.id, request!.id));
      expect((await run([...pair(from.id, into.id), "--apply"])).code).toBe(0);
    });
  });

  it("answers bad arguments and bad plan files with exit code 2", async () => {
    const file = path.join(planDir, "bad.txt");
    writeFileSync(file, "1 2\nnot a pair\n");
    const cases = [[], ["--nonsense"], ["--suggest", "--list"], ["--suggest", "--apply"], ["--list", "--apply"], ["--suggest", "--tier", "3"], ["--tier", "1"], ["--pair", "x:y"], ["--pair", "1"], ["--plan", file], ["--plan", path.join(planDir, "missing.txt")], ["--undo", "abc"], ["--plan", file, "--pair", "1:2"]];
    for (const argv of cases) expect((await run(argv)).code, argv.join(" ")).toBe(2);
    const empty = path.join(planDir, "empty.txt");
    writeFileSync(empty, "# only a comment\n");
    expect((await run(["--plan", empty, "--apply"])).code).toBe(0);
  });
});

describe("the pipeline after a merge", () => {
  const FROM_POSTING = { id: "p1", company: "Alephalpha", title: "Data Engineer" };

  it("files a new posting under the merged spelling at the kept company, and reprocess does not bring the row back", async () => {
    const from = await company("Alephalpha");
    const into = await company("Aleph Alpha");
    const existing = await job(from.id, "Researcher");
    await run([...pair(from.id, into.id), "--apply"]);

    const result = await ingest([FROM_POSTING]);
    expect(result).toMatchObject({ created: 1, deferred: 0 });
    expect((await companies()).map((row) => row.id)).toEqual([into.id]);
    expect((await jobs()).every((row) => row.companyId === into.id)).toBe(true);
    expect((await jobs()).map((row) => row.id)).toContain(existing.id);

    const again = await reprocess([FROM_POSTING]);
    expect(again).toMatchObject({ created: 0, deferred: 0 });
    expect((await companies()).map((row) => row.id)).toEqual([into.id]);
  });

  it("uses the kept company's key for the related-company check", async () => {
    const description = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const from = await company("Alephalpha");
    const into = await company("Aleph Alpha");
    const related = await company("Aleph Robotics");
    await run([...pair(from.id, into.id), "--apply"]);
    await ingest([{ id: "r1", company: "Aleph Robotics", title: "Data Engineer", description }]);
    const relatedJob = (await jobs())[0]!;
    expect(relatedJob.companyId).toBe(related.id);
    // "alephalpha" shares no first word with "aleph-robotics"; the kept company's key does, so the copy joins that job
    const result = await ingest([{ ...FROM_POSTING, id: "r2", description }]);
    expect(result.merged.simhash).toBe(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("a key with a row of its own stays on that row, whatever aliases say", async () => {
    const own = await company("Alephalpha");
    const other = await company("Aleph Alpha", { aliases: ["Alephalpha"] });
    await ingest([FROM_POSTING]);
    const [row] = await jobs();
    expect(row?.companyId).toBe(own.id);
    expect(row?.companyId).not.toBe(other.id);
  });

  it("does not redirect a key the aliases of two companies give, and warns", async () => {
    await company("One", { aliases: ["Shared Name"] });
    await company("Two", { aliases: ["Shared Name"] });
    const warn = vi.fn();
    const logger = { ...quietLogger, warn, child: () => logger };
    await ingest([{ id: "p2", company: "Shared Name", title: "Data Engineer" }], logger);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("several companies"), expect.objectContaining({ key: "shared-name" }));
    expect((await companies()).map((row) => row.name)).toEqual(["One", "Two", "Shared Name"]);
  });

  it("falls back to its own row when the alias target is gone", async () => {
    // the index is read once at the start of a run, so it can name a row that went since
    const resolved = { name: "Alephalpha", nameNorm: "alephalpha", aliases: [] };
    const row = await companyOfPosting(db(), resolved, new Map([["alephalpha", 99999]]));
    expect(row).toMatchObject({ name: resolved.name, nameNorm: resolved.nameNorm });
    expect((await companies()).map((stored) => stored.id)).toEqual([row.id]);
  });
});

describe("undo", () => {
  it("puts the moved things and the kept row back, field by field", async () => {
    const stamp = new Date("2026-05-05T05:05:05.123Z");
    const { from, into, j1, j2, j3, lookup, background } = await aPairWithEverything();
    await db().update(schema.companies).set({ watched: true, websiteDomain: "from.example", websiteDomainSource: "user", websiteDomainConfirmedAt: stamp }).where(eq(schema.companies.id, from.id));
    await db().update(schema.companies).set({ aliases: ["Own Alias"] }).where(eq(schema.companies.id, into.id));
    const before = await snapshot();

    expect((await run([...pair(from.id, into.id), "--apply"])).code).toBe(0);
    const [record] = await merges();
    const merged = (await companies()).find((row) => row.id === into.id);
    expect(merged).toMatchObject({ watched: true, websiteDomain: "from.example", atsKind: "greenhouse" });
    expect((await lookups())[0]?.lookupKey).not.toBe(lookup.lookupKey);

    const dry = await run(["--undo", String(record!.id)]);
    expect(dry.code).toBe(0);
    expect(dry.text).toContain("moves back: 2 jobs, 1 salary lookups, 1 company backgrounds");
    expect((await companies()).map((row) => row.id)).toEqual([into.id]);

    expect((await run(["--undo", String(record!.id), "--apply"])).code).toBe(0);
    const after = await snapshot();
    expect(after.companies).toEqual(before.companies);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.salary).toEqual(before.salary);
    expect(after.research).toEqual(before.research);
    expect((await jobs()).map((row) => row.id)).toEqual([j1.id, j2.id, j3.id]);
    expect(after.research[0]?.id).toBe(background.id);
    expect(after.merges[0]?.undoneAt).toBeInstanceOf(Date);

    const list = await run(["--list"]);
    expect(list.text).toContain("Alephalpha");
    expect(list.text).toContain("undone");

    const twice = await run(["--undo", String(record!.id), "--apply"]);
    expect(twice.code).toBe(1);
    expect(twice.text).toContain("already undone");
  });

  it("says which results made for a moved job since the merge stay on the kept company", async () => {
    const from = await company("A1");
    const into = await company("B1");
    const moved = await job(from.id);
    const own = await job(into.id, "Researcher");
    await run([...pair(from.id, into.id), "--apply"]);
    const [record] = await merges();
    const line = (salaryCount: number, researchCount: number) => `staying on the kept company: ${salaryCount} salary lookups, ${researchCount} company backgrounds`;
    expect((await run(["--undo", String(record!.id)])).text).toContain(line(0, 0));

    const lookup = await salary(into.id, into.nameNorm, moved.id);
    const [background] = await db().insert(schema.companyResearch).values({ companyId: into.id, jobId: moved.id, status: "ok", resultJson: { fields: {}, dropped: 0 }, promptVersion: 1, fetchedAt: NOW }).returning();
    // a result of the kept company's own job is no concern of this undo
    await salary(into.id, into.nameNorm, own.id);

    expect((await run(["--undo", String(record!.id)])).text).toContain(line(1, 1));
    const applied = await run(["--undo", String(record!.id), "--apply"]);
    expect(applied.code).toBe(0);
    expect(applied.text).toContain(line(1, 1));
    expect((await lookups()).find((row) => row.id === lookup.id)?.companyId).toBe(into.id);
    expect((await backgrounds()).find((row) => row.id === background!.id)?.companyId).toBe(into.id);
  });

  it("restores the microseconds of the removed row's timestamps", async () => {
    const from = await company("A1");
    const into = await company("B1");
    await db().execute(sql`update companies set created_at = '2026-01-02 03:04:05.678901+00' where id = ${from.id}`);
    await run([...pair(from.id, into.id), "--apply"]);
    const [record] = await merges();
    await run(["--undo", String(record!.id), "--apply"]);
    const [row] = await db().execute<{ t: string }>(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as t from companies where id = ${from.id}`);
    expect(row?.t).toBe("2026-01-02 03:04:05.678901");
  });

  it("leaves what changed since the merge and says so; only this merge's aliases go", async () => {
    const from = await company("A1", { blacklisted: true, atsKind: "lever", atsToken: "a1" });
    const into = await company("B1", { aliases: ["Own"] });
    await run([...pair(from.id, into.id), "--apply"]);
    const [record] = await merges();
    await db().update(schema.companies).set({ blacklisted: false, atsKind: "ashby", atsToken: "b1", aliases: ["Own", "A1", "Added Later"] }).where(eq(schema.companies.id, into.id));
    const result = await run(["--undo", String(record!.id), "--apply"]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("changed since the merge: blacklisted, ats");
    expect((await companies()).find((row) => row.id === into.id)).toMatchObject({ blacklisted: false, atsKind: "ashby", atsToken: "b1", aliases: ["Own", "Added Later"] });
    expect((await companies()).find((row) => row.id === from.id)).toMatchObject({ blacklisted: true, atsKind: "lever", atsToken: "a1" });
  });

  describe("refusals", () => {
    const merged = async () => {
      const from = await company("A1");
      const into = await company("B1");
      await run([...pair(from.id, into.id), "--apply"]);
      const [record] = await merges();
      return { from, into, mergeId: String(record!.id) };
    };
    const expectRefused = async (mergeId: string, message: string) => {
      const before = await snapshot();
      for (const argv of [["--undo", mergeId], ["--undo", mergeId, "--apply"]]) {
        const result = await run(argv);
        expect(result.code).toBe(1);
        expect(result.text).toContain(message);
      }
      expect(await snapshot()).toEqual(before);
    };

    it("a merge that does not exist", async () => {
      expect((await run(["--undo", "12345"])).text).toContain("does not exist");
      expect((await run(["--undo", "12345", "--apply"])).code).toBe(1);
    });

    it("the removed row's key is taken", async () => {
      const { from, mergeId } = await merged();
      await getOrCreateCompany(db(), { name: "A1 again", nameNorm: from.nameNorm });
      await expectRefused(mergeId, "another company row now has the removed row's key");
    });

    it("the kept row is gone", async () => {
      const { into, mergeId } = await merged();
      await db().delete(schema.companies).where(eq(schema.companies.id, into.id));
      await expectRefused(mergeId, "the kept company no longer exists");
    });

    it("a later merge involves the rows, until that one is undone", async () => {
      const { into, mergeId } = await merged();
      const next = await company("C1");
      await run([...pair(into.id, next.id), "--apply"]);
      await expectRefused(mergeId, "a later merge involves these rows");

      const later = (await merges())[1]!;
      expect((await run(["--undo", String(later.id), "--apply"])).code).toBe(0);
      expect((await run(["--undo", mergeId, "--apply"])).code).toBe(0);
      expect((await companies()).map((row) => row.name).sort()).toEqual(["A1", "B1", "C1"]);
    });

    it("a merge undone already", async () => {
      const { mergeId } = await merged();
      await run(["--undo", mergeId, "--apply"]);
      await expectRefused(mergeId, "already undone");
    });
  });

  it("prints what arrived since the merge, and a reprocess brings a single-source job back to the removed row", async () => {
    const posting = { id: "p1", company: "Alephalpha", title: "Data Engineer" };
    const from = await company("Alephalpha");
    const into = await company("Aleph Alpha");
    await run([...pair(from.id, into.id), "--apply"]);
    const [record] = await merges();
    await ingest([posting]);
    expect((await jobs()).map((row) => row.companyId)).toEqual([into.id]);

    const dry = await run(["--undo", String(record!.id)]);
    expect(dry.text).toContain("1 new jobs on the kept company, 1 postings");
    const applied = await run(["--undo", String(record!.id), "--apply"]);
    expect(applied.text).toContain("1 new jobs on the kept company, 1 postings");
    // the undo itself leaves it on the kept company
    expect((await jobs()).map((row) => row.companyId)).toEqual([into.id]);

    await reprocess([posting]);
    expect((await jobs()).map((row) => row.companyId)).toEqual([from.id]);
    expect((await companies()).map((row) => row.id).sort()).toEqual([from.id, into.id].sort());
  });
});

describe("--suggest and --list", () => {
  it("lists production-shaped candidates in a form a plan file can hold, and writes nothing", async () => {
    const aleph = await company("Aleph Alpha");
    const slug = await company("Alephalpha");
    const allianz = await company("Allianz");
    const services = await company("Allianz Services");
    await company("JUNI");
    await company("junini");
    await job(aleph.id);
    await job(aleph.id, "Researcher");
    await job(slug.id);
    await job(allianz.id);
    const before = await snapshot();

    const tierOne = await run(["--suggest", "--tier", "1"]);
    expect(tierOne.code).toBe(0);
    expect(parsePlanText(tierOne.text)).toEqual({ ok: true, pairs: [{ fromId: slug.id, intoId: aleph.id }] });
    expect(tierOne.text).toContain("Alephalpha (1 jobs) -> Aleph Alpha (2 jobs)");

    const tierTwo = await run(["--suggest", "--tier", "2"]);
    expect(parsePlanText(tierTwo.text)).toEqual({ ok: true, pairs: [{ fromId: services.id, intoId: allianz.id }] });

    const all = await run(["--suggest"]);
    expect(parsePlanText(all.text)).toEqual({ ok: true, pairs: [{ fromId: slug.id, intoId: aleph.id }, { fromId: services.id, intoId: allianz.id }] });
    expect(all.text).not.toMatch(/juni/i);
    expect(await snapshot()).toEqual(before);
  });

  it("writes only the plan to --out, and --plan reads that file", async () => {
    const aleph = await company("Aleph Alpha");
    const slug = await company("Alephalpha");
    const file = path.join(planDir, "suggested.txt");
    const result = await run(["--suggest", "--tier", "1", "--out", file]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([`1 candidate pairs written to ${file}.`]);
    expect(parsePlanText(readFileSync(file, "utf8"))).toEqual({ ok: true, pairs: [{ fromId: slug.id, intoId: aleph.id }] });
    expect((await run(["--plan", file])).code).toBe(0);

    // what a redirect through pnpm leaves in the file is what the option avoids
    writeFileSync(file, `Already up to date\n${readFileSync(file, "utf8")}Done in 300ms\n`);
    expect((await run(["--plan", file])).code).toBe(2);
  });

  it("answers --out it cannot use with exit code 2", async () => {
    expect((await run(["--suggest", "--out", path.join(planDir, "no-such-dir", "plan.txt")])).code).toBe(2);
    expect((await run(["--list", "--out", path.join(planDir, "x.txt")])).code).toBe(2);
    expect((await run(["--suggest", "--out", ""])).code).toBe(2);
  });

  it("keeps a name that would break a plan line on one line", async () => {
    const a = await company("Line\nBreak Co");
    const b = await company("LineBreak Co");
    await db().update(schema.companies).set({ nameNorm: b.nameNorm + "x" }).where(eq(schema.companies.id, a.id));
    const result = await run(["--suggest"]);
    expect(parsePlanText(result.text).ok).toBe(true);
  });

  it("lists the merges", async () => {
    expect((await run(["--list"])).text).toContain("No merges recorded");
    const from = await company("A1");
    const into = await company("B1");
    await job(from.id);
    await run([...pair(from.id, into.id), "--apply"]);
    const listed = await run(["--list"]);
    expect(listed.text).toContain(`A1 (#${from.id}) -> B1 (#${into.id})  1 jobs  in force`);
  });
});

describe("configuration", () => {
  it("the effective configuration keeps the tail words", () => {
    expect(loadPipeline().company.duplicate_tail_words.length).toBeGreaterThan(0);
    expect(pipeline.company.duplicate_tail_words).toEqual(["services", "group"]);
  });
});
