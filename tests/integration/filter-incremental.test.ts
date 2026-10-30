import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, expect, inject, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import * as filterDb from "@/lib/db";
import { listFilterCandidates } from "@/lib/db/repos/filter-results";
import { setFilterOverride, clearFilterOverride } from "@/lib/db/repos/filter-overrides";
import { runFilter } from "@/lib/filter";

import { prefs } from "../filter/helpers";
import { shippedPipeline } from "../pipeline/helpers";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, listFilterCandidates: vi.fn(actual.listFilterCandidates) };
});

const client = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });
afterAll(() => client.end());

async function fixture() {
  const [company] = await db.insert(schema.companies).values({ name: "Example", nameNorm: "example" }).returning();
  const rows = await db.insert(schema.jobs).values([1, 2].map((i) => ({ companyId: company!.id, title: `Engineer ${i}`, titleNorm: `engineer ${i}`, description: "Build software.", workplace: "remote" as const, contract: "permanent" }))).returning();
  const [snapshot] = await db.insert(schema.profileSnapshots).values({ kind: "preferences", hash: "fixture", contentYaml: "fixture" }).returning();
  const options = { snapshotId: snapshot!.id, preferences: prefs(), pipeline: shippedPipeline(), me: null, watchedCompanies: [] as string[] };
  return { rows, company: company!, options, run: () => runFilter(db, options) };
}

it("skips unchanged jobs without rewriting scores and reevaluates only changed inputs", async () => {
  const { rows, run } = await fixture();
  expect(await run()).toMatchObject({ evaluated: 2, created: 2 });
  const before = await db.select().from(schema.scores).orderBy(schema.scores.id);
  expect(await run()).toMatchObject({ evaluated: 0, created: 0, updated: 0 });
  expect(await db.select().from(schema.scores).orderBy(schema.scores.id)).toEqual(before);
  await db.update(schema.jobs).set({ lastSeenAt: new Date(), linkCheckedAt: new Date() }).where(eq(schema.jobs.id, rows[0]!.id));
  expect(await run()).toMatchObject({ evaluated: 0 });
  for (const patch of [{ description: "Changed JD." }, { title: "New title" }, { contract: "student" }, { salaryJson: { raw: "different" } }, { workplace: "onsite" as const }, { seniority: "junior" }, { germanLevelRequired: "B2" }, { locationsJson: [{ label: "Elsewhere" }] }]) {
    await db.update(schema.jobs).set(patch).where(eq(schema.jobs.id, rows[0]!.id));
    expect(await run()).toMatchObject({ evaluated: 1 });
    expect(await run()).toMatchObject({ evaluated: 0 });
  }
});

it("invalidates company, override, watch list, pipeline, user profile and snapshot inputs", async () => {
  const { rows, company, options, run } = await fixture();
  await run();
  for (const patch of [{ name: "Renamed" }, { nameNorm: "renamed" }, { aliases: ["Alias"] }, { watched: true }, { blacklisted: true }]) {
    await db.update(schema.companies).set(patch).where(eq(schema.companies.id, company.id));
    expect(await run()).toMatchObject({ evaluated: 2 });
    expect(await run()).toMatchObject({ evaluated: 0 });
  }
  await setFilterOverride(db, rows[0]!.id, "keep");
  expect(await run()).toMatchObject({ evaluated: 1 });
  await clearFilterOverride(db, rows[0]!.id);
  expect(await run()).toMatchObject({ evaluated: 1 });
  options.watchedCompanies = ["Example"];
  expect(await run()).toMatchObject({ evaluated: 2 });
  expect(await runFilter(db, { ...options, pipeline: { ...options.pipeline, batch_size: options.pipeline.batch_size + 1 } })).toMatchObject({ evaluated: 2 });
  expect(await runFilter(db, { ...options, me: { languages: [{ de: "B2" }] } })).toMatchObject({ evaluated: 2 });
  const [snapshot] = await db.insert(schema.profileSnapshots).values({ kind: "preferences", hash: "other", contentYaml: "other" }).returning();
  expect(await runFilter(db, { ...options, snapshotId: snapshot!.id })).toMatchObject({ evaluated: 2, created: 2 });
  expect(await runFilter(db, { ...options, jobIds: [rows[0]!.id] })).toMatchObject({ evaluated: 1 });
});

it("returns the same forced candidates as the old full scan and keeps batch paging complete", async () => {
  const { run, rows, options } = await fixture();
  const old = await db.execute<{ id: string }>(sql`select j.id from jobs j join companies c on c.id = j.company_id where j.id > 0 and j.status <> 'closed'
    and not (j.status = 'possibly_closed' and j.dormant_at is not null and j.dormant_at > j.last_seen_at) order by j.id limit 10`);
  const candidates = await listFilterCandidates(db, { afterId: 0, limit: 10 });
  expect(candidates.map((r) => r.id)).toEqual(old.map((r) => Number(r.id)));
  await run();
  expect(await run()).toMatchObject({ evaluated: 0 });
  await db.update(schema.jobs).set({ title: "Changed last row" }).where(eq(schema.jobs.id, rows[1]!.id));
  expect(await runFilter(db, { ...options, pipeline: { ...options.pipeline, batch_size: 1 } })).toMatchObject({ evaluated: 2 });
  await db.update(schema.jobs).set({ title: "Changed again" }).where(eq(schema.jobs.id, rows[1]!.id));
  expect(await runFilter(db, { ...options, pipeline: { ...options.pipeline, batch_size: 1 } })).toMatchObject({ evaluated: 1 });
  const before = await db.select({ jobId: schema.scores.jobId, filterResult: schema.scores.filterResult, filterReasons: schema.scores.filterReasons }).from(schema.scores).orderBy(schema.scores.jobId);
  expect(await runFilter(db, { ...options, jobIds: rows.map((r) => r.id) })).toMatchObject({ evaluated: 2 });
  expect(await db.select({ jobId: schema.scores.jobId, filterResult: schema.scores.filterResult, filterReasons: schema.scores.filterReasons }).from(schema.scores).orderBy(schema.scores.jobId)).toEqual(before);
});

it("retries partial deal-breaker judgements and keeps AI fields when updating filter fingerprints", async () => {
  const { rows, options } = await fixture();
  const preferences = prefs((raw) => { raw.deal_breakers = [{ id: "partial-rule", label: "Rule", type: "phrase", patterns: ["uncached-unique-pattern"] }]; });
  const input = { ...options, preferences, timeBox: () => false };
  const partial = await runFilter(db, input);
  expect(partial.dealBreakerWarnings.some((w) => w.code === "too_slow")).toBe(true);
  expect(await runFilter(db, input)).toMatchObject({ evaluated: 2 });
  const complete = { ...input, timeBox: (work: () => void) => { work(); return true; } };
  expect(await runFilter(db, complete)).toMatchObject({ evaluated: 2 });
  // Timed rules must judge unchanged jobs too: a later run can run out of budget without an input change.
  expect(await runFilter(db, complete)).toMatchObject({ evaluated: 2 });
  await withRebuiltCurrentScores(db, db.update(schema.scores).set({ score: 80, aiScore: 85, signalBonus: 2, rankValue: 82, model: "fixture" }).where(eq(schema.scores.jobId, rows[0]!.id)));
  await db.update(schema.jobs).set({ title: "New title" }).where(eq(schema.jobs.id, rows[0]!.id));
  expect(await runFilter(db, complete)).toMatchObject({ evaluated: 2 });
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, rows[0]!.id))).toMatchObject([{ score: 80, aiScore: 85, signalBonus: 2, rankValue: 82, model: "fixture" }]);
});

it.each(["phrase", "visa_not_offered"] as const)("reports a later %s timeout for unchanged jobs and recovers without losing stored vetoes", async (type) => {
  const { rows, options } = await fixture();
  const preferences = prefs((raw) => {
    raw.deal_breakers = [type === "phrase"
      ? { id: "timed-rule", label: "On-site", type, patterns: ["fully on-site"] }
      : { id: "timed-rule", label: "Visa refusal", type }];
  });
  await db.update(schema.jobs).set({ description: "Fully on-site. We are unable to offer visa sponsorship for this role." }).where(eq(schema.jobs.id, rows[0]!.id));
  const input = {
    ...options, preferences, me: { languages: [], needs_visa_sponsorship: true },
    pipeline: { ...options.pipeline, batch_size: 1 },
    timeBox: (work: () => void) => { work(); return true; },
  };
  expect(await runFilter(db, input)).toMatchObject({ evaluated: 2, filteredOut: 1, dealBreakerWarnings: [] });
  const verdicts = () => db.select({ jobId: schema.scores.jobId, result: schema.scores.filterResult, reasons: schema.scores.filterReasons }).from(schema.scores).orderBy(schema.scores.jobId);
  const before = await verdicts();

  const stopped = await runFilter(db, { ...input, timeBox: () => false });
  expect(stopped.dealBreakerWarnings).toEqual([{ id: "timed-rule", code: "too_slow" }]);
  expect(stopped).toMatchObject({ evaluated: 2, updated: 0, unchanged: 2 });
  expect(await verdicts()).toEqual(before);
  expect(await db.select({ input: schema.scores.filterInputHash, config: schema.scores.filterConfigHash }).from(schema.scores)).toEqual([{ input: null, config: null }, { input: null, config: null }]);
  expect(await runFilter(db, input)).toMatchObject({ evaluated: 2, updated: 0, filteredOut: 1, dealBreakerWarnings: [] });
  expect(await verdicts()).toEqual(before);

  await db.update(schema.jobs).set({ description: "Build software." }).where(eq(schema.jobs.id, rows[0]!.id));
  expect(await runFilter(db, input)).toMatchObject({ evaluated: 2, updated: 1, filteredOut: 0, dealBreakerWarnings: [] });
  const withoutTimedRules = { ...input, preferences: prefs() };
  expect(await runFilter(db, withoutTimedRules)).toMatchObject({ evaluated: 2 });
  expect(await runFilter(db, withoutTimedRules)).toMatchObject({ evaluated: 0 });
});

it("distinguishes a missing description from an empty description in remote-scope rules", async () => {
  const { rows, options } = await fixture();
  const pipeline = structuredClone(options.pipeline);
  pipeline.filter.remote.description_in_scope_patterns = ["^$"];
  const preferences = prefs((raw) => { raw.remote_scope = "home_country"; });
  const input = { ...options, pipeline, preferences, jobIds: undefined };
  await db.update(schema.jobs).set({ description: null, locationsJson: [{ label: "Tokyo", city: "Tokyo", countryCode: "JP", isPrimary: true }] }).where(eq(schema.jobs.id, rows[0]!.id));
  await runFilter(db, input);
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, rows[0]!.id))).toMatchObject([{ filterResult: "filtered_out" }]);
  await db.update(schema.jobs).set({ description: "" }).where(eq(schema.jobs.id, rows[0]!.id));
  expect(await runFilter(db, input)).toMatchObject({ evaluated: 1 });
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, rows[0]!.id))).toMatchObject([{ filterResult: "passed" }]);
  await db.update(schema.jobs).set({ description: null }).where(eq(schema.jobs.id, rows[0]!.id));
  expect(await runFilter(db, input)).toMatchObject({ evaluated: 1 });
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, rows[0]!.id))).toMatchObject([{ filterResult: "filtered_out" }]);
});

it("invalidates cached verdicts changed by old code during rollback, including reasons alone", async () => {
  const { rows, run } = await fixture();
  await run();
  const id = rows[0]!.id;
  // Old code changes the input and writes the verdict without naming either new hash column.
  await db.update(schema.jobs).set({ contract: "student" }).where(eq(schema.jobs.id, id));
  await db.execute(sql`update scores set filter_result = 'filtered_out', filter_reasons = array['old-rule'] where job_id = ${id}`);
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, id))).toMatchObject([{ filterInputHash: null, filterConfigHash: null }]);
  await db.update(schema.jobs).set({ contract: "permanent" }).where(eq(schema.jobs.id, id));
  expect(await run()).toMatchObject({ evaluated: 1 });
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, id))).toMatchObject([{ filterResult: "passed" }]);
  await db.execute(sql`update scores set filter_reasons = array['old-reason-only'] where job_id = ${id}`);
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, id))).toMatchObject([{ filterInputHash: null, filterConfigHash: null }]);
  expect(await run()).toMatchObject({ evaluated: 1 });
  expect(await run()).toMatchObject({ evaluated: 0 });
});

it.each([true, false])("evaluates the override read with its fingerprint when keep/undo interleaves (%s)", async (initialKeep) => {
  const { rows, company, run } = await fixture();
  const id = rows[0]!.id;
  await db.update(schema.companies).set({ blacklisted: true }).where(eq(schema.companies.id, company.id));
  if (initialKeep) await setFilterOverride(db, id, "keep");
  vi.mocked(filterDb.listFilterCandidates).mockImplementationOnce(async (executor, input) => {
    const selected = await listFilterCandidates(executor, input);
    // A second request commits after the candidate SELECT and before the filter evaluates it.
    if (initialKeep) await clearFilterOverride(db, id);
    else await setFilterOverride(db, id, "keep");
    return selected;
  });
  await run();
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, id))).toMatchObject([{ filterResult: initialKeep ? "passed" : "filtered_out" }]);
  expect(await run()).toMatchObject({ evaluated: 1 });
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, id))).toMatchObject([{ filterResult: initialKeep ? "filtered_out" : "passed" }]);
  expect(await run()).toMatchObject({ evaluated: 0 });
});
