import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { stringify } from "yaml";

import type { Permission } from "@/lib/agent-access/permissions";
import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { SALARY_PROMPT_VERSION } from "@/lib/ai/prompts/salary";
import { decodeSyncCursor, encodeSyncCursor, type CursorScope } from "@/lib/capabilities/sync/cursor";
import { loadConfig, resetConfigCache } from "@/lib/config";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { createConnection } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import { pruneAgentChanges, resetAgentChanges } from "@/lib/db/repos/agent-changes";
import { revertApplicationStatus } from "@/lib/db/repos/applications";
import { clearClosureOverride, setClosureOverride } from "@/lib/db/repos/closures";
import { clearFilterOverride, setFilterOverride } from "@/lib/db/repos/filter-overrides";
import { markSeen, markUnseen } from "@/lib/db/repos/seen";
import { listJobsToTrapScan } from "@/lib/db/repos/traps";
import * as schema from "@/lib/db/schema";
import { SYNC_DTO_VERSION } from "@/lib/db/sync-sources";
import { getJobOutput } from "@/lib/mcp/dto/jobs";
import { listJobChangesOutput, type ListJobChangesOutput } from "@/lib/mcp/dto/sync";
import { buildServer, checkMcpSyncStartup, defaultContext } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";
import { salaryLookupKey } from "@/lib/salary/lookup-key";
import type { SalaryLookupResult } from "@/lib/salary/lookup-types";
import { loadBaseCurrency } from "@/lib/signals/floor";
import { descriptionHash } from "@/lib/translation/hash";
import { rulesFingerprint } from "@/lib/traps/fingerprint";

import { makeTempConfig } from "../config/helpers";
import { blockBreakdown } from "../mcp/job-block-fixtures";
import { trapSettings } from "../traps/helpers";

const url = inject("testDatabaseUrl");
const writer = createConnection(url, { max: 1 });
const second = createConnection(url, { max: 1 });
const reader = createReadOnlyDb({ url });
const now = new Date("2026-03-13T12:00:00Z");
const expires = new Date("2026-03-20T12:00:00Z");
const beforeHold = new Date("2026-03-13T12:01:00Z");
const afterHold = new Date("2026-03-13T12:02:00Z");
const description = "Build reliable services.";
const traps = trapSettings();
const jobNumber = (item: { job_id: number }) => item.job_id;
const closers: Array<() => Promise<void>> = [];
type SyncArgs = { blocks?: string[]; limit?: number; cursor?: string | null };
let company: typeof schema.companies.$inferSelect;
let temp: ReturnType<typeof makeTempConfig> | undefined;

beforeEach(async () => {
  const [seed] = await writer.db.insert(schema.companies).values({ name: "Example Systems", nameNorm: "example systems" }).returning();
  company = seed!;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
  temp?.cleanup();
  temp = undefined;
});
afterAll(async () => {
  await Promise.all([reader.close(), writer.sql.end({ timeout: 5 }), second.sql.end({ timeout: 5 })]);
});

async function addJob(db: Executor, title: string, overrides: Partial<typeof schema.jobs.$inferInsert> = {}) {
  const [job] = await db.insert(schema.jobs).values({
    companyId: company.id, title, titleNorm: title.toLowerCase(), description, firstSeenAt: now, lastSeenAt: now, ...overrides,
  }).returning();
  return job!;
}

async function addSources(jobIds: number[]) {
  await writer.db.insert(schema.channels).values({ id: "fixture", family: "ats", kind: "ats" });
  const [raw] = await writer.db.insert(schema.rawPostings).values({ channelId: "fixture", externalId: "example", payloadJson: { description } }).returning();
  await writer.db.insert(schema.jobSources).values(jobIds.map((jobId) => ({
    jobId, rawPostingId: raw!.id, channelId: "fixture", url: "https://jobs.example.invalid/role", applyUrl: "https://jobs.example.invalid/apply",
  })));
  return raw!;
}

async function recordCurrentTraps(jobIds: number[]) {
  const rulesHash = rulesFingerprint(traps);
  const scans = await listJobsToTrapScan(writer.db, { rulesHash, jobIds, limit: jobIds.length });
  expect(scans).toHaveLength(jobIds.length);
  await writer.db.insert(schema.trapScans).values(scans.map(({ jobId, descriptionHash, sourcesHash }) => ({ jobId, descriptionHash, sourcesHash, rulesHash })));
}

async function connect(
  permissions: Permission[] = ["jobs:read"],
  options: { db?: ReadOnlyDb; locale?: "en" | "zh"; startup?: boolean; lines?: string[]; max?: number } = {},
) {
  const settings = mcpSchema.parse({ enabled: true, permissions, stdio: { permissions }, sync: { max_batch: options.max ?? 20 } });
  const db = options.db ?? reader;
  const ctx = defaultContext(db.db, settings, { readSettings: () => settings, text: mcpTranslator(options.locale ?? "en"), log: (line) => options.lines?.push(line) });
  ctx.now = () => now;
  ctx.traps = () => traps;
  if (options.startup) await checkMcpSyncStartup(ctx);
  const server = buildServer(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "sync-test", version: "1.0.0" });
  await client.connect(clientSide);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

async function sync(client: Client, args: SyncArgs = {}): Promise<ListJobChangesOutput> {
  const result = await client.callTool({ name: "list_job_changes", arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return listJobChangesOutput.parse(result.structuredContent);
}

async function syncError(client: Client, args: Record<string, unknown>, ...tokens: string[]) {
  const result = await client.callTool({ name: "list_job_changes", arguments: args });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
  for (const token of tokens) expect(JSON.stringify(result.content)).toContain(token);
}

function holdWriter<T>(write: (tx: Executor) => Promise<T>) {
  const ready = Promise.withResolvers<T>();
  const release = Promise.withResolvers<boolean>();
  const rollback = new Error("fixture rollback");
  const finished = writer.db.transaction(async (tx) => {
    ready.resolve(await write(tx));
    if (!await release.promise) throw rollback;
  }).catch((error: unknown) => {
    ready.reject(error);
    if (error !== rollback) throw error;
  });
  void finished.catch(() => {});
  return { ready: ready.promise, finish: async (commit = true) => { release.resolve(commit); await finished; } };
}

function useTestSalaryFamilies(): string {
  temp = makeTempConfig();
  fs.writeFileSync(path.join(temp.configDir, "salary.yaml"), stringify({
    ...loadConfig("salary"), role_families: [{ id: "systems", label: { en: "Systems" }, patterns: ["systems engineer"] }],
  }));
  resetConfigCache();
  const currency = loadBaseCurrency();
  if (!currency) throw new Error("the test market must have a base currency");
  return currency;
}

async function addSalaryLookup(job: typeof schema.jobs.$inferSelect, currency: string, location: { city: string; countryCode: string; label: string; isPrimary: boolean } | null) {
  const lookupKey = salaryLookupKey({ companyNorm: company.nameNorm, titleNorm: job.titleNorm, seniority: job.seniority, location }, "systems");
  const result: SalaryLookupResult = {
    query: { company: company.name, title: job.title, seniority: job.seniority, currency, city: location?.city ?? null, country: location?.countryCode ?? null },
    companyLevel: { level: "unknown", median: null, summary: "Example salary research", sources: [] },
    roleBand: null, relatedRoles: [], sources: [], notes: "Example found salary", confidence: "low", dropped: 0, observations: [],
  };
  const [stored] = await writer.db.insert(schema.salaryLookups).values({
    companyId: company.id, jobId: job.id, lookupKey, status: "done", promptVersion: SALARY_PROMPT_VERSION, resultJson: result,
    fetchedAt: now, expiresAt: expires,
  }).returning();
  return { stored: stored!, result };
}

describe("incremental job sync", () => {
  it.each([true, false])("defers a fast commit behind an older writer and continues after commit=%s", async (commit) => {
    const client = await connect();
    const start = await sync(client);
    const early = await addJob(second.db, "Before the open transaction");
    const writerA = holdWriter((tx) => addJob(tx, "Earlier writer"));
    let a, b, paused;
    try {
      a = await writerA.ready;
      b = await addJob(second.db, "Later writer");
      paused = await sync(client, { cursor: start.next_cursor });
      expect(paused.items.map(jobNumber)).toEqual([early.id]);
      expect(paused).toMatchObject({ phase: "changes", held_back: 1, has_more: false });
      const wait = await sync(client, { cursor: paused.next_cursor });
      expect(wait).toMatchObject({ items: [], held_back: 1, has_more: false, generation: start.generation });
      paused = wait;
    } finally {
      await writerA.finish(commit);
    }
    const resumed = await sync(client, { cursor: paused.next_cursor });
    expect(resumed.items.map(jobNumber)).toEqual(commit ? [a.id, b.id] : [b.id]);
    expect(resumed).toMatchObject({ held_back: 0, has_more: false });
    expect((await sync(client, { cursor: resumed.next_cursor })).items).toEqual([]);
  });

  it("defers commits behind a transaction that holds an ID without any job changes", async () => {
    const client = await connect();
    const start = await sync(client);
    const long = holdWriter((tx) => tx.execute(sql`select pg_current_xact_id()`));
    let cursor: string;
    let jobs: number[];
    try {
      await long.ready;
      jobs = [(await addJob(second.db, "First later commit")).id, (await addJob(second.db, "Second later commit")).id];
      const paused = await sync(client, { cursor: start.next_cursor });
      expect(paused).toMatchObject({ items: [], held_back: 2, has_more: false });
      cursor = paused.next_cursor;
    } finally {
      await long.finish();
    }
    expect((await sync(client, { cursor })).items.map(jobNumber)).toEqual(jobs);
  });

  it("handles a transaction that reads before writing and uses the top-level ID across savepoints", async () => {
    const client = await connect();
    const start = await sync(client);
    let after: string;
    let keptId: number;
    await writer.db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      const other = await addJob(second.db, "Committed before the first write");
      const poll = await sync(client, { cursor: start.next_cursor });
      expect(poll.items.map(jobNumber)).toEqual([other.id]);
      after = poll.next_cursor;
      const rollback = new Error("rollback savepoint");
      await expect(tx.transaction(async (savepoint) => {
        await addJob(savepoint, "Rolled back savepoint");
        throw rollback;
      })).rejects.toThrow(rollback.message);
      keptId = (await tx.transaction((savepoint) => addJob(savepoint, "Released savepoint"))).id;
    });
    expect((await sync(client, { cursor: after! })).items.map(jobNumber)).toEqual([keptId!]);
  });

  it("consumes consecutive duplicates and a following distinct job with a two-item limit", async () => {
    const a = await addJob(writer.db, "First");
    const b = await addJob(writer.db, "Second");
    const client = await connect();
    const start = await sync(client);
    await writer.db.transaction(async (tx) => {
      await tx.update(schema.jobs).set({ title: "First change" }).where(eq(schema.jobs.id, a.id));
      await tx.update(schema.jobs).set({ title: "Second change" }).where(eq(schema.jobs.id, a.id));
      await tx.update(schema.jobs).set({ title: "Third change" }).where(eq(schema.jobs.id, b.id));
    });
    const page = await sync(client, { cursor: start.next_cursor, limit: 2 });
    expect(page.items.map(jobNumber)).toEqual([a.id, b.id]);
    expect(page.items[0]?.job?.job.title).toBe("Second change");
    expect(page.has_more).toBe(false);
    expect((await sync(client, { cursor: page.next_cursor })).items).toEqual([]);
  });

  it("resumes a company rename across one-item pages, including archived and tracked jobs", async () => {
    const a = await addJob(writer.db, "Tracked");
    const b = await addJob(writer.db, "In the archive", { status: "closed" });
    const c = await addJob(writer.db, "Another posting");
    await writer.db.insert(schema.applications).values({ jobId: a.id, status: "applied" });
    await writer.db.insert(schema.jobFavorites).values({ jobId: a.id });
    const client = await connect();
    const start = await sync(client);
    await writer.db.update(schema.companies).set({ name: "Renamed Systems" }).where(eq(schema.companies.id, company.id));
    let cursor = start.next_cursor;
    const items = [];
    for (const [index, id] of [a.id, b.id, c.id].entries()) {
      const page = await sync(client, { limit: 1, cursor });
      expect(page.items.map(jobNumber)).toEqual([id]);
      expect(page.items[0]?.job?.job.company).toBe("Renamed Systems");
      expect(page.has_more).toBe(index < 2);
      items.push(...page.items);
      cursor = page.next_cursor;
    }
    expect(new Set(items.map(({ changed_at }) => changed_at)).size).toBe(1);
    expect((await sync(client, { cursor })).items).toEqual([]);
  });

  it("returns closure changes and a tombstone when a job and its application history are removed", async () => {
    const job = await addJob(writer.db, "Closing role");
    const [application] = await writer.db.insert(schema.applications).values({ jobId: job.id, status: "applied" }).returning();
    await writer.db.insert(schema.applicationEvents).values({ applicationId: application!.id, toStatus: "applied" });
    await writer.db.insert(schema.jobFavorites).values({ jobId: job.id });
    const client = await connect(["jobs:read", "tracking:read"]);
    const start = await sync(client);
    await setClosureOverride(writer.db, job.id, "closed", null, now);
    const closed = await sync(client, { cursor: start.next_cursor });
    expect(closed.items).toMatchObject([{ job_id: job.id, removed: false, job: { job: { status: "closed" } } }]);
    expect(await revertApplicationStatus(writer.db, job.id, { movedTo: "applied", restoreTo: "new" })).toEqual({
      status: null, reverted: true, changed: true,
    });
    expect(await writer.db.select().from(schema.applicationEvents).where(eq(schema.applicationEvents.applicationId, application!.id))).toEqual([]);
    await writer.db.delete(schema.jobs).where(eq(schema.jobs.id, job.id));
    const removed = await sync(client, { cursor: closed.next_cursor });
    expect(removed.items).toEqual([{ job_id: job.id, removed: true, changed_at: expect.any(String), job: null }]);
  });

  it("observes an unseen mark and cleared closure and filter overrides through tracking", async () => {
    const job = await addJob(writer.db, "Tracking changes");
    await markSeen(writer.db, job.id, "detail", now);
    await setClosureOverride(writer.db, job.id, "closed", null, now);
    await setFilterOverride(writer.db, job.id, "exclude");
    const client = await connect(["jobs:read", "tracking:read"]);
    const start = await sync(client, { blocks: ["tracking"] });
    await markUnseen(writer.db, job.id);
    await clearClosureOverride(writer.db, job.id);
    await clearFilterOverride(writer.db, job.id);
    const page = await sync(client, { cursor: start.next_cursor, blocks: ["tracking"] });
    expect(page.items).toMatchObject([{ job_id: job.id, job: { tracking: { seen: false, closure: { override: null }, filter_override: null } } }]);
  });

  it.each(["fingerprint", "membership"] as const)("detects changes to raw posting %s on dormant jobs and withholds their stale JDs", async (reason) => {
    const a = await addJob(writer.db, "Dormant", { status: "possibly_closed", dormantAt: afterHold });
    const b = await addJob(writer.db, "Active");
    const raw = await addSources([a.id, b.id]);
    await recordCurrentTraps([a.id, b.id]);
    const client = await connect();
    const start = await sync(client, { blocks: ["lifecycle"] });
    expect(start.items.map(({ job }) => job?.job.description.text)).toEqual([description, description]);
    if (reason === "fingerprint") {
      await writer.db.update(schema.rawPostings).set({ payloadFingerprint: "new fixture fingerprint" }).where(eq(schema.rawPostings.id, raw.id));
    } else {
      const [alternate] = await writer.db.insert(schema.rawPostings).values({
        channelId: raw.channelId, externalId: "another source", payloadJson: { description },
      }).returning();
      await writer.db.update(schema.jobSources).set({ rawPostingId: alternate!.id }).where(eq(schema.jobSources.jobId, a.id));
    }
    const page = await sync(client, { cursor: start.next_cursor, blocks: ["lifecycle"] });
    expect(page.items.map(jobNumber)).toEqual(reason === "fingerprint" ? [a.id, b.id] : [a.id]);
    expect(page.items[0]?.job?.lifecycle?.dormant).toBe(true);
    for (const { job } of page.items) expect(job?.job.description).toMatchObject({ available: false, text: null, reason: "not_scanned" });
  });

  it("counts held and consumed rows only for the selected, permitted blocks", async () => {
    const job = await addJob(writer.db, "Visible facts");
    await writer.db.insert(schema.applications).values({ jobId: job.id });
    await writer.db.insert(schema.scores).values({ jobId: job.id, filterResult: "filtered_out", filterReasons: ["initial"] });
    const plain = await connect();
    const matched = await connect(["jobs:read", "match:read"]);
    const base = await sync(plain);
    const withMatch = await sync(matched);
    await writer.db.update(schema.jobs).set({ title: "Changed facts" }).where(eq(schema.jobs.id, job.id));
    await writer.db.update(schema.agentChanges).set({ at: beforeHold });
    const oldest = holdWriter((tx) => tx.execute(sql`select pg_current_xact_id()`));
    let plainPage, matchPage;
    try {
      await oldest.ready;
      await second.db.update(schema.applications).set({ notesMd: "Private note fixture" }).where(eq(schema.applications.jobId, job.id));
      await second.db.update(schema.scores).set({ filterReasons: ["Match reason fixture"] }).where(eq(schema.scores.jobId, job.id));
      await second.db.update(schema.agentChanges).set({ at: afterHold }).where(sql`${schema.agentChanges.at} <> ${beforeHold.toISOString()}::timestamptz`);
      plainPage = await sync(plain, { cursor: base.next_cursor });
      matchPage = await sync(matched, { cursor: withMatch.next_cursor });
      expect(plainPage).toMatchObject({ has_more: false, held_back: 0, items: [{ changed_at: beforeHold.toISOString() }] });
      expect(matchPage).toMatchObject({ has_more: false, held_back: 1, items: [{ changed_at: beforeHold.toISOString() }] });
      expect(JSON.stringify(plainPage)).not.toContain("Match reason fixture");
      expect(JSON.stringify(matchPage)).not.toContain("Private note fixture");
    } finally {
      await oldest.finish();
    }
    expect(await sync(plain, { cursor: plainPage.next_cursor })).toMatchObject({ items: [], has_more: false, held_back: 0 });
    expect(await sync(matched, { cursor: matchPage.next_cursor })).toMatchObject({
      has_more: false, held_back: 0, items: [{ changed_at: afterHold.toISOString(), job: { match: { filter: { reasons: ["Match reason fixture"] } } } }],
    });
    await syncError(plain, { blocks: ["match"] }, "Input validation error:", "match:read");
    const noJobs = await connect(["tracking:read"]);
    expect((await noJobs.listTools()).tools.map(({ name }) => name)).not.toContain("list_job_changes");
  });

  it("expands cached salary and benchmark keys to the appropriate current candidates", async () => {
    const currency = useTestSalaryFamilies();
    const city = { city: "Example City", countryCode: "GB", label: "Example City", isPrimary: true };
    const location = { locationsJson: [city], seniority: "senior" };
    const first = await addJob(writer.db, "Systems Engineer", location);
    const sibling = await addJob(writer.db, "Systems Engineer", location);
    const otherCity = await addJob(writer.db, "Systems Engineer", { ...location, locationsJson: [{ ...city, city: "Another City" }] });
    const otherFamily = await addJob(writer.db, "Support Specialist", location);
    const { stored, result } = await addSalaryLookup(first, currency, city);
    await recordCurrentTraps([first.id, sibling.id, otherCity.id, otherFamily.id]);
    const client = await connect();
    const salary = { blocks: ["salary"] };
    const start = await sync(client, salary);
    const plain = await sync(client, { blocks: [] });
    await writer.db.update(schema.salaryLookups).set({ resultJson: { ...result, notes: "Updated lookup" } }).where(eq(schema.salaryLookups.id, stored.id));
    const lookupPage = await sync(client, { ...salary, cursor: start.next_cursor });
    expect(lookupPage.items.map(jobNumber)).toEqual([first.id, sibling.id]);
    for (const item of lookupPage.items) expect(item.job?.salary?.lookup).toMatchObject({ notes: "Updated lookup", expires_at: expires.toISOString() });

    const [group] = await writer.db.insert(schema.salaryBenchmarks).values({
      roleFamily: "systems", seniority: "senior", geoLevel: "city", geoKey: "example city", currency, n: 4, median: 80000, quantiles: [70000, 80000, 90000],
    }).returning();
    const benchmarkPage = await sync(client, { ...salary, cursor: lookupPage.next_cursor });
    expect(benchmarkPage.items.map(jobNumber)).toEqual([first.id, sibling.id]);
    expect(benchmarkPage.items[0]?.job?.salary?.benchmark).toMatchObject({ level: "city", median: 80000 });
    expect(await sync(client, { blocks: [], cursor: plain.next_cursor })).toMatchObject({ items: [], has_more: false, held_back: 0 });

    await writer.db.update(schema.salaryBenchmarks).set({ nAi: 1 }).where(eq(schema.salaryBenchmarks.id, group!.id));
    expect((await sync(client, { ...salary, cursor: benchmarkPage.next_cursor })).items.map(jobNumber))
      .toEqual([first.id, sibling.id, otherCity.id, otherFamily.id]);
  });

  it("includes hard-filtered jobs and matches every requested get_job field except the clock fields", async () => {
    const currency = useTestSalaryFamilies();
    const job = await addJob(writer.db, "Systems Engineer");
    await addSources([job.id]);
    await recordCurrentTraps([job.id]);
    await addSalaryLookup(job, currency, null);
    await writer.db.insert(schema.companyResearch).values({
      companyId: company.id, jobId: job.id, status: "ok", promptVersion: 1, fetchedAt: now, expiresAt: expires,
      resultJson: { fields: { summary: { text: "Example company", sourceUrl: "https://about.example.invalid" } }, dropped: 0 },
    });
    await writer.db.insert(schema.translations).values({ jobId: job.id, lang: "zh", content: "岗位说明", sourceHash: descriptionHash(description), createdAt: now });
    await writer.db.insert(schema.jobBreakdowns).values({
      jobId: job.id, sourceHash: descriptionHash(description), content: blockBreakdown(description, 0),
      promptVersion: BREAKDOWN_PROMPT_VERSION, analyzedAt: now, outputLang: "en",
    });
    await writer.db.insert(schema.scores).values({ jobId: job.id, filterResult: "filtered_out", filterReasons: ["Fixture hard filter"], rankValue: 55 });
    const [application] = await writer.db.insert(schema.applications).values({ jobId: job.id, status: "applied", notesMd: "Call the team" }).returning();
    await writer.db.insert(schema.applicationEvents).values({
      applicationId: application!.id, toStatus: "applied", occurredAt: now, reference: "fixture receipt", at: beforeHold,
    });
    const caller = await connect(["jobs:read", "match:read", "tracking:read"]);
    const args = { blocks: ["match", "tracking"] };
    const start = await sync(caller, args);
    expect(start.items).toMatchObject([{
      job_id: job.id, removed: false, changed_at: null, job: {
        job: {
          id: job.id, title: job.title, company: company.name, status: "active", first_seen_at: now.toISOString(),
          rank: { rank_value: 55 }, links: [{ apply_url: "https://jobs.example.invalid/apply" }], application_status: "applied",
        },
        match: { filter: { result: "filtered_out", reasons: ["Fixture hard filter"] } },
        tracking: { application: { applied_at: now.toISOString(), history: [{ reference: "fixture receipt" }] } },
      },
    }]);
    const [unfilteredOutput] = (await sync(caller, { blocks: [] })).items;
    expect(unfilteredOutput?.job?.job).not.toHaveProperty("application_status");
    expect(unfilteredOutput?.job?.tracking).toBeUndefined();
    await writer.db.update(schema.scores).set({ filterReasons: ["Updated hard filter"] }).where(eq(schema.scores.jobId, job.id));
    const change = await sync(caller, { cursor: start.next_cursor, blocks: ["tracking", "match", "job", "match"] });
    expect(change.items).toMatchObject([{ job_id: job.id, job: { match: { filter: { result: "filtered_out", reasons: ["Updated hard filter"] } } } }]);

    const all = await connect(["jobs:read", "match:read", "tracking:read", "notes:read"]);
    const include = ["translation", "breakdown", "salary", "company", "ghost", "lifecycle"];
    const single = await all.callTool({ name: "get_job", arguments: { job_id: job.id, include } });
    expect(single.isError, JSON.stringify(single.content)).not.toBe(true);
    const { notices, salary, company: background, ...fields } = getJobOutput.parse(single.structuredContent);
    expect(background).toMatchObject({ available: true, expired: false });
    expect(salary?.lookup).toMatchObject({ available: true, expired: false });
    const { expired: companyExpired, ...companyFields } = background!;
    const { company_figures, lookup, ...salaryFields } = salary!;
    const { expired: salaryExpired, ...lookupFields } = lookup!;
    expect(companyExpired).toBe(false);
    expect(salaryExpired).toBe(false);
    expect(company_figures).toMatchObject({ count: 0 });
    const snapshot = await sync(all, { blocks: [...include, "match", "tracking", "notes"] });
    expect(snapshot.notices).toEqual(notices);
    expect(snapshot.items[0]?.job).toEqual({
      ...fields, company: { ...companyFields, expires_at: expires.toISOString() },
      salary: { ...salaryFields, lookup: { ...lookupFields, expires_at: expires.toISOString() } },
    });
  });
});

describe("job sync snapshots and cursors", () => {
  it("replays writes during a paged snapshot including a late commit with a lower key, across two server instances", async () => {
    const client = await connect();
    const held = holdWriter((tx) => addJob(tx, "Lower key, late commit"));
    let low, high, tail, initial;
    try {
      low = await held.ready;
      high = await addJob(second.db, "First visible");
      tail = await addJob(second.db, "Last visible", { status: "closed" });
      initial = await sync(client, { limit: 1, cursor: null });
      expect(initial).toMatchObject({ phase: "snapshot", has_more: true, snapshot_complete: false, held_back: null });
      expect(initial.items.map(jobNumber)).toEqual([high.id]);
    } finally {
      await held.finish();
    }
    await client.close();
    const otherPool = createReadOnlyDb({ url });
    closers.push(otherPool.close);
    const restarted = await connect(["jobs:read"], { db: otherPool, startup: true });
    await writer.db.update(schema.jobs).set({ title: "Changed during snapshot" }).where(eq(schema.jobs.id, high.id));
    const final = await sync(restarted, { limit: 1, cursor: initial.next_cursor });
    expect(final).toMatchObject({ phase: "snapshot", has_more: false, snapshot_complete: true, held_back: null, generation: initial.generation });
    expect(final.items.map(jobNumber)).toEqual([tail.id]);
    const changes = await sync(restarted, { cursor: final.next_cursor });
    expect(changes).toMatchObject({ phase: "changes", snapshot_complete: false, generation: initial.generation, held_back: 0 });
    expect(changes.items.map(jobNumber)).toEqual([low.id, high.id, tail.id]);
    expect(changes.items[1]?.job?.job.title).toBe("Changed during snapshot");
  });

  it("starts an empty snapshot and returns fresh cursors on empty polls in read-only repeatable-read transactions", async () => {
    const client = await connect();
    const states: Array<{ read_only: string; isolation: string; assigned: boolean }> = [];
    const transact = reader.db.transaction.bind(reader.db);
    vi.spyOn(reader.db, "transaction").mockImplementation((work, options) => transact(async (tx) => {
      const [state] = await tx.execute<(typeof states)[number]>(sql`
        select current_setting('transaction_read_only') as read_only,
          current_setting('transaction_isolation') as isolation, pg_current_xact_id_if_assigned() is not null as assigned
      `);
      states.push(state!);
      return work(tx);
    }, options));
    const start = await sync(client);
    expect(start).toMatchObject({ items: [], phase: "snapshot", snapshot_complete: true, has_more: false, held_back: null });
    const first = await sync(client, { cursor: start.next_cursor });
    const second = await sync(client, { cursor: first.next_cursor });
    expect(first).toMatchObject({ phase: "changes", items: [], held_back: 0, has_more: false, generation: start.generation });
    expect(second).toMatchObject({ phase: "changes", items: [], held_back: 0, has_more: false, generation: start.generation });
    expect(new Set([start.next_cursor, first.next_cursor, second.next_cursor]).size).toBe(3);
    expect(states).toEqual(Array.from({ length: 3 }, () => ({ read_only: "on", isolation: "repeatable read", assigned: false })));
    expect(await writer.db.select({ seq: schema.agentChanges.seq }).from(schema.agentChanges)).toEqual([]);
  });

  it("reconciles stale entities by generation once a fresh snapshot finishes and its tombstones were pruned", async () => {
    const kept = await addJob(writer.db, "Kept");
    const gone = await addJob(writer.db, "Deleted");
    const client = await connect();
    const start = await sync(client);
    const copy = new Map(start.items.map((item) => [item.job_id, start.generation]));
    await writer.db.delete(schema.jobs).where(eq(schema.jobs.id, gone.id));
    await writer.db.update(schema.agentChanges).set({ at: sql`now() - interval '40 days'` });
    expect(await pruneAgentChanges(writer.db, 30)).toBeGreaterThan(0);
    await syncError(client, { cursor: start.next_cursor }, "resync_required", "pruned");

    const fresh = await sync(client);
    expect(fresh.generation).not.toBe(start.generation);
    expect(fresh.snapshot_complete).toBe(true);
    for (const { job_id } of fresh.items) copy.set(job_id, fresh.generation);
    for (const [id, generation] of copy) if (generation !== fresh.generation) copy.delete(id);
    expect([...copy.keys()]).toEqual([kept.id]);
    expect((await sync(client, { cursor: fresh.next_cursor })).items).toEqual([]);
  });

  it("rejects pruning past a snapshot start or the active shared row", async () => {
    await addJob(writer.db, "First");
    await addJob(writer.db, "Second");
    const client = await connect();
    const first = await sync(client, { limit: 1 });
    const start = await sync(client);
    await writer.db.update(schema.companies).set({ name: "New name" }).where(eq(schema.companies.id, company.id));
    const partial = await sync(client, { limit: 1, cursor: start.next_cursor });
    expect(partial.has_more).toBe(true);
    await writer.db.update(schema.agentChanges).set({ at: sql`now() - interval '40 days'` });
    await pruneAgentChanges(writer.db, 30);
    await syncError(client, { cursor: first.next_cursor }, "resync_required", "pruned");
    await syncError(client, { cursor: partial.next_cursor }, "resync_required", "pruned");
  });

  it("has recognizable errors for authentication, changed blocks or permissions, DTO version, and key rotation", async () => {
    await addJob(writer.db, "Example");
    const permissions: Permission[] = ["jobs:read", "match:read"];
    const client = await connect(permissions);
    const start = await sync(client, { blocks: ["match", "translation"] });
    const cursor = start.next_cursor;
    const bytes = Buffer.from(cursor, "base64url");
    bytes[30] ^= 1;
    await syncError(client, { cursor: bytes.toString("base64url"), blocks: ["match", "translation"] }, "invalid_cursor");
    await syncError(client, { cursor: 123 }, "invalid_cursor");
    await syncError(client, { cursor, blocks: ["match", "salary"] }, "resync_required", "scope_changed");
    const narrow = await connect();
    await syncError(narrow, { cursor, blocks: ["match", "translation"] }, "resync_required", "scope_changed");

    const [key] = await writer.db.select({ keyId: schema.agentChangeLog.keyId, cursorKey: schema.agentChangeLog.cursorKey }).from(schema.agentChangeLog);
    const scope: CursorScope = { tool: "list_job_changes", blocks: ["job", "match", "translation"], permissions: ["jobs:read", "match:read"], dtoVersion: SYNC_DTO_VERSION };
    const parsed = decodeSyncCursor(cursor, key!, scope);
    const oldDto = encodeSyncCursor(key!, { ...parsed, dtoVersion: SYNC_DTO_VERSION + 1 });
    await syncError(client, { cursor: oldDto, blocks: ["match", "translation"] }, "resync_required", "scope_changed");
    const otherTool = encodeSyncCursor(key!, { ...parsed, tool: "list_application_changes" });
    await syncError(client, { cursor: otherTool, blocks: ["match", "translation"] }, "resync_required", "scope_changed");
    await resetAgentChanges(writer.db);
    const zh = await connect(permissions, { locale: "zh" });
    await syncError(zh, { cursor, blocks: ["match", "translation"] }, "resync_required", "log_reset");
    await syncError(zh, { cursor: "invalid" }, "invalid_cursor");
    expect(await sync(zh)).toMatchObject({ phase: "snapshot", snapshot_complete: true });
  });

  it("checks the identity on startup and each call, with no reset from the MCP side", async () => {
    const initial = await connect();
    const start = await sync(initial);
    await writer.db.update(schema.agentChangeLog).set({ databaseOid: 0 });
    const lines: string[] = [];
    const broken = await connect(["jobs:read"], { startup: true, lines });
    expect(lines).toContain(mcpTranslator("en")("sync.errors.unavailable"));
    await syncError(broken, {}, "sync_unavailable");
    await syncError(initial, { cursor: start.next_cursor }, "sync_unavailable");
    const [identity] = await writer.db.select({ databaseOid: schema.agentChangeLog.databaseOid }).from(schema.agentChangeLog);
    expect(identity?.databaseOid).toBe(0);
    await resetAgentChanges(writer.db);
    await syncError(broken, { cursor: start.next_cursor }, "resync_required", "log_reset");
    expect(await sync(broken)).toMatchObject({ phase: "snapshot", snapshot_complete: true });
    await writer.db.delete(schema.agentChangeLog);
    await syncError(broken, {}, "sync_unavailable");
  });

  it("advertises and enforces the configured maximum and its default", async () => {
    const a = await addJob(writer.db, "First");
    const b = await addJob(writer.db, "Second");
    const client = await connect(["jobs:read"], { max: 1 });
    const listed = (await client.listTools()).tools.find(({ name }) => name === "list_job_changes");
    expect(listed?.inputSchema.properties).toMatchObject({ limit: { default: 1, maximum: 1, minimum: 1, type: "integer" } });
    await syncError(client, { limit: 2 }, "Input validation error:", "limit");
    await syncError(client, { limit: 0 }, "Input validation error:", "limit");
    const start = await sync(client);
    expect(start.items.map(jobNumber)).toEqual([a.id]);
    expect(start.has_more).toBe(true);
    expect((await sync(client, { cursor: start.next_cursor })).items.map(jobNumber)).toEqual([b.id]);
  });
});
