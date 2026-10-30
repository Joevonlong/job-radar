import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { scoreTransaction } from "@/lib/db/repos/current-scores";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { stringify } from "yaml";

import { AiProviderError } from "@/lib/ai/errors";
import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import { registerControlHandler, resetControlHandlers, processNextControlRequest } from "@/lib/control";
import { createRescoreStaleHandler } from "@/lib/control/rescore";
import { requestRescoreStale } from "@/lib/control/service";
import { closeDb, countStaleScores, getDb, insertControlRequest, markScoresStaleExcept, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { currentPreferencesSnapshotId, runScoring, type ScoringDeps, type ScoringProfile } from "@/lib/scoring";
import { loadControlStatus } from "@/lib/settings/status";

import { quietLogger } from "../cycle/helpers";
import { aiConfig, answer, exampleMe, examplePreferences } from "../scoring/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T10:00:00Z");

/** A fake provider: answers every posting with a valid score, or fails when told to. No real CLI or API is reachable. */
function fakeAi(fail: Error | null = null, onCall: () => void = () => {}) {
  const calls: string[] = [];
  const transport: AiTransport = {
    id: "claude-cli",
    availability: () => ({ available: true }),
    async call(request: AiTransportRequest) {
      calls.push(/^Title: (.*)$/m.exec(request.user)?.[1] ?? "?");
      onCall();
      if (fail) throw fail;
      return { text: answer({ score: 77 }), model: "fake-model", usage: { tokensIn: 100, tokensOut: 20 } };
    },
  };
  return { calls, router: createAiRouter({ config: aiConfig(), providers: [createProvider(transport)], usage: null }) };
}

const profile = (): ScoringProfile => ({ me: exampleMe(), preferences: examplePreferences(), meYaml: stringify(exampleMe()), preferencesYaml: stringify(examplePreferences()) });

function deps(router: ScoringDeps["router"], loadProfile: ScoringDeps["loadProfile"] = async () => profile()): ScoringDeps {
  return { db: getDb(), router, config: aiConfig(), logger: quietLogger, now: () => NOW, loadProfile, loadBonusCap: () => 15 };
}

async function addScoredJob(title: string): Promise<number> {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title.toLowerCase()}` }).returning();
  const [job] = await db
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description: `About ${title}`, firstSeenAt: new Date(NOW.getTime() - 3_600_000) })
    .returning();
  const snapshotId = await currentPreferencesSnapshotId(db, profile());
  await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: job!.id, profileSnapshotId: snapshotId, filterResult: "passed" }));
  return job!.id;
}

/** Two scored jobs whose scores are then marked stale, as a profile change would. */
async function staleJobs(): Promise<number[]> {
  const ids = [await addScoredJob("Alpha"), await addScoredJob("Beta")];
  await runScoring(deps(fakeAi().router), { limit: 10 });
  await scoreTransaction(getDb(), (tx) => markScoresStaleExcept(tx, 987654321));
  expect(await countStaleScores(getDb())).toBe(2);
  return ids;
}

const pollOptions = () => ({ db: getDb(), signal: new AbortController().signal, logger: quietLogger });

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table control_requests, scores, jobs, companies, profile_snapshots, ai_usage, applications restart identity cascade`);
});

afterEach(() => resetControlHandlers());

afterAll(async () => {
  await getDb().execute(sql`truncate table scores, jobs, companies, profile_snapshots, ai_usage, applications restart identity cascade`);
  await closeDb();
});

describe("the rescore_stale control request", () => {
  it.each([1, 0])("stops between jobs at its %i minute budget; zero leaves the run unlimited", async (minutes) => {
    await staleJobs();
    let now = NOW.getTime();
    const fake = fakeAi(null, () => { now += 60_000; });
    const config = aiConfig((raw) => { raw.cycle_budget_minutes = minutes; (raw.scoring as Record<string, unknown>).concurrency = 1; });
    registerControlHandler("rescore_stale", createRescoreStaleHandler({ createDeps: () => ({ ...deps(fake.router), config, now: () => new Date(now) }) }));
    await insertControlRequest(getDb(), { kind: "rescore_stale" });
    const done = await processNextControlRequest(pollOptions());
    expect(done).toMatchObject({ status: "done", result: { scored: minutes ? 1 : 2, failed: 0, remaining: minutes ? 1 : 0, ...(minutes ? { stopped: "time_budget" } : {}) } });
    expect(fake.calls).toHaveLength(minutes ? 1 : 2);
    if (!minutes) expect(done?.result).not.toHaveProperty("stopped");
    expect((await loadControlStatus(getDb())).requests[0]).toMatchObject({ remaining: minutes ? 1 : 0, ...(minutes ? { stopped: "time_budget" } : {}) });
  });

  it("expires during setup without starting a score or counting a failure", async () => {
    await staleJobs();
    let now = NOW.getTime();
    const fake = fakeAi();
    const config = aiConfig((raw) => { raw.cycle_budget_minutes = 1; });
    registerControlHandler("rescore_stale", createRescoreStaleHandler({ createDeps: () => ({ ...deps(fake.router, async () => { now += 60_000; return profile(); }), config, now: () => new Date(now) }) }));
    await insertControlRequest(getDb(), { kind: "rescore_stale" });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "failed", result: { error: "rescore_stopped", stopped: "time_budget", scored: 0, failed: 0, remaining: 2 } });
    expect(fake.calls).toHaveLength(0);
  });

  it("without the runner's handler nothing re-scores: the default only acknowledges", async () => {
    await staleJobs();
    await insertControlRequest(getDb(), { kind: "rescore_stale" });
    expect(await processNextControlRequest(pollOptions())).toMatchObject({ status: "done", result: { scored: 0, failed: 0, placeholder: true } });
    expect(await countStaleScores(getDb())).toBe(2);
  });

  it("re-scores the stale scores through rescoreStale and reports scored / failed", async () => {
    const fake = fakeAi();
    registerControlHandler("rescore_stale", createRescoreStaleHandler({ createDeps: () => deps(fake.router) }));
    const ids = await staleJobs();

    const queued = await requestRescoreStale();
    expect(queued).toMatchObject({ status: "queued", kind: "rescore_stale", existing: false });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ status: "done", result: { scored: 2, failed: 0, remaining: 0, placeholder: false } });
    expect(await countStaleScores(getDb())).toBe(0);
    for (const id of ids) {
      const rows = await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, id));
      expect(rows.every((r) => !r.stale && r.score === 77)).toBe(true);
    }

    // the settings page sees the outcome and the new stale count
    const status = await loadControlStatus(getDb());
    expect(status.staleScores).toBe(0);
    expect(status.requests[0]).toMatchObject({ kind: "rescore_stale", status: "done", scored: 2, failed: 0, placeholder: false });
  });

  it("every posting failing fails the request with a code instead of a zero", async () => {
    const fake = fakeAi(new AiProviderError("claude-cli", "auth", "login expired"));
    registerControlHandler("rescore_stale", createRescoreStaleHandler({ createDeps: () => deps(fake.router) }));
    await staleJobs();
    await insertControlRequest(getDb(), { kind: "rescore_stale" });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished).toMatchObject({ status: "failed", result: { scored: 0, error: "rescore_ai_unavailable" } });
    expect((finished?.result as { failed: number }).failed).toBeGreaterThan(0);
    expect(await countStaleScores(getDb())).toBe(2);
    const status = await loadControlStatus(getDb());
    expect(status.requests[0]).toMatchObject({ status: "failed", error: "rescore_ai_unavailable" });
  });

  it("an unusable profile stops the run: reported as not started", async () => {
    const fake = fakeAi();
    const empty = async (): Promise<ScoringProfile> => ({ ...profile(), me: exampleMe((raw) => { raw.summary = ""; raw.skills = []; }) });
    registerControlHandler("rescore_stale", createRescoreStaleHandler({ createDeps: () => deps(fake.router, empty) }));
    await staleJobs();
    await insertControlRequest(getDb(), { kind: "rescore_stale" });
    const finished = await processNextControlRequest(pollOptions());
    expect(finished?.status).toBe("failed");
    expect(finished?.result).toMatchObject({ scored: 0, error: "rescore_profile_incomplete", profileMissing: ["summary", "skills"] });
    expect(fake.calls).toEqual([]);
  });
});
