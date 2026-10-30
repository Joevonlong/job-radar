import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { scoreTransaction } from "@/lib/db/repos/current-scores";
import fs from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

import { AiProviderError } from "@/lib/ai/errors";
import { createProvider } from "@/lib/ai/provider";
import * as providers from "@/lib/ai/providers";
import { createMemoryQuotaStore } from "@/lib/ai/quota-guard";
import { createAiRouter } from "@/lib/ai/router";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { createScoreJobsHandler } from "@/lib/control/score-jobs";
import { loadConfig } from "@/lib/config";
import { requestScoreJobs } from "@/lib/control/service";
import { claimNextControlRequest, closeDb, countUnscoredJobs, getDb, insertControlRequest, listControlRequests, markScoresStaleExcept, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createScoringDeps, currentPreferencesSnapshotId, runScoring, type ScoringDeps, type ScoringProfile } from "@/lib/scoring";
import { loadControlStatus } from "@/lib/settings/status";

import { usageEntry } from "../ai/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { quietLogger } from "../cycle/helpers";
import { aiConfig, answer, examplePreferences, exampleMe } from "../scoring/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T10:00:00Z");

function fakeAi(fail: Error | null = null, score = 66, onCall: () => void = () => {}) {
  const calls: string[] = [];
  const transport: AiTransport = {
    id: "claude-cli",
    availability: () => ({ available: true }),
    async call(request: AiTransportRequest) {
      calls.push(/^Title: (.*)$/m.exec(request.user)?.[1] ?? "?");
      onCall();
      if (fail) throw fail;
      return { text: answer({ score }), model: "fake-model", usage: { tokensIn: 100, tokensOut: 20 } };
    },
  };
  const provider = createProvider(transport);
  return { calls, provider, router: createAiRouter({ config: aiConfig(), providers: [provider], usage: null }) };
}

const profile = (): ScoringProfile => ({ me: exampleMe(), preferences: examplePreferences(), meYaml: stringify(exampleMe()), preferencesYaml: stringify(examplePreferences()) });

function deps(router: ScoringDeps["router"], config = aiConfig()): ScoringDeps {
  return { db: getDb(), router, config, logger: quietLogger, now: () => NOW, loadProfile: async () => profile(), loadBonusCap: () => 15 };
}

async function addJob(title: string, over: { filter?: "passed" | "filtered_out"; score?: number } = {}): Promise<number> {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title.toLowerCase()}` }).returning();
  const [job] = await db
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description: `About ${title}`, firstSeenAt: new Date(NOW.getTime() - 3_600_000) })
    .returning();
  const snapshotId = await currentPreferencesSnapshotId(db, profile());
  await withRebuiltCurrentScores(db, db.insert(schema.scores).values({
    jobId: job!.id,
    profileSnapshotId: snapshotId,
    filterResult: over.filter ?? "passed",
    ...(over.score === undefined ? {} : { score: over.score, rankValue: over.score }),
  }));
  return job!.id;
}

const scoreOf = async (jobId: number) => (await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, jobId)))[0]?.score ?? null;
const pollOptions = () => ({ db: getDb(), signal: new AbortController().signal, logger: quietLogger });

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

let temp: TempConfig;
beforeEach(async () => {
  temp = makeTempConfig();
  await getDb().execute(sql`truncate table control_requests, scores, jobs, companies, profile_snapshots, ai_usage, applications restart identity cascade`);
});

afterEach(() => { resetControlHandlers(); vi.restoreAllMocks(); temp.cleanup(); });

afterAll(async () => {
  await getDb().execute(sql`truncate table control_requests, scores, jobs, companies, profile_snapshots, ai_usage, applications restart identity cascade`);
  await closeDb();
});

describe("asking for scores from the web side", () => {
  it("queues a request for the named jobs and for the backlog", async () => {
    const id = await addJob("Waiting");
    expect(await requestScoreJobs({ jobIds: [id] })).toMatchObject({ status: "queued", kind: "score_jobs", existing: false });
    expect(await requestScoreJobs({ backlog: true })).toMatchObject({ status: "queued", kind: "score_jobs", existing: false });
    const rows = await listControlRequests(getDb(), 10);
    expect(rows.map((r) => r.payload).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ backlog: true }, { jobIds: [id] }]);
  });

  it("reuses an open request with the same payload, but another job gets its own request", async () => {
    const a = await addJob("A");
    const b = await addJob("B");
    const first = await requestScoreJobs({ jobIds: [a] });
    expect(await requestScoreJobs({ jobIds: [a] })).toMatchObject({ status: "queued", existing: true, request: first.status === "queued" ? first.request : -1 });
    expect(await requestScoreJobs({ jobIds: [b] })).toMatchObject({ status: "queued", existing: false });
    expect((await requestScoreJobs({ backlog: true })).status).toBe("queued");
    expect(await requestScoreJobs({ backlog: true })).toMatchObject({ existing: true });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(3);
  });

  it("refuses what it cannot make sense of or what has nothing to score", async () => {
    expect(await requestScoreJobs({})).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestScoreJobs({ jobIds: [] })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestScoreJobs({ jobIds: [1.5] })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestScoreJobs({ jobIds: [1], backlog: true })).toMatchObject({ status: "error", error: "invalidPayload" });
    expect(await requestScoreJobs({ jobIds: Array.from({ length: 51 }, (_, i) => i + 1) })).toMatchObject({ error: "invalidPayload" });

    expect(await requestScoreJobs({ backlog: true })).toMatchObject({ status: "error", error: "nothingToScore" });
    const scored = await addJob("Done", { score: 80 });
    const filtered = await addJob("Filtered out", { filter: "filtered_out" });
    expect(await requestScoreJobs({ jobIds: [scored] })).toMatchObject({ error: "nothingToScore" });
    expect(await requestScoreJobs({ jobIds: [filtered] })).toMatchObject({ error: "nothingToScore" });
    expect(await requestScoreJobs({ jobIds: [424242] })).toMatchObject({ error: "nothingToScore" });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(0);
  });
});

describe("the score_jobs control request", () => {
  it("the dependency factory keeps the loop deadline away from the router so a started job can finish", async () => {
    const fake = fakeAi();
    vi.spyOn(providers, "createDefaultProviders").mockReturnValue([fake.provider]);
    const deadline = new Date(NOW.getTime() - 1);
    const created = createScoringDeps({ db: getDb(), logger: quietLogger, timeZone: "UTC", now: () => NOW, deadline, config: aiConfig() });
    expect(created.deadline).toBe(deadline);
    const result = await created.router.run("score", { system: "Score the example", user: "Example role" }, z.object({ score: z.number() }));
    expect(result.value.score).toBe(66);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([1, 0])("uses the configured time budget before starting another job; %i minutes (zero is unlimited)", async (minutes) => {
    let now = NOW.getTime();
    const config = aiConfig((raw) => { raw.cycle_budget_minutes = minutes; (raw.scoring as Record<string, unknown>).concurrency = 1; });
    const fake = fakeAi(null, 66, () => { now += 60_000; });
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => ({ ...deps(fake.router, config), now: () => new Date(now) }) }));
    for (const title of ["First", "Second", "Third"]) await addJob(title);
    await requestScoreJobs({ backlog: true });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ status: "done", result: { scored: minutes ? 1 : 3, failed: 0, remaining: minutes ? 2 : 0, ...(minutes ? { stopped: "time_budget" } : {}) } });
    expect(fake.calls).toHaveLength(minutes ? 1 : 3);
    if (!minutes) expect(finished?.result).not.toHaveProperty("stopped");
    const shown = (await loadControlStatus(getDb())).requests[0];
    expect(shown).toMatchObject({ remaining: minutes ? 2 : 0, ...(minutes ? { stopped: "time_budget" } : {}) });
  });

  it("an exhausted budget before the first job keeps the existing stopped error without counting a failure", async () => {
    let now = NOW.getTime();
    const config = aiConfig((raw) => { raw.cycle_budget_minutes = 1; });
    const fake = fakeAi();
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => ({ ...deps(fake.router, config), now: () => new Date(now), loadProfile: async () => { now += 60_000; return profile(); } }) }));
    const id = await addJob("Waiting");
    await requestScoreJobs({ jobIds: [id] });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "failed", result: { error: "score_stopped", stopped: "time_budget", scored: 0, failed: 0, remaining: 1 } });
    expect(fake.calls).toHaveLength(0);
  });

  it("counts selected stale scores left by the budget even when no job waits for a first score", async () => {
    const ids = [await addJob("First"), await addJob("Second")];
    await runScoring(deps(fakeAi().router), { limit: 2 });
    await scoreTransaction(getDb(), (tx) => markScoresStaleExcept(tx, 987654321));
    expect(await countUnscoredJobs(getDb())).toBe(0);
    let now = NOW.getTime();
    const config = aiConfig((raw) => { raw.cycle_budget_minutes = 1; (raw.scoring as Record<string, unknown>).concurrency = 1; });
    const fake = fakeAi(null, 66, () => { now += 60_000; });
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => ({ ...deps(fake.router, config), now: () => new Date(now) }) }));
    await requestScoreJobs({ jobIds: ids });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "done", result: { scored: 1, failed: 0, remaining: 1, stopped: "time_budget" } });
    expect((await loadControlStatus(getDb())).requests[0]).toMatchObject({ remaining: 1, stopped: "time_budget" });
  });

  it("the next request uses a hot-reloaded budget", async () => {
    const file = path.join(temp.configDir, "ai.yaml");
    const writeBudget = (minutes: number) => {
      const doc = parseDocument(fs.readFileSync(file, "utf8"));
      doc.set("cycle_budget_minutes", minutes);
      doc.setIn(["scoring", "concurrency"], 1);
      fs.writeFileSync(file, doc.toString());
    };
    let now = NOW.getTime();
    const fake = fakeAi(null, 66, () => { now += 60_000; });
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => ({ ...deps(fake.router, loadConfig("ai")), now: () => new Date(now) }) }));
    for (const title of ["First", "Second", "Third"]) await addJob(title);
    writeBudget(1);
    await requestScoreJobs({ backlog: true });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ result: { scored: 1, stopped: "time_budget", remaining: 2 } });
    writeBudget(0);
    await requestScoreJobs({ backlog: true });
    const done = await processNextControlRequest(pollOptions());
    expect(done).toMatchObject({ status: "done", result: { scored: 2, remaining: 0 } });
    expect(done?.result).not.toHaveProperty("stopped");
  });

  it("without the ai-worker's handler nothing is scored: the request fails visibly", async () => {
    const id = await addJob("Waiting");
    await insertControlRequest(getDb(), { kind: "score_jobs", payload: { jobIds: [id] } });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "failed", result: { error: "no_handler" } });
    expect(await scoreOf(id)).toBeNull();
  });

  it("scores the named job and reports it; the status shows the job and the shrinking backlog", async () => {
    const fake = fakeAi();
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => deps(fake.router) }));
    const wanted = await addJob("Wanted");
    const other = await addJob("Other");
    expect((await loadControlStatus(getDb())).unscoredJobs).toBe(2);

    await requestScoreJobs({ jobIds: [wanted] });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ status: "done", result: { scored: 1, failed: 0, skipped: 0, remaining: 1, placeholder: false } });
    expect(fake.calls).toEqual(["Wanted"]);
    expect(await scoreOf(wanted)).toBe(66);
    expect(await scoreOf(other)).toBeNull();

    const status = await loadControlStatus(getDb());
    expect(status.unscoredJobs).toBe(1);
    expect(status.requests[0]).toMatchObject({ kind: "score_jobs", status: "done", scored: 1, failed: 0, jobIds: [wanted] });
  });

  it("scores the backlog up to backlog_per_run, most relevant first", async () => {
    const config = aiConfig((raw) => {
      (raw.scoring as Record<string, unknown>).backlog_per_run = 2;
    });
    const fake = fakeAi();
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => deps(fake.router, config) }));
    const net = await addJob("Senior Fullstack-Entwickler .NET");
    const ai = await addJob("Senior AI Engineer");
    const fde = await addJob("Forward Deployed Engineer");
    expect(await countUnscoredJobs(getDb())).toBe(3);

    await requestScoreJobs({ backlog: true });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ status: "done", result: { scored: 2, remaining: 1 } });
    expect([...fake.calls].sort()).toEqual(["Forward Deployed Engineer", "Senior AI Engineer"]);
    expect(await scoreOf(net)).toBeNull();
    expect(await scoreOf(ai)).toBe(66);
    expect(await scoreOf(fde)).toBe(66);
    expect((await loadControlStatus(getDb())).requests[0]?.jobIds).toBeNull();
  });

  it("a job that reaches translate_auto_min_score gets a translate_job request, like a cycle would translate it", async () => {
    const high = fakeAi(null, 82);
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => deps(high.router) }));
    const good = await addJob("Good fit");
    await requestScoreJobs({ jobIds: [good] });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "done", result: { scored: 1, translationsQueued: 1 } });
    const translate = (await listControlRequests(getDb(), 10)).filter((r) => r.kind === "translate_job");
    expect(translate.map((r) => r.payload)).toEqual([{ jobId: good, force: false, origin: "auto" }]);
    expect(await claimNextControlRequest(getDb(), undefined, { lane: "interactive" })).toBeNull();

    // below the minimum: nothing is queued (the first translation is taken care of meanwhile)
    await getDb().update(schema.controlRequests).set({ status: "done" }).where(eq(schema.controlRequests.kind, "translate_job"));
    resetControlHandlers();
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => deps(fakeAi().router) }));
    const weak = await addJob("Weak fit");
    await requestScoreJobs({ jobIds: [weak] });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "done", result: { scored: 1, translationsQueued: 0 } });
    expect((await listControlRequests(getDb(), 10)).filter((r) => r.kind === "translate_job")).toHaveLength(1);
  });

  it("every job failing fails the request with a code instead of a zero", async () => {
    const fake = fakeAi(new AiProviderError("claude-cli", "auth", "login expired"));
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => deps(fake.router) }));
    const id = await addJob("Waiting");
    await requestScoreJobs({ jobIds: [id] });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ status: "failed", result: { scored: 0, error: "score_ai_unavailable" } });
    expect(await scoreOf(id)).toBeNull();
  });

  it("Job Radar's usage cap fails the request with its own code and the expected time", async () => {
    const config = aiConfig((raw) => {
      raw.quota_guard = { providers: { claude_cli: { hard_requests: 1, cycle_request_cap: 0 } } };
    });
    let calls = 0;
    const quota = createMemoryQuotaStore([usageEntry({ provider: "claude-cli", task: "score", at: new Date(NOW.getTime() - 60_000) })]);
    const transport: AiTransport = { id: "claude-cli", availability: () => ({ available: true }), call: async () => {
      calls += 1;
      return { text: answer({ score: 66 }), model: "m", usage: { tokensIn: 1, tokensOut: 1 } };
    } };
    const router = createAiRouter({ config, providers: [createProvider(transport)], usage: null, quota, origin: "control", now: () => NOW, timeZone: "UTC" });
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => deps(router, config) }));
    const id = await addJob("Waiting");
    await requestScoreJobs({ jobIds: [id] });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ status: "failed", result: { scored: 0, error: "quota_guard", resumeAt: expect.any(String) } });
    expect(calls).toBe(0);
    expect(await scoreOf(id)).toBeNull();
  });

  it("an unusable profile stops the run: reported as not started", async () => {
    const fake = fakeAi();
    const empty = async (): Promise<ScoringProfile> => ({ ...profile(), me: exampleMe((raw) => { raw.summary = ""; raw.skills = []; }) });
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => ({ ...deps(fake.router), loadProfile: empty }) }));
    const id = await addJob("Waiting");
    await requestScoreJobs({ jobIds: [id] });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "failed", result: { error: "score_profile_incomplete", profileMissing: ["summary", "skills"], remaining: 1 } });
    expect(fake.calls).toEqual([]);
  });

  it("a payload that does not parse fails the request without touching the AI", async () => {
    const fake = fakeAi();
    registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => deps(fake.router) }));
    await insertControlRequest(getDb(), { kind: "score_jobs", payload: { jobIds: "nope" } });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "failed", result: { error: "invalid_payload" } });
    expect(fake.calls).toEqual([]);
  });
});
