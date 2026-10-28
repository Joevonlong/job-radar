import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, expect, inject, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { listFilterCandidates } from "@/lib/db/repos/filter-results";
import { setFilterOverride, clearFilterOverride } from "@/lib/db/repos/filter-overrides";
import { runFilter } from "@/lib/filter";

import { prefs } from "../filter/helpers";
import { shippedPipeline } from "../pipeline/helpers";

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
  expect(await runFilter(db, complete)).toMatchObject({ evaluated: 0 });
  await db.update(schema.scores).set({ score: 80, aiScore: 85, signalBonus: 2, rankValue: 82, model: "fixture" }).where(eq(schema.scores.jobId, rows[0]!.id));
  await db.update(schema.jobs).set({ title: "New title" }).where(eq(schema.jobs.id, rows[0]!.id));
  expect(await runFilter(db, complete)).toMatchObject({ evaluated: 1 });
  expect(await db.select().from(schema.scores).where(eq(schema.scores.jobId, rows[0]!.id))).toMatchObject([{ score: 80, aiScore: 85, signalBonus: 2, rankValue: 82, model: "fixture" }]);
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
