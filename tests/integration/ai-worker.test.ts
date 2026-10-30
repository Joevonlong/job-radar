import { withRebuiltCurrentScores } from "../helpers/current-scores";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { stringify } from "yaml";

import { AiProviderError } from "@/lib/ai/errors";
import { createProvider } from "@/lib/ai/provider";
import { createDbQuotaStore } from "@/lib/ai/quota-guard";
import { createAiRouter } from "@/lib/ai/router";
import { createAiStep, registerAiSubtask, resetAiSubtasks } from "@/lib/ai/step";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import { createDbUsageStore } from "@/lib/ai/usage";
import { ChannelRegistry } from "@/lib/channels/registry";
import { aiWorkerRequestKinds, processNextControlRequest, registerControlHandler, resetControlHandlers, runnerRequestKinds, startControlLanes } from "@/lib/control";
import { createRunAiHandler } from "@/lib/control/run-ai";
import { requestRescoreStale } from "@/lib/control/service";
import { createTranslateJobHandler } from "@/lib/control/translate-job";
import { readTranslateRequest, requestTranslateJob } from "@/lib/control/translate-request";
import { registerBuiltinAiSubtasks, registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { createDelegatingAiStep, createDelegatingNotifyStep } from "@/lib/cycle/delegate";
import { runCycle } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps, type CycleStepFn } from "@/lib/cycle/steps";
import {
  claimNextControlRequest,
  closeDb,
  createCycle,
  finishCycle,
  getControlRequest,
  getCycle,
  getDb,
  insertControlRequest,
  requeueInterruptedControlRequests,
  schema,
  writeHeartbeat,
} from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createNotifyStep } from "@/lib/notify/step";
import { createTelegramClient } from "@/lib/notify/telegram-client";
import { loadAiWorkerStatus } from "@/lib/ops/ai-worker";
import { currentPreferencesSnapshotId, type ScoringProfile } from "@/lib/scoring";
import { loadConfig } from "@/lib/config";

import { aiConfig, answer, exampleMe, examplePreferences } from "../scoring/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { FakeBotApi, FAKE_TOKEN } from "../notify/fake-bot-api";
import { notifyConfig } from "../notify/helpers";

const url = inject("testDatabaseUrl");
const CHAT = "555";
const api = new FakeBotApi();
const db = () => getDb();
let temp: TempConfig;

const TABLES = "control_requests, scores, jobs, companies, profile_snapshots, ai_usage, applications, translations, signals, notifications, cycles, runs, channels, raw_postings, runner_heartbeats";
const resetTables = () => db().execute(sql.raw(`truncate table ${TABLES} restart identity cascade`));

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
  await api.start();
});

beforeEach(async () => {
  temp = makeTempConfig();
  fs.mkdirSync(temp.profileDir, { recursive: true });
  fs.writeFileSync(path.join(temp.profileDir, "me.yaml"), stringify(exampleMe()));
  fs.writeFileSync(path.join(temp.profileDir, "preferences.yaml"), stringify(examplePreferences()));
  await resetTables();
  api.reset();
});

afterEach(() => {
  temp.cleanup();
  resetControlHandlers();
  resetCycleSteps();
  resetAiSubtasks();
});

afterAll(async () => {
  await api.stop();
  await resetTables();
  await closeDb();
});

// ---------------------------------------------------------------- fakes

/** A subscription CLI that answers every task, or fails when told to; records which tasks it was asked. */
function fakeAi(options: { fail?: Error; onCall?: (task: string) => void } = {}) {
  const tasks: string[] = [];
  let pushedBeforeTranslate: number | undefined;
  const transport: AiTransport = {
    id: "claude-cli",
    availability: () => ({ available: true }),
    async call(request: AiTransportRequest) {
      tasks.push(request.task);
      options.onCall?.(request.task);
      if (options.fail) throw options.fail;
      if (request.task === "score") return { text: answer({ score: 77 }), model: "fake-model", usage: { tokensIn: 100, tokensOut: 20 } };
      if (request.task === "translate") {
        // The push must already be out when translation starts
        pushedBeforeTranslate ??= api.of("sendMessage").length;
      }
      if (request.task === "translate") return { text: JSON.stringify({ translation: "这是岗位描述的中文翻译，内容完整，没有省略任何要求和福利。".repeat(3) }), model: "fake-model", usage: { tokensIn: 50, tokensOut: 50 } };
      if (request.task === "signals") return { text: JSON.stringify({ signals: [], rejected: [] }), model: "fake-model", usage: { tokensIn: 30, tokensOut: 5 } };
      throw new Error(`unexpected AI task ${request.task}`);
    },
  };
  const provider = createProvider(transport);
  return { tasks, provider, pushedBeforeTranslate: () => pushedBeforeTranslate, router: createAiRouter({ config: aiConfig(), providers: [provider], usage: null }) };
}

const notifyCfg = () =>
  notifyConfig((c) => {
    Object.assign(c.telegram, { enabled: true, api_base_url: api.url, message_gap_ms: 0, max_retries: 0, poll_timeout_seconds: 1 });
    Object.assign(c.quiet_hours, { enabled: false });
  });
const telegram = () => createTelegramClient({ token: FAKE_TOKEN, baseUrl: api.url, requestTimeoutMs: 3000, maxRetries: 0, sleep: async () => {} });

function workerSteps(ai: ReturnType<typeof fakeAi>, config = aiConfig()) {
  return {
    // like the real worker: the part the push needs, then the push, then the late sub-tasks (translation)
    ai: createAiStep({ createRouter: () => ai.router, loadAiConfig: () => config, phase: "main" }),
    late: createAiStep({ createRouter: () => ai.router, loadAiConfig: () => config, phase: "late" }),
    notify: createNotifyStep({ loadNotifyConfig: notifyCfg, createRuntime: () => ({ client: telegram(), chatId: CHAT }), sleep: async () => {} }),
  };
}

const profile = (): ScoringProfile => ({ me: exampleMe(), preferences: examplePreferences(), meYaml: stringify(exampleMe()), preferencesYaml: stringify(examplePreferences()) });

/** A job that passed the hard filter and waits for its score, first seen a minute from now so it counts as new in the cycle. */
async function addJob(title: string, description = `We are hiring a ${title} to build retrieval and evaluation systems for our product, remote friendly.`): Promise<number> {
  const [company] = await db().insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title.toLowerCase()}` }).returning();
  const [job] = await db()
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description, language: "en", firstSeenAt: new Date(Date.now() + 60_000) })
    .returning();
  const snapshotId = await currentPreferencesSnapshotId(db(), profile());
  await withRebuiltCurrentScores(db(), db().insert(schema.scores).values({ jobId: job!.id, profileSnapshotId: snapshotId, filterResult: "passed" }));
  return job!.id;
}

const pollOptions = (kinds: () => ReturnType<typeof aiWorkerRequestKinds>) => ({ db: db(), signal: new AbortController().signal, logger: quietLogger, kinds });
const hostWorker = () => pollOptions(() => aiWorkerRequestKinds("host"));

describe("worker control lanes and shutdown", () => {
  it.each(["breakdown_job", "test_ai", "salary_lookup"] as const)("abort waits for both lanes and applies the requeue policy by id: %s", async (kind) => {
    const batch = await insertControlRequest(db(), { kind: "run_ai" });
    const interactive = await insertControlRequest(db(), { kind });
    const batchStarted = Promise.withResolvers<void>();
    const interactiveStarted = Promise.withResolvers<void>();
    const abort = new AbortController();
    for (const [requestKind, started] of [["run_ai", batchStarted], [kind, interactiveStarted]] as const) {
      registerControlHandler(requestKind, async (_request, { signal }) => {
        started.resolve();
        await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
        return { status: "failed", result: { error: "aborted" } };
      });
    }
    const poller = startControlLanes({ ...hostWorker(), signal: abort.signal, maxRequeues: () => 3, pollSeconds: () => 1 });
    try {
      await Promise.all([batchStarted.promise, interactiveStarted.promise]);
    } finally {
      abort.abort();
      await poller;
    }
    expect(await getControlRequest(db(), batch.id)).toMatchObject({ status: "pending", startedAt: null, result: { interruptions: 1 } });
    expect(await getControlRequest(db(), interactive.id)).toMatchObject(kind === "breakdown_job"
      ? { status: "pending", startedAt: null, result: { interruptions: 1 } }
      : { status: "failed", result: { error: "aborted" } });
  });

  it("the once-mode drain still processes all kinds in id order without lane selection", async () => {
    const rows = [];
    for (const kind of ["run_ai", "translate_job", "score_jobs", "breakdown_job"] as const) {
      registerControlHandler(kind, async () => ({ status: "done", result: {} }));
      rows.push(await insertControlRequest(db(), { kind }));
    }
    for (const row of rows) expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: row.id, status: "done" });
    expect(await processNextControlRequest(hostWorker())).toBeNull();
  });
});

/** Registers exactly what the container runner registers for `ai` + `notify` and runs one cycle without channels. */
async function runnerCycle() {
  registerBuiltinCycleSteps();
  return runCycle("manual", { registry: new ChannelRegistry(), config: cycleConfig(), logger: quietLogger, sleep: async () => {} });
}

async function queueFinishedCycle(startedAt: Date) {
  const cycle = await createCycle(db(), { kind: "manual", startedAt });
  await finishCycle(db(), cycle.id, { status: "succeeded", summary: { steps: [] } });
  const request = await insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: cycle.id } });
  return { cycle, request };
}

// ---------------------------------------------------------------- the runner side

describe("execution: host — the container runner delegates", () => {
  it("ends a cycle with a run_ai request instead of running ai and notify, and never reaches a provider or Telegram", async () => {
    const ai = fakeAi();
    await addJob("Alpha");
    const result = await runnerCycle();

    expect(result.status).toBe("succeeded");
    const requests = await db().select().from(schema.controlRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "run_ai", status: "pending", payload: { cycleId: result.cycleId } });
    const step = (name: string) => result.summary.steps.find((s) => s.name === name);
    expect(step("ai")).toMatchObject({ status: "ok", result: { delegated: true, to: "ai-worker", requestId: requests[0]!.id } });
    expect(step("notify")).toMatchObject({ status: "ok", result: { delegated: true, to: "ai-worker", requestId: requests[0]!.id } });
    expect(ai.tasks).toEqual([]);
    expect(api.of("sendMessage")).toHaveLength(0);
    // the stored summary says the same
    const stored = await getCycle(db(), result.cycleId!);
    expect(JSON.stringify(stored?.summaryJson)).toContain('"delegated":true');
  });

  it("runs the steps itself with execution: container (no request)", async () => {
    const ran: string[] = [];
    const local = (name: string): CycleStepFn => async () => {
      ran.push(name);
    };
    const container = () => ({ ...aiConfig(), execution: "container" as const });
    registerCycleStep("ai", createDelegatingAiStep(local("ai"), { loadAiConfig: container }));
    registerCycleStep("notify", createDelegatingNotifyStep(local("notify"), { loadAiConfig: container }));
    await runCycle("manual", { registry: new ChannelRegistry(), config: cycleConfig(), logger: quietLogger, sleep: async () => {} });
    expect(ran).toEqual(["ai", "notify"]);
    expect(await db().select().from(schema.controlRequests)).toHaveLength(0);
  });

  it("a cycle whose ai step cannot queue the request marks notify partial", async () => {
    const failingInsert = createDelegatingAiStep(async () => undefined, { loadAiConfig: () => aiConfig() });
    registerCycleStep("ai", async (ctx) => failingInsert({ ...ctx, db: null }));
    registerCycleStep("notify", createDelegatingNotifyStep(async () => undefined, { loadAiConfig: () => aiConfig() }));
    const result = await runCycle("manual", { registry: new ChannelRegistry(), config: cycleConfig(), logger: quietLogger, sleep: async () => {} });
    expect(result.summary.steps.find((s) => s.name === "notify")).toMatchObject({ status: "partial", result: { skipped: "no_request" } });
  });
});

// ---------------------------------------------------------------- who claims what

describe("request kinds", () => {
  it("each process claims only its own kinds", async () => {
    const run = await insertControlRequest(db(), { kind: "run_cycle" });
    const ai = await insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: 999 } });
    const translate = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1 } });
    const rescore = await insertControlRequest(db(), { kind: "rescore_stale" });

    // runner, host mode: only the cycle
    expect((await claimNextControlRequest(db(), runnerRequestKinds("host")))?.id).toBe(run.id);
    expect(await claimNextControlRequest(db(), runnerRequestKinds("host"))).toBeNull();
    // worker, host mode: the three AI kinds, oldest first
    const claimed = [await claimNextControlRequest(db(), aiWorkerRequestKinds("host")), await claimNextControlRequest(db(), aiWorkerRequestKinds("host")), await claimNextControlRequest(db(), aiWorkerRequestKinds("host"))];
    expect(claimed.map((r) => r?.id)).toEqual([ai.id, translate.id, rescore.id]);
    expect(await claimNextControlRequest(db(), aiWorkerRequestKinds("host"))).toBeNull();
  });

  it("with execution: container the runner takes the web's AI work and the worker only run_ai", async () => {
    await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1 } });
    await insertControlRequest(db(), { kind: "rescore_stale" });
    expect(await claimNextControlRequest(db(), aiWorkerRequestKinds("container"))).toBeNull();
    expect((await claimNextControlRequest(db(), runnerRequestKinds("container")))?.kind).toBe("translate_job");
    expect((await claimNextControlRequest(db(), runnerRequestKinds("container")))?.kind).toBe("rescore_stale");
  });

  it("a restart queues again only the restarting process's running requests", async () => {
    const mine = await insertControlRequest(db(), { kind: "test_channel", payload: { channelId: "indeed" } });
    const theirs = await insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: 1 } });
    await db().update(schema.controlRequests).set({ status: "running" });
    expect(await requeueInterruptedControlRequests(db(), { reason: "restarted", maxRequeues: 3, kinds: runnerRequestKinds("host") })).toEqual({ requeued: 0, failed: 1 });
    expect(await getControlRequest(db(), mine.id)).toMatchObject({ status: "failed", result: { error: "restarted" } });
    expect((await getControlRequest(db(), theirs.id))?.status).toBe("running");
    expect(await requeueInterruptedControlRequests(db(), { reason: "restarted", maxRequeues: 3, kinds: aiWorkerRequestKinds("host") })).toEqual({ requeued: 1, failed: 0 });
    expect((await getControlRequest(db(), theirs.id))?.status).toBe("pending");
  });

  it("a run_ai request waits until its cycle has finished", async () => {
    const cycle = await createCycle(db(), { kind: "manual" });
    await insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: cycle.id } });
    expect(await claimNextControlRequest(db(), ["run_ai"])).toBeNull();
    await finishCycle(db(), cycle.id, { status: "succeeded", summary: { steps: [] } });
    expect((await claimNextControlRequest(db(), ["run_ai"]))?.kind).toBe("run_ai");
  });

  it("run_ai and translate_job have no handler until the worker registers one", async () => {
    await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1 } });
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ status: "failed", result: { error: "no_handler" } });
  });
});

// ---------------------------------------------------------------- the worker side

describe("the ai-worker handles run_ai", () => {
  it("drains two slow failed digests and a new translation in normal order, then exits the once loop", async () => {
    const config = aiConfig();
    fs.writeFileSync(path.join(temp.configDir, "ai.yaml"), stringify({ ...config, host_worker: { ...config.host_worker, poll_seconds: 1 } }));
    expect(loadConfig("ai").host_worker.poll_seconds).toBe(1);
    const ai = fakeAi();
    const steps = workerSteps(ai);
    let attempts = 0;
    steps.notify = createNotifyStep({
      loadNotifyConfig: notifyCfg,
      createRuntime: () => ({ chatId: CHAT, client: { ...telegram(), sendMessage: async () => {
        attempts += 1;
        await sleep(1_100); // longer than the old requeue interval
        throw new Error("slow digest failure");
      } } }),
    });
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps, registry: new ChannelRegistry() }));
    registerControlHandler("translate_job", createTranslateJobHandler({ createRouter: () => ai.router }));
    const first = await queueFinishedCycle(new Date());
    const handled = [(await processNextControlRequest(hostWorker()))?.id];
    const second = await queueFinishedCycle(new Date());
    const jobId = await addJob("Translation");
    const translate = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId, force: true } });
    let drained = false;
    // The production --once drain loop, bounded so the regression fails instead of hanging the suite.
    for (let i = 0; i < 4; i += 1) {
      const next = await processNextControlRequest(hostWorker());
      if (next === null) { drained = true; break; }
      handled.push(next.id);
    }
    expect(handled).toEqual([first.request.id, second.request.id, translate.id]);
    expect(drained).toBe(true);
    expect(attempts).toBe(2);
    expect(await getControlRequest(db(), translate.id)).toMatchObject({ status: "done" });
    expect(await db().select().from(schema.translations)).toHaveLength(1);
    expect(ai.tasks.filter((task) => task === "translate")).toHaveLength(2); // automatic work, then the forced request
  });

  it("settles a failed digest when its successor delivers the inherited window, with no later duplicate", async () => {
    const now = new Date();
    const first = await queueFinishedCycle(new Date(now.getTime() - 3_600_000));
    await addJob("Alpha");
    const ai = fakeAi();
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(ai), registry: new ChannelRegistry(), now: () => now }));
    api.failNext("sendMessage", 500);
    await processNextControlRequest(hostWorker());
    const completedTasks = [...ai.tasks];
    const successor = await queueFinishedCycle(now);
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: successor.request.id, status: "done", result: { notify: { pushed: 1 } } });
    // Even after the old retry time, a completed predecessor must never be claimed or send again.
    await db().update(schema.controlRequests).set({ result: sql`${schema.controlRequests.result} - 'notifyRetryAt'` }).where(eq(schema.controlRequests.id, first.request.id));
    expect(await processNextControlRequest(hostWorker())).toBeNull();
    expect(await getControlRequest(db(), first.request.id)).toMatchObject({ status: "done", result: { notify: { pending: false, deliveredByCycleId: successor.cycle.id } } });
    expect(ai.tasks).toEqual(completedTasks);
    const notifications = await db().select().from(schema.notifications);
    expect(notifications.filter((n) => n.kind === "cycle_summary")).toMatchObject([{ cycleId: successor.cycle.id, payloadJson: { newJobs: 1, pushed: 1 } }]);
    expect(notifications.filter((n) => n.kind === "job")).toHaveLength(1);
    expect(api.of("sendMessage")).toHaveLength(3); // one failure, one summary, one card
  });

  it("delivers a failed last request once in the next cycle's notify after the candidate window expires", async () => {
    let now = new Date();
    const first = await queueFinishedCycle(new Date(now.getTime() - 3_600_000));
    const jobId = await addJob("Alpha");
    await db().update(schema.jobs).set({ firstSeenAt: new Date(now.getTime() - 30 * 60_000) }).where(eq(schema.jobs.id, jobId));
    const ai = fakeAi();
    const steps = workerSteps(ai);
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps, registry: new ChannelRegistry(), now: () => now }));
    api.failNext("sendMessage", 500);
    await processNextControlRequest(hostWorker());
    expect(await processNextControlRequest(hostWorker())).toBeNull();
    const completedTasks = [...ai.tasks];
    now = new Date(now.getTime() + (notifyCfg().candidate_window_hours + 1) * 3_600_000);
    // A later container notify must inherit the durable window too, without claiming the old request.
    registerCycleStep("ai", async () => {});
    registerCycleStep("notify", steps.notify);
    const next = await runCycle("manual", { registry: new ChannelRegistry(), config: cycleConfig(), logger: quietLogger, now: () => now, sleep: async () => {} });
    expect(next.results.notify).toMatchObject({ jobs: { newJobs: 1, pushed: 1 } });
    expect(await getControlRequest(db(), first.request.id)).toMatchObject({ status: "done", result: { notify: { pending: false, deliveredByCycleId: next.cycleId } } });
    expect(ai.tasks).toEqual(completedTasks);
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary")).toHaveLength(1);
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "job")).toHaveLength(1);
    expect(api.of("sendMessage")).toHaveLength(3);
    // An inline delivery must also advance the next delegated digest's "new jobs" boundary.
    const following = await queueFinishedCycle(new Date(now.getTime() + 60_000));
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: following.request.id, status: "done" });
    const summaries = (await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary");
    expect(summaries).toHaveLength(2);
    expect(summaries.find((n) => n.cycleId === following.cycle.id)?.payloadJson).toMatchObject({ newJobs: 0, pushed: 0 });
  });

  it.each(["quiet_hours", "newer_cycle_pending"])("retains a deferred window beyond expiry (%s)", async (reason) => {
    let now = new Date("2026-10-20T12:00:00Z");
    const first = await queueFinishedCycle(new Date(now.getTime() - 3_600_000));
    const jobId = await addJob("Deferred");
    await db().update(schema.jobs).set({ firstSeenAt: new Date(now.getTime() - 30 * 60_000) }).where(eq(schema.jobs.id, jobId));
    const successor = reason === "newer_cycle_pending" ? await queueFinishedCycle(now) : null;
    const ai = fakeAi();
    const steps = workerSteps(ai);
    const deferred = createNotifyStep({
      loadNotifyConfig: () => {
        const config = notifyCfg();
        if (reason === "quiet_hours") Object.assign(config.quiet_hours, { enabled: true, start: "00:00", end: "23:59" });
        return config;
      },
      createRuntime: () => ({ client: telegram(), chatId: CHAT }),
    });
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: { ...steps, notify: deferred }, registry: new ChannelRegistry(), now: () => now }));
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: first.request.id, status: "done", result: { notify: { pending: true } } });
    expect(api.of("sendMessage")).toHaveLength(0);
    now = new Date(now.getTime() + (notifyCfg().candidate_window_hours + 1) * 3_600_000);
    const next = successor ?? await queueFinishedCycle(now);
    registerControlHandler("run_ai", createRunAiHandler({ steps, registry: new ChannelRegistry(), now: () => now }));
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: next.request.id, status: "done", result: { notify: { pushed: 1 } } });
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary")).toMatchObject([{ payloadJson: { newJobs: 1, pushed: 1 } }]);
    expect(await getControlRequest(db(), first.request.id)).toMatchObject({ status: "done", result: { notify: { pending: false, deliveredByCycleId: next.cycle.id } } });
    expect(await db().execute(sql`select key from runtime_state where key like 'notify:window:%'`)).toHaveLength(0);
  });

  it("lets candidates expire while Telegram is unconfigured", async () => {
    let now = new Date();
    const first = await queueFinishedCycle(new Date(now.getTime() - 3_600_000));
    const jobId = await addJob("Expired");
    await db().update(schema.jobs).set({ firstSeenAt: new Date(now.getTime() - 30 * 60_000) }).where(eq(schema.jobs.id, jobId));
    const steps = workerSteps(fakeAi());
    const unconfigured = createNotifyStep({ loadNotifyConfig: notifyCfg, createRuntime: () => null });
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: { ...steps, notify: unconfigured }, registry: new ChannelRegistry(), now: () => now }));
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: first.request.id, status: "done", result: { notify: { pending: false } } });
    expect(api.of("sendMessage")).toHaveLength(0);
    expect(await db().execute(sql`select key from runtime_state where key like 'notify:window:%'`)).toHaveLength(0);

    now = new Date(now.getTime() + (notifyCfg().candidate_window_hours + 1) * 3_600_000);
    const next = await queueFinishedCycle(now);
    registerControlHandler("run_ai", createRunAiHandler({ steps, registry: new ChannelRegistry(), now: () => now }));
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: next.request.id, status: "done", result: { notify: { pushed: 0 } } });
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "job")).toHaveLength(0);
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary")).toMatchObject([{ payloadJson: { newJobs: 0, pushed: 0 } }]);
  });

  it("sends the last claimable cycle's digest while a newer cycle is still running", async () => {
    const now = new Date();
    const current = await queueFinishedCycle(new Date(now.getTime() - 3_600_000));
    const collecting = await createCycle(db(), { kind: "manual", startedAt: now });
    const waiting = await insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: collecting.id } });
    await addJob("Alpha");
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(fakeAi()), registry: new ChannelRegistry(), now: () => now }));

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: current.request.id, status: "done", result: { notify: { pushed: 1 } } });
    expect(await processNextControlRequest(hostWorker())).toBeNull(); // the same drain loop as --once
    expect((await getControlRequest(db(), waiting.id))?.status).toBe("pending");
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary")).toMatchObject([{ cycleId: current.cycle.id }]);
    expect(api.of("sendMessage")).toHaveLength(2);
  });

  it("ignores legacy retry timestamps and processes the successor in normal order", async () => {
    const now = new Date();
    const current = await queueFinishedCycle(new Date(now.getTime() - 2 * 3_600_000));
    const successor = await queueFinishedCycle(new Date(now.getTime() - 3_600_000));
    await db().update(schema.controlRequests).set({ result: { notifyRetryAt: Date.now() + 3_600_000 } }).where(eq(schema.controlRequests.id, successor.request.id));
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(fakeAi()), registry: new ChannelRegistry(), now: () => now }));

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: current.request.id, status: "done", result: { notify: { pending: true } } });
    expect(api.of("sendMessage")).toHaveLength(0);
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: successor.request.id, status: "done", result: { notify: { pending: false } } });
    expect(api.of("sendMessage")).toHaveLength(1);
    expect(await processNextControlRequest(hostWorker())).toBeNull();
  });

  it.each([false, true])("retains a failed backlog through another failed notify and a worker restart (delegated successor: %s)", async (delegated) => {
    let now = new Date();
    const first = await queueFinishedCycle(new Date(now.getTime() - 2 * 3_600_000));
    const latest = await queueFinishedCycle(new Date(now.getTime() - 3_600_000));
    const jobs = [await addJob("Alpha"), await addJob("Beta")];
    for (const [index, id] of jobs.entries()) await db().update(schema.jobs).set({ firstSeenAt: new Date(now.getTime() - (index === 0 ? 90 : 30) * 60_000) }).where(eq(schema.jobs.id, id));
    const ai = fakeAi();
    const config = { ...aiConfig(), per_cycle_limit: 1 };
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(ai, config), registry: new ChannelRegistry(), now: () => now }));

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: first.request.id, status: "done", result: { ai: { scored: 1 } } });
    expect(api.of("sendMessage")).toHaveLength(0);
    api.failNext("sendMessage", 500, undefined, 2);
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: latest.request.id, status: "done", startedAt: expect.any(Date), finishedAt: expect.any(Date), result: { ai: { scored: 1, translated: 1 }, notify: { status: "partial", pending: true } } });
    const completedTasks = [...ai.tasks];
    expect(completedTasks.filter((task) => task === "score")).toHaveLength(2);
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary")).toHaveLength(0);
    expect(await processNextControlRequest(hostWorker())).toBeNull(); // --once exits with the delivery window retained

    now = new Date(now.getTime() + (notifyCfg().candidate_window_hours + 1) * 3_600_000);
    // Rebuild the worker with a provider that rejects any repeated completed work.
    const restartedAi = fakeAi({ fail: new Error("completed AI must not run again") });
    resetControlHandlers();
    const steps = workerSteps(restartedAi, config);
    registerControlHandler("run_ai", createRunAiHandler({ steps, registry: new ChannelRegistry(), now: () => now }));
    const nextNotify = async () => {
      if (delegated) {
        const successor = await queueFinishedCycle(now);
        await processNextControlRequest(hostWorker());
        return successor.cycle.id;
      }
      registerCycleStep("ai", async () => {});
      registerCycleStep("notify", steps.notify);
      const cycle = await runCycle("manual", { registry: new ChannelRegistry(), config: cycleConfig(), logger: quietLogger, now: () => now, sleep: async () => {} });
      return cycle.cycleId!;
    };
    await nextNotify(); // the second send fails too; it must retain the whole original backlog
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary")).toHaveLength(0);
    const deliveredBy = await nextNotify();
    for (const request of [first.request, latest.request]) {
      expect(await getControlRequest(db(), request.id)).toMatchObject({ status: "done", result: { notify: { pending: false, deliveredByCycleId: deliveredBy } } });
    }
    expect(ai.tasks).toEqual(completedTasks);
    expect(restartedAi.tasks).toEqual([]);
    const notifications = await db().select().from(schema.notifications);
    expect(notifications.filter((n) => n.kind === "cycle_summary")).toMatchObject([{ cycleId: deliveredBy, payloadJson: { newJobs: 2, pushed: 2 } }]);
    expect(notifications.filter((n) => n.kind === "job")).toHaveLength(2);
    expect(api.of("sendMessage")).toHaveLength(5); // two failures, then a summary and two jobs
    expect(await processNextControlRequest(hostWorker())).toBeNull();
    expect(await db().execute(sql`select key from runtime_state where key like 'notify:window:%'`)).toHaveLength(0);
  });

  it.each([false, true])("resumes unfinished translation after an interrupted digest without repeating completed main AI (send failed: %s)", async (sendFailed) => {
    const shutdown = new AbortController();
    const ai = fakeAi();
    await addJob("Alpha");
    await queueFinishedCycle(new Date());
    registerBuiltinAiSubtasks();
    const steps = workerSteps(ai);
    registerControlHandler("run_ai", createRunAiHandler({
      registry: new ChannelRegistry(),
      steps: { ...steps, notify: async (ctx) => {
        const result = await steps.notify(ctx);
        shutdown.abort();
        return result;
      } },
    }));
    if (sendFailed) api.failNext("sendMessage", 500);

    expect(await processNextControlRequest({ ...hostWorker(), signal: shutdown.signal, maxRequeues: () => 3 })).toMatchObject({ status: "pending" });
    expect(ai.tasks.filter((task) => task === "score")).toHaveLength(1);
    expect(ai.tasks.filter((task) => task === "translate")).toHaveLength(0);
    const restartedAi = fakeAi();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(restartedAi), registry: new ChannelRegistry() }));
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ status: "done", result: { ai: { scored: 1, translated: 1 }, notify: { status: "ok", pending: false } } });
    expect(restartedAi.tasks).toEqual(["translate"]);
    expect(await db().select().from(schema.translations)).toHaveLength(1);
  });

  it("retains a failed empty digest for the next notify even when no job failures can be counted", async () => {
    const current = await queueFinishedCycle(new Date());
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(fakeAi()), registry: new ChannelRegistry() }));
    api.failNext("sendMessage", 500);

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: current.request.id, status: "done", result: { notify: { pending: true } } });
    expect(await processNextControlRequest(hostWorker())).toBeNull();
    const successor = await queueFinishedCycle(new Date());
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: successor.request.id, status: "done", result: { notify: { status: "ok", pushed: 0, pending: false } } });
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary")).toHaveLength(1);
  });

  it("resumes main AI when shutdown interrupted it before completion", async () => {
    const shutdown = new AbortController();
    const ai = fakeAi();
    await addJob("Interrupted");
    await queueFinishedCycle(new Date());
    const steps = workerSteps(ai);
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({
      steps: { ...steps, ai: async () => { shutdown.abort(); return { status: "partial", result: { subtasks: [] } }; } },
      registry: new ChannelRegistry(),
    }));
    expect(await processNextControlRequest({ ...hostWorker(), signal: shutdown.signal, maxRequeues: () => 3 })).toMatchObject({ status: "pending" });
    expect(ai.tasks).toEqual([]);
    registerControlHandler("run_ai", createRunAiHandler({ steps, registry: new ChannelRegistry() }));
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ status: "done", result: { ai: { scored: 1, translated: 1 } } });
    expect(ai.tasks.filter((task) => task === "score")).toHaveLength(1);
  });

  it("counts earlier backlog calls against a later historical cycle's real per-cycle quota", async () => {
    let now = new Date();
    const first = await queueFinishedCycle(new Date(now.getTime() - 2 * 3_600_000));
    const latest = await queueFinishedCycle(new Date(now.getTime() - 3_600_000));
    await addJob("Alpha");
    await addJob("Beta");
    const config = aiConfig((raw) => {
      raw.per_cycle_limit = 1;
      raw.order = ["claude-cli"];
      raw.quota_guard = { enabled: true, providers: { claude_cli: { hard_requests: 0, cycle_request_cap: 1 } } };
    });
    const ai = fakeAi();
    const phase = (phase: "main" | "late") => createAiStep({
      phase,
      loadAiConfig: () => config,
      createRouter: (ctx, cfg, limits) => createAiRouter({
        config: cfg,
        providers: [ai.provider],
        usage: createDbUsageStore(db()),
        quota: createDbQuotaStore(db()),
        cycleStartedAt: limits.cycleStartedAt,
        deadline: limits.deadline,
        now: ctx.now,
      }),
    });
    const steps = { ...workerSteps(ai, config), ai: phase("main"), late: phase("late") };
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps, registry: new ChannelRegistry(), now: () => now }));

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: first.request.id, status: "done", result: { ai: { scored: 1 } } });
    now = new Date(now.getTime() + 60_000);
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: latest.request.id, status: "done", result: { ai: { scored: null } } });
    expect(ai.tasks).toEqual(["score"]);
    expect(await db().select().from(schema.aiUsage)).toMatchObject([{ task: "score", provider: "claude-cli" }]);
    expect((await db().select().from(schema.scores)).filter((s) => s.score === 77)).toHaveLength(1);
    expect((await getCycle(db(), latest.cycle.id))?.summaryJson).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ name: "ai", result: expect.objectContaining({ skipped: "quota_guard", guards: [{ provider: "claude-cli", reason: "cycle_cap", resumeAt: null }] }) })]) });

    now = new Date(now.getTime() + 60_000);
    const next = await queueFinishedCycle(now); // the earlier call is before this new cycle's boundary
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: next.request.id, status: "done", result: { ai: { scored: 1 } } });
    expect(ai.tasks).toEqual(["score", "score"]);
    expect(await db().select().from(schema.aiUsage)).toHaveLength(2);
  });

  it.each(["string id", "extra field"])("does not defer a valid digest to a newer request with an invalid payload (%s)", async (invalid) => {
    const now = new Date("2026-10-20T12:00:00Z");
    const current = await queueFinishedCycle(now);
    await insertControlRequest(db(), {
      kind: "run_ai",
      payload: invalid === "string id" ? { cycleId: String(current.cycle.id) } : { cycleId: current.cycle.id, unexpected: true },
    });
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(fakeAi()), registry: new ChannelRegistry(), now: () => now }));

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: current.request.id, status: "done" });
    expect((await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary")).toMatchObject([{ cycleId: current.cycle.id }]);
    expect(api.of("sendMessage")).toHaveLength(1);
  });

  it("scores every backlogged cycle, sends alerts immediately, and delivers one digest covering the whole backlog", async () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const first = await queueFinishedCycle(new Date("2026-10-20T10:00:00Z"));
    const latest = await queueFinishedCycle(new Date("2026-10-20T11:00:00Z"));
    const jobs = [await addJob("Alpha"), await addJob("Beta")];
    for (const [index, id] of jobs.entries()) await db().update(schema.jobs).set({ firstSeenAt: new Date(`2026-10-20T${index === 0 ? "10" : "11"}:30:00Z`) }).where(eq(schema.jobs.id, id));
    await db().insert(schema.notifications).values({ kind: "alert.backup", payloadJson: { title: "Backup failed", detail: "Example failure" }, sentAt: null });
    const ai = fakeAi();
    const config = { ...aiConfig(), per_cycle_limit: 1 };
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(ai, config), registry: new ChannelRegistry(), now: () => now }));

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: first.request.id, status: "done", result: { ai: { scored: 1 } } });
    const intermediate = await db().select().from(schema.notifications);
    expect(intermediate.filter((n) => n.kind === "cycle_summary")).toHaveLength(0);
    expect(intermediate.find((n) => n.kind === "alert.backup")?.sentAt).toEqual(now);
    expect(api.of("sendMessage")).toHaveLength(1);

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: latest.request.id, status: "done", result: { ai: { scored: 1 }, notify: { pushed: 2 } } });
    expect((await db().select().from(schema.scores)).map((s) => s.score)).toEqual([77, 77]);
    expect(ai.tasks.filter((task) => task === "score")).toHaveLength(2);
    const notifications = await db().select().from(schema.notifications);
    expect(notifications.filter((n) => n.kind === "cycle_summary")).toMatchObject([{ cycleId: latest.cycle.id, payloadJson: { newJobs: 2, pushed: 2 } }]);
    expect(notifications.filter((n) => n.kind === "job")).toHaveLength(2);
    expect(api.of("sendMessage")).toHaveLength(4);
  });

  it("starts the next digest window after the last delivered delegated digest", async () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const previous = await queueFinishedCycle(new Date("2026-10-20T10:00:00Z"));
    await db().update(schema.controlRequests).set({ status: "done" }).where(eq(schema.controlRequests.id, previous.request.id));
    await db().insert(schema.notifications).values({ kind: "cycle_summary", cycleId: previous.cycle.id, sentAt: new Date("2026-10-20T10:45:00Z") });
    const current = await queueFinishedCycle(new Date("2026-10-20T11:00:00Z"));
    const jobs = [await addJob("Earlier"), await addJob("Current")];
    for (const [index, id] of jobs.entries()) await db().update(schema.jobs).set({ firstSeenAt: new Date(`2026-10-20T${index === 0 ? "10" : "11"}:30:00Z`) }).where(eq(schema.jobs.id, id));
    registerBuiltinAiSubtasks();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(fakeAi()), registry: new ChannelRegistry(), now: () => now }));

    expect(await processNextControlRequest(hostWorker())).toMatchObject({ id: current.request.id, status: "done" });
    const summaries = (await db().select().from(schema.notifications)).filter((n) => n.kind === "cycle_summary");
    expect(summaries).toHaveLength(2);
    expect(summaries.find((n) => n.cycleId === current.cycle.id)?.payloadJson).toMatchObject({ newJobs: 1 });
  });

  it("scores, translates and pushes for the delegated cycle and writes both outcomes into its summary", async () => {
    const ai = fakeAi();
    registerBuiltinAiSubtasks();
    const jobs = [await addJob("Alpha"), await addJob("Beta"), await addJob("Gamma")];
    const cycle = await runnerCycle();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(ai), registry: new ChannelRegistry() }));

    const finished = await processNextControlRequest(hostWorker());
    expect(finished).toMatchObject({ kind: "run_ai", status: "done", result: { cycleId: cycle.cycleId, ai: { status: "ok", scored: 3, translated: 3 }, notify: { status: "ok", pushed: 3 } } });

    // scores
    const scores = await db().select().from(schema.scores);
    expect(scores.map((s) => s.score)).toEqual([77, 77, 77]);
    // translations
    const translated = await db().select().from(schema.translations);
    expect(translated.map((t) => t.jobId).sort()).toEqual(jobs.sort());
    // push records: one summary and one message per job
    const kinds = (await db().select().from(schema.notifications)).map((n) => n.kind);
    expect(kinds.filter((k) => k === "cycle_summary")).toHaveLength(1);
    expect(kinds.filter((k) => k === "job")).toHaveLength(3);
    expect(api.of("sendMessage")).toHaveLength(4);
    expect(ai.tasks.filter((t) => t === "score")).toHaveLength(3);
    expect(ai.pushedBeforeTranslate()).toBe(4); // summary + 3 jobs were sent before the first translation call

    // the cycle summary now holds the real ai and notify steps
    const stored = await getCycle(db(), cycle.cycleId!);
    const steps = (stored?.summaryJson as { steps: Array<{ name: string; status: string; result?: Record<string, unknown> }> }).steps;
    const byName = (name: string) => steps.find((s) => s.name === name);
    expect(byName("ai")).toMatchObject({ status: "ok", result: { subtasks: [{ name: "traps", status: "ok" }, { name: "score", status: "ok" }, { name: "signals", status: "ok" }, { name: "translate", status: "ok" }, { name: "breakdown", status: "ok", result: { skipped: "disabled" } }] } });
    expect(byName("notify")?.result).not.toHaveProperty("delegated");
    expect(byName("notify")).toMatchObject({ status: "ok", result: { jobs: { pushed: 3 } } });
    expect(stored?.status).toBe("succeeded");
  });

  it("with every provider down the AI step is partial: the request still reports its counters, the cycle becomes partial and notify still runs", async () => {
    const ai = fakeAi({ fail: new AiProviderError("claude-cli", "auth", "login expired") });
    registerBuiltinAiSubtasks();
    await addJob("Alpha");
    const cycle = await runnerCycle();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(ai), registry: new ChannelRegistry() }));

    const finished = await processNextControlRequest(hostWorker());
    expect(finished).toMatchObject({ status: "done", result: { cycleId: cycle.cycleId, ai: { status: "partial", scored: null } } });
    expect((finished?.result as { ai: { failedSubtasks: number } }).ai.failedSubtasks).toBeGreaterThan(0);
    expect((await getCycle(db(), cycle.cycleId!))?.status).toBe("partial");
    // the push step still ran after the failed AI step (it sends its summary)
    expect((await getCycle(db(), cycle.cycleId!))?.summaryJson).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ name: "notify", status: "ok" })]) });
  });

  it("a run_ai cut off by a restart goes back to the queue and the next worker finishes it without pushing twice", async () => {
    // the 2026-10-09 deploy: launchd restarted the worker while it was scoring; the request ended `aborted` and the jobs stayed unscored
    const shutdown = new AbortController();
    const ai = fakeAi({ onCall: (task) => { if (task === "score") shutdown.abort(); } });
    registerBuiltinAiSubtasks();
    await addJob("Alpha");
    await addJob("Beta");
    const cycle = await runnerCycle();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(ai), registry: new ChannelRegistry() }));

    const interrupted = await processNextControlRequest({ ...hostWorker(), signal: shutdown.signal, maxRequeues: () => 3 });
    expect(interrupted).toMatchObject({ kind: "run_ai", status: "pending", startedAt: null, finishedAt: null, result: { interruptions: 1 } });

    const finished = await processNextControlRequest({ ...hostWorker(), maxRequeues: () => 3 });
    expect(finished).toMatchObject({ id: interrupted!.id, status: "done", result: { cycleId: cycle.cycleId, ai: { status: "ok" } } });
    const scores = await db().select().from(schema.scores);
    expect(scores.every((s) => s.score === 77)).toBe(true);
    const jobMessages = (await db().select().from(schema.notifications)).filter((n) => n.kind === "job");
    expect(jobMessages).toHaveLength(2);
  });

  it("a request interrupted more often than host_worker.requeue_interrupted_max fails", async () => {
    const row = await insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: 1 } });
    for (let i = 0; i < 2; i += 1) {
      await db().update(schema.controlRequests).set({ status: "running" }).where(eq(schema.controlRequests.id, row.id));
      expect(await requeueInterruptedControlRequests(db(), { reason: "restarted", maxRequeues: 2, kinds: ["run_ai"] })).toEqual({ requeued: 1, failed: 0 });
    }
    await db().update(schema.controlRequests).set({ status: "running" }).where(eq(schema.controlRequests.id, row.id));
    expect(await requeueInterruptedControlRequests(db(), { reason: "restarted", maxRequeues: 2, kinds: ["run_ai"] })).toEqual({ requeued: 0, failed: 1 });
    expect(await getControlRequest(db(), row.id)).toMatchObject({ status: "failed", result: { error: "restarted", interruptions: 2 } });
    expect((await getControlRequest(db(), row.id))?.finishedAt).toBeInstanceOf(Date);
  });

  it("without maxRequeues an interrupted request fails as before", async () => {
    const shutdown = new AbortController();
    registerControlHandler("rescore_stale", async () => {
      shutdown.abort();
      return { status: "failed", result: { error: "aborted" } };
    });
    await insertControlRequest(db(), { kind: "rescore_stale" });
    expect(await processNextControlRequest({ ...hostWorker(), signal: shutdown.signal })).toMatchObject({ status: "failed", result: { error: "aborted" } });
  });

  it("an AI step that failed completely fails the request with ai_failed", async () => {
    registerAiSubtask({ name: "boom", run: async () => { throw new Error("nothing works"); } });
    await addJob("Alpha");
    const cycle = await runnerCycle();
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(fakeAi()), registry: new ChannelRegistry() }));
    const finished = await processNextControlRequest(hostWorker());
    expect(finished).toMatchObject({ status: "failed", result: { cycleId: cycle.cycleId, error: "ai_failed", ai: { status: "failed" } } });
    expect((await getCycle(db(), cycle.cycleId!))?.status).toBe("partial");
  });

  it("fails cleanly for a cycle that no longer exists or a bad payload", async () => {
    registerControlHandler("run_ai", createRunAiHandler({ steps: workerSteps(fakeAi()) }));
    await insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: 4242 } });
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ status: "failed", result: { error: "cycle_not_found" } });
    await insertControlRequest(db(), { kind: "run_ai", payload: { nope: true } });
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ status: "failed", result: { error: "invalid_payload" } });
  });
});

describe("the ai-worker handles translate_job and rescore_stale", () => {
  it("translate_job: the web queues, the worker translates, the page reads the result; a second click shares the request", async () => {
    const ai = fakeAi();
    const jobId = await addJob("Alpha");
    registerControlHandler("translate_job", createTranslateJobHandler({ createRouter: () => ai.router }));

    const queued = await requestTranslateJob(db(), { jobId, force: false, origin: "user" });
    expect(queued).toMatchObject({ state: "queued", existing: false });
    if (queued.state !== "queued") throw new Error("expected a queued request");
    expect(await requestTranslateJob(db(), { jobId, force: false, origin: "user" })).toMatchObject({ state: "queued", requestId: queued.requestId, existing: true });
    expect(await readTranslateRequest(db(), { requestId: queued.requestId, jobId })).toMatchObject({ state: "waiting", stage: "pending", partial: null, queue: { ahead: 0 } });
    // another job's page cannot read this request
    expect(await readTranslateRequest(db(), { requestId: queued.requestId, jobId: jobId + 1 })).toEqual({ state: "missing" });

    // the runner (host mode) leaves it alone
    expect(await processNextControlRequest(pollOptions(() => runnerRequestKinds("host")))).toBeNull();
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ status: "done", result: { jobId, translation: "translated" } });
    const state = await readTranslateRequest(db(), { requestId: queued.requestId, jobId });
    expect(state).toMatchObject({ state: "done", translation: { provider: "claude-cli", stale: false } });
    expect(ai.tasks).toEqual(["translate"]);

    // now a current translation exists: no new request, no AI
    expect(await requestTranslateJob(db(), { jobId, force: false, origin: "user" })).toMatchObject({ state: "cached" });
    expect(await requestTranslateJob(db(), { jobId, force: true, origin: "user" })).toMatchObject({ state: "queued", existing: false });
  });

  it("translate_job: refuses what cannot be translated and reports a provider outage with its code", async () => {
    expect(await requestTranslateJob(db(), { jobId: 9999, force: false, origin: "user" })).toEqual({ state: "error", error: "not_found" });
    const empty = await addJob("Empty", "   ");
    expect(await requestTranslateJob(db(), { jobId: empty, force: false, origin: "user" })).toEqual({ state: "error", error: "no_description" });

    const down = fakeAi({ fail: new AiProviderError("claude-cli", "auth", "login expired") });
    registerControlHandler("translate_job", createTranslateJobHandler({ createRouter: () => down.router }));
    const jobId = await addJob("Alpha");
    const queued = await requestTranslateJob(db(), { jobId, force: false, origin: "user" });
    if (queued.state !== "queued") throw new Error("expected a queued request");
    expect(await processNextControlRequest(hostWorker())).toMatchObject({ status: "failed", result: { error: "auth" } });
    expect(await readTranslateRequest(db(), { requestId: queued.requestId, jobId })).toMatchObject({ state: "failed", error: "auth", partial: { done: 0 } });
  });

  it("rescore_stale is claimed by the worker, not by the host-mode runner", async () => {
    const request = await insertControlRequest(db(), { kind: "rescore_stale" });
    expect(await processNextControlRequest(pollOptions(() => runnerRequestKinds("host")))).toBeNull();
    expect((await processNextControlRequest(hostWorker()))?.id).toBe(request.id);
    // the web side still refuses to queue a re-score when nothing is stale
    expect(await requestRescoreStale()).toMatchObject({ status: "error", error: "nothingStale" });
  });
});

// ---------------------------------------------------------------- /sources

describe("the ai-worker status", () => {
  it("reports heartbeat, queue and the last run_ai; the runner's own heartbeat does not count", async () => {
    const now = new Date();
    const cfg = loadConfig("ai");
    expect(await loadAiWorkerStatus(db(), { now, aiConfig: cfg })).toMatchObject({ online: false, ageSeconds: null, queue: { pending: 0, running: 0 }, lastRun: null });

    await writeHeartbeat(db(), "runner");
    await writeHeartbeat(db(), "ai-worker");
    await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1 } });
    await insertControlRequest(db(), { kind: "run_cycle" }); // not the worker's
    const done = await insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: 1 } });
    await db().update(schema.controlRequests).set({ status: "done", finishedAt: now, result: { cycleId: 1, ai: { status: "ok", scored: 3, translated: 1 }, notify: { status: "ok", pushed: 2 } } }).where(eq(schema.controlRequests.id, done.id));

    const status = await loadAiWorkerStatus(db(), { now: new Date(Date.now() + 1000), aiConfig: cfg });
    expect(status).toMatchObject({ execution: "host", online: true, queue: { pending: 1, running: 0 }, lastRun: { status: "done", cycleId: 1, scored: 3, translated: 1, pushed: 2 } });
    const later = await loadAiWorkerStatus(db(), { now: new Date(Date.now() + (cfg.host_worker.offline_after_seconds + 5) * 1000), aiConfig: cfg });
    expect(later.online).toBe(false);
  });
});
