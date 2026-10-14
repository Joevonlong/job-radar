import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { createFixtureChannel, registerFixtureChannel, type FixturePosting } from "@/lib/channels/fixture";
import type { FetchLike } from "@/lib/channels/http";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { Channel, NormalizedPostingDraft } from "@/lib/channels/types";
import { getAppRoot } from "@/lib/config";
import { registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { runCycle, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { listJobSources, listRawPostingsForChannel, upsertRawPostings } from "@/lib/db";
import { listJobsForLinkCheck, resetRuleDerivedFacts, touchJobsSeen } from "@/lib/db/repos/jobs";
import { requeueRawPostings } from "@/lib/db/repos/raw-postings";
import { upsertChannelRows } from "@/lib/db/repos/channels";
import { createHttpClient } from "@/lib/channels/http";
import { buildSalary } from "@/lib/pipeline/salary";
import { refreshStoredSalaries, runMaintenance, runPipeline, salaryFingerprint, type MaintenanceResult, type PipelineResult } from "@/lib/pipeline";
import { SALARY_FINGERPRINT_KEY } from "@/lib/pipeline/refresh-salary";
import { hammingDistance, simhash } from "@/lib/pipeline/simhash";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { createLogger } from "@/lib/channels/logger";
import { config, quietLogger } from "../cycle/helpers";
import { pipelineWith, shippedPipeline } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
const DAY = 86_400_000;

const FIXTURES = path.join(getAppRoot(), "tests", "fixtures", "pipeline");

/** The three fake channels of the cross-source scenario: a company ATS, LinkedIn and StepStone. */
function threeChannels(): ChannelRegistry {
  const registry = new ChannelRegistry();
  registerFixtureChannel(registry, { id: "fx-ats", family: "ats", kind: "ats", usesQueries: false, dir: FIXTURES, files: ["ats.json"] });
  registerFixtureChannel(registry, { id: "fx-linkedin", family: "linkedin", kind: "guest", usesQueries: false, dir: FIXTURES, files: ["linkedin.json"] });
  registerFixtureChannel(registry, { id: "fx-stepstone", family: "stepstone", kind: "browser", usesQueries: false, dir: FIXTURES, files: ["stepstone.json"] });
  return registry;
}

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

/** Answers every request with `status(url)`. */
function fakeFetch(status: (url: string) => number): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (requestUrl, init) => {
    calls.push(`${init.method ?? "GET"} ${requestUrl}`);
    const code = status(requestUrl);
    return { status: code, ok: code < 400, headers: { get: () => null }, text: async () => "", json: async () => ({}) };
  };
  return { fetch, calls };
}

function run(registry: ChannelRegistry, options: RunCycleOptions = {}) {
  return runCycle("manual", { registry, config: config(), logger: quietLogger, sleep: async () => {}, ...options });
}

const pipelineOf = (result: Awaited<ReturnType<typeof run>>) => result.results.pipeline as PipelineResult;
const maintenanceOf = (result: Awaited<ReturnType<typeof run>>) => result.results.maintenance as MaintenanceResult;

const allJobs = () => getDb().select().from(schema.jobs).orderBy(schema.jobs.id);
const jobTitled = async (titleNorm: string) => {
  const job = (await allJobs()).find((j) => j.titleNorm === titleNorm);
  if (!job) throw new Error(`no job "${titleNorm}"`);
  return job;
};

async function insertRun(channelId: string, startedAt: Date, status: "succeeded" | "failed" = "succeeded"): Promise<void> {
  await getDb().insert(schema.runs).values({ channelId, status, startedAt, finishedAt: startedAt });
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

const resetTables = () => getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels restart identity cascade`);

let temp: TempConfig;

beforeEach(async () => {
  // the `filter` step reads the profile files: keep them out of the app's own data/profile
  temp = makeTempConfig();
  await resetTables();
  registerBuiltinCycleSteps();
});

afterEach(() => {
  resetCycleSteps();
  temp.cleanup();
});

afterAll(async () => {
  // other integration files expect empty tables
  await resetTables();
  await closeDb();
});

describe("migration 0002", () => {
  it("adds the pipeline columns", async () => {
    const rows = await getDb().execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'raw_postings' and column_name = 'parse_error')
        or (table_name = 'jobs' and column_name in ('is_agency', 'skills', 'link_checked_at'))
        or (table_name = 'job_sources' and column_name = 'apply_url'))
      order by table_name, column_name`);
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "job_sources.apply_url",
      "jobs.is_agency",
      "jobs.link_checked_at",
      "jobs.skills",
      "raw_postings.parse_error",
    ]);
  });
});

describe("salary refresh", () => {
  /** A salary as an older parser could have stored it: a benefit number read as a salary. */
  const stale = () => buildSalary({ raw: "Relocation support: up to €2,500", currency: "EUR", period: null, min: 2500, max: 4, periodAssumed: false, origin: "description" }, shippedPipeline());
  const refresh = (force = false) => refreshStoredSalaries(getDb(), { config: shippedPipeline(), registry: threeChannels(), logger: quietLogger, ...(force ? { force: true } : {}) });

  it("re-reads the raw postings once per salary parsing and corrects what is stored, also to 'none'", async () => {
    await run(threeChannels());
    const northwind = await jobTitled("applied ai engineer");
    const dataEngineer = await jobTitled("data engineer");
    expect(northwind.salaryJson).toMatchObject({ min: 85000, max: 105000 });
    expect(dataEngineer.salaryJson).toBeNull();
    const [state] = await getDb().select().from(schema.runtimeState).where(eq(schema.runtimeState.key, SALARY_FINGERPRINT_KEY));
    expect(state?.value).toBe(salaryFingerprint(shippedPipeline())); // the cycle's pipeline step already refreshed once

    await getDb().update(schema.jobs).set({ salaryJson: stale() }).where(eq(schema.jobs.id, northwind.id));
    await getDb().update(schema.jobs).set({ salaryJson: stale() }).where(eq(schema.jobs.id, dataEngineer.id));
    expect(await refresh()).toBeNull(); // same parsing as the stored salaries: nothing to do
    expect((await jobTitled("data engineer")).salaryJson).toMatchObject({ min: 2500 });

    await getDb().delete(schema.runtimeState).where(eq(schema.runtimeState.key, SALARY_FINGERPRINT_KEY)); // = the parsing changed
    expect(await refresh()).toMatchObject({ jobs: 3, changed: 2, cleared: 1, unreadable: 0, aborted: false });
    expect((await jobTitled("applied ai engineer")).salaryJson).toMatchObject({ origin: "description", min: 85000, max: 105000, qualityStatus: "valid" });
    expect((await jobTitled("data engineer")).salaryJson).toBeNull();
    expect(await refresh()).toBeNull();
    expect(await refresh(true)).toMatchObject({ changed: 0 }); // forced: runs, finds nothing to change
  });

  it("leaves a job alone whose raw postings cannot be read any more", async () => {
    await run(threeChannels());
    const northwind = await jobTitled("applied ai engineer");
    await getDb().update(schema.jobs).set({ salaryJson: stale() }).where(eq(schema.jobs.id, northwind.id));
    const none = await refreshStoredSalaries(getDb(), { config: shippedPipeline(), registry: new ChannelRegistry(), logger: quietLogger, force: true });
    expect(none).toMatchObject({ changed: 0, unreadable: 3 });
    expect((await jobTitled("applied ai engineer")).salaryJson).toMatchObject({ min: 2500 });
  });
});

describe("cross-source pipeline", () => {
  it("turns the same job seen by an ATS, LinkedIn and StepStone into one job with three sources, apply link at the ATS", async () => {
    const result = await run(threeChannels());
    expect(result.status).toBe("succeeded");

    const pipeline = pipelineOf(result);
    expect(pipeline).toMatchObject({ processed: 6, parsed: 6, created: 3, updated: 0, parseFailed: 0, deferred: 0, aborted: false });
    expect(pipeline.merged.same_source + pipeline.merged.exact_key + pipeline.merged.simhash).toBe(3);
    expect(pipeline.merged.simhash).toBeGreaterThanOrEqual(1); // the Contoso posting has different titles on ATS and LinkedIn

    const jobs = await allJobs();
    expect(jobs).toHaveLength(3);
    expect((await getDb().select().from(schema.companies)).map((c) => c.nameNorm).sort()).toEqual(["contoso-ai", "northwind-labs"]);
    const raws = await getDb().select().from(schema.rawPostings);
    expect(raws).toHaveLength(6);
    expect(raws.every((r) => r.parseStatus === "parsed" && r.parseError === null)).toBe(true);

    const northwind = await jobTitled("applied ai engineer");
    const sources = await listJobSources(getDb(), northwind.id);
    expect(sources.map((s) => [s.channelId, s.priority])).toEqual([
      ["fx-ats", 1],
      ["fx-linkedin", 2],
      ["fx-stepstone", 3],
    ]);
    expect(sources[0]?.url).toBe("https://jobs.example.test/northwind/1001");
    // the ATS posting is the best source, so its fields win
    expect(northwind).toMatchObject({
      title: "Applied AI Engineer (m/w/d)",
      germanLevelRequired: "preferred", // "Fließende Deutschkenntnisse sind von Vorteil"
      contract: "permanent",
      language: "en",
      workplace: "hybrid", // the source states none; the description says "hybrid with three days in the office"
    });
    expect(northwind.salaryJson).toMatchObject({ origin: "description", eurPerYear: { min: 85000, max: 105000 }, qualityStatus: "valid" });
    expect(northwind.locationsJson).toEqual([{ label: "Berlin", city: "Berlin", countryCode: "DE", isPrimary: true }]);
    expect(northwind.skills).toEqual(expect.arrayContaining(["Python", "PyTorch", "Kubernetes"]));
    expect(northwind.simhash).toMatch(/^[0-9a-f]{16}$/);

    const contoso = await jobTitled("forward deployed engineer");
    expect((await listJobSources(getDb(), contoso.id)).map((s) => s.channelId)).toEqual(["fx-ats", "fx-linkedin"]);
    expect(contoso).toMatchObject({ germanLevelRequired: "C1", title: "Forward Deployed Engineer" });
    expect(contoso.locationsJson).toEqual([{ label: "München", city: "München", countryCode: "DE", isPrimary: true }]);

    // the other Northwind job is not folded into the first one
    const dataEngineer = await jobTitled("data engineer");
    expect(dataEngineer.id).not.toBe(northwind.id);
    expect(await listJobSources(getDb(), dataEngineer.id)).toHaveLength(1);
  });

  it("only refreshes last_seen when the same jobs show up in the next cycle", async () => {
    const registry = threeChannels();
    await run(registry);
    const before = await allJobs();
    const sourcesBefore = await getDb().select().from(schema.jobSources);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await run(registry);
    expect(pipelineOf(second)).toMatchObject({ processed: 0, parsed: 0, created: 0, updated: 0 });
    expect(maintenanceOf(second)).toMatchObject({ seen: 3, reopened: 0, possiblyClosed: 0 });

    const after = await allJobs();
    expect(after.map((j) => j.id)).toEqual(before.map((j) => j.id));
    expect(await getDb().select().from(schema.jobSources)).toHaveLength(sourcesBefore.length);
    for (const [index, job] of after.entries()) {
      const old = before[index];
      expect(job.firstSeenAt).toEqual(old?.firstSeenAt);
      expect(job.lastSeenAt.getTime()).toBeGreaterThan(old?.lastSeenAt.getTime() ?? 0);
      expect(job.status).toBe("active");
      expect(job.title).toBe(old?.title);
    }
  });

  it("records the pipeline and maintenance results in the cycle summary", async () => {
    const result = await run(threeChannels());
    const summary = (await getDb().select().from(schema.cycles).where(eq(schema.cycles.id, result.cycleId as number)))[0]?.summaryJson as {
      steps: Array<{ name: string; status: string; result?: unknown }>;
    };
    expect(summary.steps.find((s) => s.name === "pipeline")).toMatchObject({ status: "ok", result: { created: 3 } });
    expect(summary.steps.find((s) => s.name === "maintenance")).toMatchObject({ status: "ok", result: { possiblyClosed: 0 } });
  });

  it("merges the same posting delivered by two channels of one family (same source)", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-li-1", family: "linkedin", usesQueries: false, postings: [posting("99", { title: "AI Engineer" })] });
    registerFixtureChannel(registry, { id: "fx-li-2", family: "linkedin", usesQueries: false, postings: [posting("99", { title: "AI Engineer (Remote)", city: null })] });
    const pipeline = pipelineOf(await run(registry));
    expect(pipeline).toMatchObject({ created: 1 });
    expect(pipeline.merged.same_source).toBe(1);
    const [job] = await allJobs();
    expect(await listJobSources(getDb(), job?.id as number)).toHaveLength(2);
  });

  it("does not merge the same external id across different families", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-a", family: "linkedin", usesQueries: false, postings: [posting("99", { company: "Alpha GmbH" })] });
    registerFixtureChannel(registry, { id: "fx-b", family: "indeed", usesQueries: false, postings: [posting("99", { company: "Beta GmbH", title: "Other role" })] });
    expect(pipelineOf(await run(registry))).toMatchObject({ created: 2 });
    expect(await allJobs()).toHaveLength(2);
  });

  it("resolves company aliases and legal forms to one company", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, {
      id: "fx-a",
      family: "ats",
      usesQueries: false,
      postings: [posting("1", { company: "Alphabet Inc.", title: "ML Engineer" })],
    });
    registerFixtureChannel(registry, {
      id: "fx-b",
      family: "linkedin",
      usesQueries: false,
      postings: [posting("2", { company: "Google Germany GmbH", title: "ML Engineer (m/w/d)" })],
    });
    const pipeline = pipelineOf(await run(registry));
    expect(pipeline).toMatchObject({ created: 1 });
    const companies = await getDb().select().from(schema.companies);
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({ name: "Google", nameNorm: "google" });
    expect(companies[0]?.aliases).toEqual(["Alphabet", "Google Germany", "Google Deutschland"]);
  });

  it("keeps postings of the same company with different titles apart", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, {
      id: "fx-a",
      family: "ats",
      usesQueries: false,
      postings: [
        posting("1", { title: "ML Engineer", description: "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega again and again until thirty words are reached here" }),
        posting("2", { title: "Sales Manager", description: "Completely different words about selling products to retail customers across Europe with a focus on long term relationships negotiation pricing forecasts and reporting duties daily" }),
        posting("3", { title: "ML Engineer", city: "München" }),
      ],
    });
    expect(pipelineOf(await run(registry))).toMatchObject({ created: 3 });
  });

  it("merges near-duplicate descriptions of the same company only within the configured Hamming distance", async () => {
    const base =
      "We are looking for a machine learning engineer to build and operate recommendation systems for millions of users. You will work with Python, PyTorch and Kubernetes, collaborate with product and data teams, review code, mentor colleagues and take part in the on-call rotation. Our team values ownership, clear communication and pragmatic engineering. We offer flexible hours, a learning budget and a modern office in the city center with free drinks and fruit.";
    const variant = `${base} Apply with your CV.`;
    const options = { shingleWords: 3, minWords: 30 };
    const distance = hammingDistance(simhash(base, options) as string, simhash(variant, options) as string);
    expect(distance).toBeGreaterThan(0);

    const collect = async () => {
      const registry = new ChannelRegistry();
      registerFixtureChannel(registry, { id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { title: "ML Engineer Recommendations", description: base })] });
      registerFixtureChannel(registry, { id: "fx-b", family: "linkedin", usesQueries: false, postings: [posting("2", { title: "Machine Learning Engineer", description: variant })] });
      resetCycleSteps();
      await run(registry);
      return registry;
    };
    const withDistance = (max: number) => pipelineWith((raw) => ((raw.dedupe as { simhash_max_distance: number }).simhash_max_distance = max));

    let registry = await collect();
    const apart = await runPipeline(getDb(), { config: withDistance(distance - 1), registry, logger: quietLogger });
    expect(apart).toMatchObject({ created: 2 });
    expect(await allJobs()).toHaveLength(2);

    await resetTables();
    registry = await collect();
    const together = await runPipeline(getDb(), { config: withDistance(distance), registry, logger: quietLogger });
    expect(together).toMatchObject({ created: 1 });
    expect(together.merged.simhash).toBe(1);
    const [job] = await allJobs();
    expect(await listJobSources(getDb(), job?.id as number)).toHaveLength(2);
  });

  it("merges one job posted under two spellings of a company name, but not different companies with the same title", async () => {
    const text =
      "We are looking for a machine learning engineer to build and operate recommendation systems for millions of users. You will work with Python, PyTorch and Kubernetes, collaborate with product and data teams, review code, mentor colleagues and take part in the on-call rotation. Our team values ownership, clear communication and pragmatic engineering. We offer flexible hours, a learning budget and a modern office in the city center with free drinks and fruit.";
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-a", family: "arbeitsagentur", usesQueries: false, postings: [posting("1", { company: "SIV.AG - Service für Informationsverarbeitung AG", title: "KI-Entwickler", city: "Roggentin", description: text })] });
    registerFixtureChannel(registry, { id: "fx-b", family: "linkedin", usesQueries: false, postings: [posting("2", { company: "SIV.AG", title: "KI-Entwickler", city: null, description: `${text} Apply now.` })] });
    registerFixtureChannel(registry, { id: "fx-c", family: "stepstone", usesQueries: false, postings: [posting("3", { company: "Fahrmiete", title: "KI-Entwickler", city: null, description: text })] });
    const pipeline = pipelineOf(await run(registry));
    expect(pipeline).toMatchObject({ created: 2 });
    expect(pipeline.merged.simhash).toBe(1);
    // the order the channels were processed in is not fixed: look at every job's sources
    const channelsPerJob = await Promise.all((await allJobs()).map(async (j) => (await listJobSources(getDb(), j.id)).map((s) => s.channelId).sort()));
    expect(channelsPerJob.sort()).toEqual([["fx-a", "fx-b"], ["fx-c"]]);
  });

  it("keeps where each source posting places the job, so postings of one company in several offices can be told apart", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { title: "Staff FDE", city: "Berlin" }), posting("2", { title: "Staff FDE", city: "Berlin", description: "Other" })] });
    await run(registry);
    const [job] = await allJobs();
    const sources = await listJobSources(getDb(), job?.id as number);
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => typeof s.locationLabel === "string" && s.locationLabel.includes("Berlin"))).toBe(true);
  });

  it("does not hash or match short descriptions", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { title: "Role A", description: "Build things" })] });
    registerFixtureChannel(registry, { id: "fx-b", family: "linkedin", usesQueries: false, postings: [posting("2", { title: "Role B", description: "Build things" })] });
    expect(pipelineOf(await run(registry))).toMatchObject({ created: 2 });
    expect((await allJobs()).every((j) => j.simhash === null)).toBe(true);
  });

  it("re-parses a posting whose payload changed and updates the job it belongs to", async () => {
    const first = new ChannelRegistry();
    registerFixtureChannel(first, { id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { description: "Build things" })] });
    await run(first);
    const [created] = await allJobs();

    const changed = new ChannelRegistry();
    registerFixtureChannel(changed, { id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { description: "Build zebra things", title: "Job 1 renamed" })] });
    const result = await run(changed);
    expect(pipelineOf(result)).toMatchObject({ processed: 1, created: 0, updated: 1 });
    const jobs = await allJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: created?.id, title: "Job 1 renamed", description: "Build zebra things" });
    expect(await listJobSources(getDb(), created?.id as number)).toHaveLength(1);
    // search_tsv follows the description
    const hits = await getDb().execute<{ id: string }>(sql`select id from jobs where search_tsv @@ to_tsquery('simple', 'zebra')`);
    expect(hits.map((r) => Number(r.id))).toEqual([created?.id]);
  });
});

describe("a job seen again by the pipeline", () => {
  const phrase = { outcome: "phrase", httpStatus: 200, phrase: "no longer accepting applications", quote: "This job is no longer accepting applications", url: null, at: "2026-10-01T00:00:00Z" };
  const alive = { outcome: "alive", httpStatus: 200, phrase: null, quote: null, url: null, at: "2026-10-01T00:00:00Z" };

  async function firstJob(): Promise<number> {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { description: "Build things" })] });
    await run(registry);
    const [job] = await allJobs();
    return job?.id as number;
  }

  async function mark(id: number, status: "possibly_closed" | "closed", evidence: object | null, lastSeen?: Date): Promise<void> {
    await getDb()
      .update(schema.jobs)
      .set({ status, linkCheckJson: evidence, ...(lastSeen ? { lastSeenAt: lastSeen } : {}) })
      .where(eq(schema.jobs.id, id));
  }

  const statusOf = async (id: number) => (await allJobs()).find((j) => j.id === id)?.status;

  async function changedPayload(): Promise<void> {
    const changed = new ChannelRegistry();
    registerFixtureChannel(changed, { id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { description: "Build zebra things" })] });
    await run(changed);
  }

  async function otherChannel(): Promise<void> {
    const both = new ChannelRegistry();
    registerFixtureChannel(both, { id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { description: "Build things" })] });
    registerFixtureChannel(both, { id: "fx-li", family: "linkedin", usesQueries: false, postings: [posting("li-1", { title: "Job 1", description: "Build things" })] });
    await run(both);
  }

  it("keeps a phrase-marked job possibly closed when its payload changed", async () => {
    const id = await firstJob();
    await mark(id, "possibly_closed", phrase);
    await changedPayload();
    expect(await statusOf(id)).toBe("possibly_closed");
    expect((await allJobs())[0]?.description).toBe("Build zebra things");
  });

  it("keeps a phrase-marked job possibly closed when another channel's posting merges into it", async () => {
    const id = await firstJob();
    const older = new Date(Date.now() - 5 * DAY);
    await mark(id, "possibly_closed", phrase, older);
    await otherChannel();
    expect(await allJobs()).toHaveLength(1);
    expect((await allJobs())[0]?.lastSeenAt.getTime()).toBeGreaterThan(older.getTime());
    expect(await listJobSources(getDb(), id)).toHaveLength(2);
    expect(await statusOf(id)).toBe("possibly_closed");
  });

  it("still reopens a plain possibly closed job and a closed job (changed payload and merge)", async () => {
    const id = await firstJob();
    await mark(id, "possibly_closed", alive);
    await changedPayload();
    expect(await statusOf(id)).toBe("active");

    await mark(id, "closed", { ...alive, outcome: "gone", httpStatus: 404 });
    await otherChannel();
    expect(await statusOf(id)).toBe("active");
  });

  it("gives the pipeline and touchJobsSeen the same status for the same rows", async () => {
    const cases: Array<{ name: string; status: "possibly_closed" | "closed"; evidence: object | null }> = [
      { name: "phrase", status: "possibly_closed", evidence: phrase },
      { name: "plain", status: "possibly_closed", evidence: alive },
      { name: "closed", status: "closed", evidence: { ...alive, outcome: "gone", httpStatus: 404 } },
      { name: "closed with phrase", status: "closed", evidence: phrase },
      { name: "malformed phrase", status: "possibly_closed", evidence: { outcome: "phrase" } },
    ];
    for (const c of cases) {
      await resetTables();
      const id = await firstJob();
      const older = new Date(Date.now() - 5 * DAY);
      await mark(id, c.status, c.evidence, older);
      await changedPayload();
      const viaPipeline = await statusOf(id);
      await mark(id, c.status, c.evidence, older);
      await touchJobsSeen(getDb());
      expect({ case: c.name, status: await statusOf(id) }).toEqual({ case: c.name, status: viaPipeline });
      if (c.name === "malformed phrase") expect(viaPipeline).toBe("possibly_closed");
    }
  });

  it("never offers a phrase-marked job to the plain link check, watched or not, with the watched recheck on or off", async () => {
    const id = await firstJob();
    const ids = async (skipWatched: boolean) => (await listJobsForLinkCheck(getDb(), 10, { skipWatched })).map((j) => j.id);
    await mark(id, "possibly_closed", phrase);
    // not starred, no application: the watched recheck does not own it, yet the plain check must not touch it
    expect(await ids(true)).toEqual([]);
    expect(await ids(false)).toEqual([]);
    await mark(id, "possibly_closed", alive);
    expect(await ids(true)).toEqual([id]);
    expect(await ids(false)).toEqual([id]);
    await mark(id, "possibly_closed", null);
    expect(await ids(false)).toEqual([id]);
  });

  it("changes no status when the posting was fetched no later than the last sighting", async () => {
    const id = await firstJob();
    const future = new Date(Date.now() + DAY);
    await mark(id, "possibly_closed", alive, future);
    await changedPayload();
    expect(await statusOf(id)).toBe("possibly_closed");
    expect((await allJobs())[0]?.lastSeenAt.getTime()).toBe(future.getTime());
  });
});

describe("failures stay isolated (C1, C2)", () => {
  const broken = (id: string): Channel => ({
    id,
    family: "manual",
    kind: "manual",
    usesQueries: false,
    async collect() {
      return [
        { externalId: "bad-shape", url: null, payload: { nothing: true } },
        { externalId: "bad-draft", url: null, payload: { draft: "invalid" } },
        { externalId: "boom", url: null, payload: { boom: true } },
      ];
    },
    parse(payload): NormalizedPostingDraft {
      const p = payload as { nothing?: boolean; draft?: string; boom?: boolean };
      if (p.nothing) throw new ChannelError("parse", "payload has no title");
      if (p.boom) throw new TypeError("unexpected shape");
      return { title: "", companyName: "x", locations: [], workplace: "unknown", description: "", applyUrl: null, sourceUrl: null };
    },
  });

  it("marks what cannot be parsed as parse_failed with the reason and parses the rest of the cycle", async () => {
    const registry = threeChannels();
    registry.register(broken("fx-broken"), { settings: { enabled: true, maxResults: 10, monthlyBudgetUsd: 0, freeRecordsPerMonth: 0, throttle: { minDelayMs: 0, maxDelayMs: 0 }, extra: {} } });
    // a posting of a channel this process does not know
    await upsertChannelRows(getDb(), [{ id: "ghost", family: "manual", kind: "manual", enabled: false }]);
    await upsertRawPostings(getDb(), { channelId: "ghost", runId: null, items: [{ externalId: "g-1", url: null, payload: { some: "payload" } }] });

    const result = await run(registry);
    expect(result.status).toBe("succeeded");
    const pipeline = pipelineOf(result);
    expect(pipeline).toMatchObject({ processed: 10, parsed: 6, created: 3, parseFailed: 4, deferred: 0 });
    expect(pipeline.failures).toHaveLength(4);
    expect(await allJobs()).toHaveLength(3);

    const failed = await getDb().select().from(schema.rawPostings).where(eq(schema.rawPostings.parseStatus, "parse_failed"));
    const byExternal = Object.fromEntries(failed.map((r) => [r.externalId, r.parseError]));
    expect(byExternal["bad-shape"]).toBe("parse failed: parse: payload has no title");
    expect(byExternal["bad-draft"]).toContain("invalid draft from fx-broken");
    expect(byExternal["bad-draft"]).toContain("title");
    expect(byExternal.boom).toBe("parse failed: TypeError: unexpected shape");
    expect(byExternal["g-1"]).toContain('unknown channel "ghost"');
    // the payload is kept (C1)
    expect(failed.find((r) => r.externalId === "bad-shape")?.payloadJson).toEqual({ nothing: true });

    // a second cycle does not retry them while the payload is unchanged
    expect(pipelineOf(await run(registry))).toMatchObject({ processed: 0, parseFailed: 0 });
  });

  it("sets a failed posting back to pending, and clears its error, when the channel delivers a changed payload", async () => {
    const registry = new ChannelRegistry();
    const fixture = createFixtureChannel({ id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1")] });
    registry.register(fixture, { settings: { enabled: true, maxResults: 10, monthlyBudgetUsd: 0, freeRecordsPerMonth: 0, throttle: { minDelayMs: 0, maxDelayMs: 0 }, extra: {} } });
    await run(registry);
    // corrupt the stored payload, then let the channel deliver the good one again
    await getDb().update(schema.rawPostings).set({ payloadJson: { id: 1 }, payloadHash: "stale", parseStatus: "pending" });
    expect(pipelineOf(await run(new ChannelRegistry()))).toMatchObject({ parseFailed: 1 });
    const [failed] = await listRawPostingsForChannel(getDb(), "fx-a");
    expect(failed).toMatchObject({ parseStatus: "parse_failed" });
    expect(failed?.parseError).toContain("unknown channel");

    await run(registry);
    const [recovered] = await listRawPostingsForChannel(getDb(), "fx-a");
    expect(recovered).toMatchObject({ parseStatus: "parsed", parseError: null });
    expect(await allJobs()).toHaveLength(1);
  });

  it("works through more postings than one batch", async () => {
    const registry = threeChannels();
    resetCycleSteps(); // collect only
    await run(registry);
    const result = await runPipeline(getDb(), { config: pipelineWith((raw) => (raw.batch_size = 2)), registry, logger: quietLogger });
    expect(result).toMatchObject({ processed: 6, parsed: 6, created: 3 });
  });

  it("stops between postings when cancelled and leaves the rest pending", async () => {
    const registry = threeChannels();
    resetCycleSteps();
    await run(registry);
    const controller = new AbortController();
    controller.abort();
    const result = await runPipeline(getDb(), { config: shippedPipeline(), registry, logger: quietLogger, signal: controller.signal });
    expect(result).toMatchObject({ processed: 0, aborted: true });
    const pending = await getDb().select().from(schema.rawPostings).where(eq(schema.rawPostings.parseStatus, "pending"));
    expect(pending).toHaveLength(6);
  });
});

describe("reprocessing stored postings with improved rules", () => {
  const description = `${Array.from({ length: 10 }, (_, i) => `Sentence ${i + 1} describes the work of the team in some detail.`).join(" ")} Hybrid work model: 3 days in the office. Preferred Qualifications Fluent in German and English. Show more Show less`;

  it("puts parsed postings back to pending and updates the jobs in place with the current rules, keeping the payload (C1)", async () => {
    const registry = new ChannelRegistry();
    const fixture = createFixtureChannel({ id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { description })] });
    registry.register(fixture, { settings: { enabled: true, maxResults: 10, monthlyBudgetUsd: 0, freeRecordsPerMonth: 0, throttle: { minDelayMs: 0, maxDelayMs: 0 }, extra: {} } });
    resetCycleSteps(); // collect only
    await run(registry);

    // the rules as they were before: no work mode words, no clean-up
    const old = pipelineWith((raw) => {
      const workplace = raw.workplace as { text: Record<string, string[]> };
      workplace.text = { remote: ["zzz-never"], hybrid: ["zzz-never"], onsite: ["zzz-never"] };
      (raw.description as { trailing_ui_patterns: string[] }).trailing_ui_patterns = ["zzz-never"];
      (raw.description as { restore: { min_chars: number } }).restore.min_chars = 1_000_000;
    });
    await runPipeline(getDb(), { config: old, registry, logger: quietLogger });
    const before = await jobTitled("job 1");
    expect(before.workplace).toBe("unknown");
    expect(before.description).toContain("Show more Show less");
    const [rawBefore] = await listRawPostingsForChannel(getDb(), "fx-a");

    expect(await runPipeline(getDb(), { config: shippedPipeline(), registry, logger: quietLogger })).toMatchObject({ processed: 0 }); // nothing pending: the new rules do not apply by themselves

    expect(await requeueRawPostings(getDb())).toBe(1);
    expect(await requeueRawPostings(getDb(), ["some-other-channel"])).toBe(0); // nothing parsed or failed is left to put back
    const result = await runPipeline(getDb(), { config: shippedPipeline(), registry, logger: quietLogger });
    expect(result).toMatchObject({ processed: 1, parsed: 1, created: 0, updated: 1, parseFailed: 0 });

    const after = await jobTitled("job 1");
    expect(after.id).toBe(before.id);
    expect(after.workplace).toBe("hybrid");
    expect(after.germanLevelRequired).toBe("preferred");
    expect(after.description).not.toContain("Show more");
    expect(after.description).toContain("\n\n");
    const [rawAfter] = await listRawPostingsForChannel(getDb(), "fx-a");
    expect(rawAfter?.payloadJson).toEqual(rawBefore?.payloadJson);
    expect(rawAfter?.parseStatus).toBe("parsed");
  });

  it("clears the facts the rules read from the text first, so a flag the old rules got wrong does not survive (merging only accumulates)", async () => {
    const registry = new ChannelRegistry();
    const fixture = createFixtureChannel({ id: "fx-a", family: "ats", usesQueries: false, postings: [posting("1", { description: "Build things for our logistics platform. Hybrid work model: 3 days in the office." })] });
    registry.register(fixture, { settings: { enabled: true, maxResults: 10, monthlyBudgetUsd: 0, freeRecordsPerMonth: 0, throttle: { minDelayMs: 0, maxDelayMs: 0 }, extra: {} } });
    resetCycleSteps();
    await run(registry);
    await runPipeline(getDb(), { config: shippedPipeline(), registry, logger: quietLogger });
    const job = await jobTitled("job 1");
    // what an older rule set got wrong: an agency flag and a work mode the text does not support
    await getDb().update(schema.jobs).set({ isAgency: true, workplace: "remote", germanLevelRequired: "C1", contract: "temp_agency" }).where(eq(schema.jobs.id, job.id));

    await runPipeline(getDb(), { config: shippedPipeline(), registry, logger: quietLogger });
    expect(await requeueRawPostings(getDb())).toBe(1);
    await runPipeline(getDb(), { config: shippedPipeline(), registry, logger: quietLogger });
    // kept: the agency flag only accumulates and a known value is never replaced by `unknown`; only a new known value wins
    expect(await jobTitled("job 1")).toMatchObject({ isAgency: true, workplace: "hybrid", germanLevelRequired: "C1", contract: "temp_agency" });

    expect(await resetRuleDerivedFacts(getDb())).toBe(1);
    expect(await jobTitled("job 1")).toMatchObject({ isAgency: false, workplace: "unknown", germanLevelRequired: "unknown", contract: "unknown" });
    await requeueRawPostings(getDb());
    await runPipeline(getDb(), { config: shippedPipeline(), registry, logger: quietLogger });
    expect(await jobTitled("job 1")).toMatchObject({ isAgency: false, workplace: "hybrid", germanLevelRequired: "unknown", contract: "unknown" }); // the text states no contract: the stale temp_agency is gone
  });

  it("can be limited to some channels", async () => {
    const registry = threeChannels();
    resetCycleSteps();
    await run(registry);
    await runPipeline(getDb(), { config: shippedPipeline(), registry, logger: quietLogger });
    expect(await requeueRawPostings(getDb(), ["fx-ats"])).toBeGreaterThan(0);
    const pending = await getDb().select().from(schema.rawPostings).where(eq(schema.rawPostings.parseStatus, "pending"));
    expect(new Set(pending.map((r) => r.channelId))).toEqual(new Set(["fx-ats"]));
  });
});

describe("job lifecycle (fake clock)", () => {
  /** Cycle at real time; returns "now + days" clocks. */
  async function seeded() {
    const registry = threeChannels();
    await run(registry);
    const start = Date.now();
    return { registry, at: (days: number) => new Date(start + days * DAY), start };
  }

  const maintenance = (now: Date, fetch: FetchLike = fakeFetch(() => 200).fetch, overrides: (raw: Record<string, unknown>) => void = () => {}) =>
    runMaintenance(getDb(), {
      config: pipelineWith(overrides),
      http: createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch }),
      logger: quietLogger,
      now: () => now,
      resolveHost: async () => ["93.184.216.34"], // the fixtures' hosts do not exist: any public address will do
    });
  const statuses = async () => Object.fromEntries((await allJobs()).map((j) => [j.titleNorm, j.status]));

  it("keeps jobs active until every source has been silent for the configured days", async () => {
    const { at } = await seeded();
    for (const channel of ["fx-ats", "fx-linkedin", "fx-stepstone"]) await insertRun(channel, at(6.9));
    const result = await maintenance(at(6.9));
    expect(result).toMatchObject({ possiblyClosed: 0, linkChecked: 0 });
    expect(Object.values(await statuses())).toEqual(["active", "active", "active"]);
  });

  it("marks jobs possibly_closed after 7 days when their channels ran successfully without returning them", async () => {
    const { at } = await seeded();
    for (const channel of ["fx-ats", "fx-linkedin", "fx-stepstone"]) await insertRun(channel, at(7.1));
    const result = await maintenance(at(7.2), fakeFetch(() => 503).fetch);
    expect(result).toMatchObject({ possiblyClosed: 3, linkChecked: 3, closed: 0 });
    expect(Object.values(await statuses())).toEqual(["possibly_closed", "possibly_closed", "possibly_closed"]);
  });

  it("never closes jobs of a channel that did not complete a run after the deadline (C2)", async () => {
    const { at } = await seeded();
    // ATS and LinkedIn ran fine, StepStone only failed: the job StepStone also carries stays active
    await insertRun("fx-ats", at(7.1));
    await insertRun("fx-linkedin", at(7.1));
    await insertRun("fx-stepstone", at(7.1), "failed");
    // a successful ATS run from before the deadline does not count either
    await insertRun("fx-ats", at(3));
    await maintenance(at(7.2), fakeFetch(() => 503).fetch);
    const state = await statuses();
    expect(state["applied ai engineer"]).toBe("active"); // sources: ATS + LinkedIn + StepStone
    expect(state["forward deployed engineer"]).toBe("possibly_closed"); // ATS + LinkedIn
    expect(state["data engineer"]).toBe("possibly_closed"); // ATS only
  });

  it("does nothing for channels without any run", async () => {
    const { at } = await seeded();
    await getDb().execute(sql`delete from runs`);
    expect(await maintenance(at(30))).toMatchObject({ possiblyClosed: 0 });
  });

  it("closes a possibly_closed job when its link answers 404 or 410 and only then", async () => {
    const { at } = await seeded();
    for (const channel of ["fx-ats", "fx-linkedin", "fx-stepstone"]) await insertRun(channel, at(7.1));
    const answers: Record<string, number> = {
      "https://jobs.example.test/northwind/1001": 404,
      "https://www.linkedin.example.test/jobs/view/9001": 404,
      "https://www.stepstone.example.test/jobs/5001": 410,
      "https://jobs.example.test/contoso/1002": 200,
      "https://jobs.example.test/northwind/1003": 503,
    };
    const { fetch, calls } = fakeFetch((u) => answers[u] ?? 404);
    const result = await maintenance(at(7.2), fetch);
    expect(result).toMatchObject({ possiblyClosed: 3, linkChecked: 3, closed: 1, alive: 1 });
    const state = await statuses();
    expect(state["applied ai engineer"]).toBe("closed"); // every link gone
    expect(state["forward deployed engineer"]).toBe("active"); // the ATS link is alive
    expect(state["data engineer"]).toBe("possibly_closed"); // 503 proves nothing
    // HEAD first, GET to confirm
    expect(calls.filter((c) => c.endsWith("northwind/1003"))).toEqual(["HEAD https://jobs.example.test/northwind/1003", "GET https://jobs.example.test/northwind/1003"]);
    expect(calls.filter((c) => c.endsWith("contoso/1002"))).toEqual(["HEAD https://jobs.example.test/contoso/1002"]);
    const jobs = await allJobs();
    expect(jobs.every((j) => j.linkCheckedAt !== null)).toBe(true);
  });

  it("logs one aggregated line when link checks were skipped because the address is not public", async () => {
    const { at } = await seeded();
    for (const channel of ["fx-ats", "fx-linkedin", "fx-stepstone"]) await insertRun(channel, at(7.1));
    const lines: string[] = [];
    const logger = createLogger({ minLevel: "warn", sink: (record) => lines.push(record.message) });
    const fetchSpy = fakeFetch(() => 200);
    await runMaintenance(getDb(), {
      config: pipelineWith(() => {}),
      http: createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch: fetchSpy.fetch }),
      logger,
      now: () => at(7.2),
      resolveHost: async () => ["10.0.0.7"],
    });
    const skipped = lines.filter((line) => /link checks skipped \(non-public address\)$/.test(line));
    expect(skipped).toHaveLength(1); // one line for the whole cycle, one count per URL
    expect(skipped[0]).toMatch(/^[1-9]\d* link checks skipped/);
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("checks at most max_link_checks_per_cycle jobs and moves on to the others next cycle", async () => {
    const { at } = await seeded();
    for (const channel of ["fx-ats", "fx-linkedin", "fx-stepstone"]) await insertRun(channel, at(7.1));
    const cap = (raw: Record<string, unknown>) => ((raw.lifecycle as { max_link_checks_per_cycle: number }).max_link_checks_per_cycle = 2);
    const stillGone = fakeFetch(() => 503);
    const first = await maintenance(at(7.2), stillGone.fetch, cap);
    expect(first).toMatchObject({ possiblyClosed: 3, linkChecked: 2 });
    const second = await maintenance(at(7.3), stillGone.fetch, cap);
    expect(second.linkChecked).toBe(2);
    const checkedAt = (await allJobs()).map((j) => j.linkCheckedAt?.getTime() ?? 0);
    expect(checkedAt.every((t) => t > 0)).toBe(true); // the third job was reached in the second round
    expect(await maintenance(at(7.4), stillGone.fetch, (raw) => ((raw.lifecycle as { max_link_checks_per_cycle: number }).max_link_checks_per_cycle = 0))).toMatchObject({
      linkChecked: 0,
    });
  });

  it("reopens a job when a source returns it again", async () => {
    const { registry, at } = await seeded();
    for (const channel of ["fx-ats", "fx-linkedin", "fx-stepstone"]) await insertRun(channel, at(7.1));
    await maintenance(at(7.2), fakeFetch(() => 503).fetch);
    expect(Object.values(await statuses())).toEqual(["possibly_closed", "possibly_closed", "possibly_closed"]);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await run(registry); // collect refreshes raw_postings.fetched_at
    expect(Object.values(await statuses())).toEqual(["active", "active", "active"]);
  });

  it("never deletes a job with an application, whatever its status", async () => {
    const { at } = await seeded();
    const job = await jobTitled("data engineer");
    await getDb().insert(schema.applications).values({ jobId: job.id, status: "applied" });
    for (const channel of ["fx-ats", "fx-linkedin", "fx-stepstone"]) await insertRun(channel, at(7.1));

    await maintenance(at(7.2), fakeFetch(() => 503).fetch);
    expect((await jobTitled("data engineer")).status).toBe("possibly_closed");
    await maintenance(at(7.3), fakeFetch(() => 404).fetch);
    expect((await jobTitled("data engineer")).status).toBe("closed");

    expect(await allJobs()).toHaveLength(3);
    const applications = await getDb().select().from(schema.applications).where(and(eq(schema.applications.jobId, job.id)));
    expect(applications).toHaveLength(1);
    expect(applications[0]?.status).toBe("applied");
    expect(await listJobSources(getDb(), job.id)).toHaveLength(1);
  });

  it("runs as the maintenance step of a cycle with the cycle's clock and fetch", async () => {
    const { at } = await seeded();
    for (const channel of ["fx-ats", "fx-linkedin", "fx-stepstone"]) await insertRun(channel, at(7.1));
    const { fetch } = fakeFetch(() => 404);
    const result = await run(new ChannelRegistry(), { now: () => at(7.2), fetch, resolveHost: async () => ["93.184.216.34"] });
    expect(maintenanceOf(result)).toMatchObject({ possiblyClosed: 3, linkChecked: 3, closed: 3 });
    expect(Object.values(await statuses())).toEqual(["closed", "closed", "closed"]);
  });
});
