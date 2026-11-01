// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { registerAiControlHandlers } from "@/lib/control/ai-handlers";
import { getControlHandler, noHandler, resetControlHandlers } from "@/lib/control/handlers";
import { aiWorkerRequestKinds, runnerRequestKinds } from "@/lib/control/kinds";
import { AI_CONTROL_REQUEST_KINDS, CONTROL_REQUEST_KINDS, NON_AI_CONTROL_REQUEST_KINDS } from "@/lib/db/repos/control-requests";
import { controlRequestKindEnum } from "@/lib/db/schema";
import { summarizeDelegatedSteps } from "@/lib/control/run-ai";
import { runAiPayloadSchema, translateJobPayloadSchema } from "@/lib/control/types";
import { storedStepResults } from "@/lib/cycle/delegated";
import { aiWorkerOfflineAlert } from "@/lib/notify/alerts";
import { aiWorkerOfflineSeconds, isWorkerOnline, lastRunOf } from "@/lib/ops/ai-worker";
import type { ControlRequest } from "@/lib/db/repos/control-requests";

import { pinnedAi } from "../ai/helpers";
import { notifyText } from "@/lib/notify/text";

describe("ai.yaml: execution and host_worker", () => {
  it("ships with execution: host and the worker timings", () => {
    // docker_data_path is a per-machine optional value: drop it, the rest is what ships
    const config = pinnedAi((raw) => { delete (raw.host_worker as Record<string, unknown>).docker_data_path; });
    expect(config.execution).toBe("host");
    expect(config.host_worker).toEqual({ poll_seconds: 5, max_requests_per_poll: 10, heartbeat_seconds: 15, offline_after_seconds: 180, disk_check_minutes: 10, log_max_mb: 10, log_keep: 3, shutdown_grace_seconds: 30, requeue_interrupted_max: 3, already_running_wait_seconds: 60, step_timeout_seconds: 20 });
  });

  it("requeue_interrupted_max: 0 is allowed, negative is not, an older file gets 3", () => {
    expect(pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).requeue_interrupted_max = 0; }).host_worker.requeue_interrupted_max).toBe(0);
    expect(() => pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).requeue_interrupted_max = -1; })).toThrow();
    expect(pinnedAi((raw) => { delete (raw.host_worker as Record<string, unknown>).requeue_interrupted_max; }).host_worker.requeue_interrupted_max).toBe(3);
  });

  it("log rotation sizes: keep may be 0, the size must be positive; an older file gets the defaults", () => {
    expect(pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).log_keep = 0; }).host_worker.log_keep).toBe(0);
    expect(() => pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).log_max_mb = 0; })).toThrow();
    expect(() => pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).log_keep = -1; })).toThrow();
    const older = pinnedAi((raw) => {
      delete (raw.host_worker as Record<string, unknown>).log_max_mb;
      delete (raw.host_worker as Record<string, unknown>).log_keep;
    });
    expect(older.host_worker).toMatchObject({ log_max_mb: 10, log_keep: 3, shutdown_grace_seconds: 30, step_timeout_seconds: 20 });
  });

  it("docker_data_path is optional and must be absolute", () => {
    expect(pinnedAi((raw) => { delete (raw.host_worker as Record<string, unknown>).docker_data_path; }).host_worker.docker_data_path).toBeUndefined();
    expect(pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).docker_data_path = "/Volumes/SSD/.docker-data"; }).host_worker.docker_data_path).toBe("/Volumes/SSD/.docker-data");
    expect(() => pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).docker_data_path = "relative/dir"; })).toThrow();
  });

  it("ships the translation piece size and timeout", () => {
    expect(pinnedAi().translation).toMatchObject({ chunk_chars: 2500, chunk_timeout_seconds: 90 });
    expect(pinnedAi().translation.glossary["Forward Deployed Engineer"]).toBe("Forward Deployed Engineer");
    expect(() => pinnedAi((raw) => { (raw.translation as Record<string, unknown>).chunk_chars = 100; })).toThrow();
    expect(() => pinnedAi((raw) => { (raw.translation as Record<string, unknown>).chunk_timeout_seconds = 0; })).toThrow();
    expect(() => pinnedAi((raw) => { delete raw.translation; })).toThrow();
  });

  it("accepts container and rejects anything else or a missing / unknown host_worker key", () => {
    expect(pinnedAi((raw) => { raw.execution = "container"; }).execution).toBe("container");
    expect(() => pinnedAi((raw) => { raw.execution = "cloud"; })).toThrow();
    expect(() => pinnedAi((raw) => { delete raw.host_worker; })).toThrow();
    expect(() => pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).poll_seconds = 0; })).toThrow();
    expect(() => pinnedAi((raw) => { (raw.host_worker as Record<string, unknown>).extra = 1; })).toThrow();
  });
});

describe("which process takes which request", () => {
  it("host: the runner keeps run_cycle, the worker takes all AI work", () => {
    expect(runnerRequestKinds("host")).toEqual(["run_cycle", "test_channel", "test_telegram"]);
    expect(aiWorkerRequestKinds("host")).toEqual(["run_ai", "translate_job", "breakdown_job", "rescore_stale", "run_suggest", "score_jobs", "test_ai", "salary_lookup", "writer_job"]);
  });
  it("container: the runner takes the web's AI work, run_ai stays with the worker", () => {
    expect(runnerRequestKinds("container")).toEqual(["run_cycle", "test_channel", "test_telegram", "translate_job", "breakdown_job", "rescore_stale", "run_suggest", "score_jobs", "test_ai", "salary_lookup", "writer_job"]);
    expect(aiWorkerRequestKinds("container")).toEqual(["run_ai"]);
  });
  it("validates the payloads", () => {
    expect(runAiPayloadSchema.safeParse({ cycleId: 3 }).success).toBe(true);
    expect(runAiPayloadSchema.safeParse({ cycleId: 0 }).success).toBe(false);
    expect(runAiPayloadSchema.safeParse({ cycleId: 3, extra: 1 }).success).toBe(false);
    expect(translateJobPayloadSchema.parse({ jobId: 4 })).toEqual({ jobId: 4, force: false });
    expect(translateJobPayloadSchema.safeParse({ jobId: "4" }).success).toBe(false);
    expect(translateJobPayloadSchema.parse({ jobId: 4, origin: "auto" })).toEqual({ jobId: 4, force: false, origin: "auto" });
    expect(translateJobPayloadSchema.safeParse({ jobId: 4, origin: "user" }).success).toBe(false);
    expect(translateJobPayloadSchema.safeParse({ jobId: 4, origin: "auto", extra: 1 }).success).toBe(false);
  });
});

afterEach(() => resetControlHandlers());

describe("the rule: a request kind that calls AI is claimed only by the ai-worker", () => {
  it("every kind of the database enum is classified as AI or non-AI, exactly once (a new kind must be added to one list)", () => {
    const classified = [...AI_CONTROL_REQUEST_KINDS, ...NON_AI_CONTROL_REQUEST_KINDS];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...controlRequestKindEnum.enumValues].sort());
    expect([...CONTROL_REQUEST_KINDS].sort()).toEqual([...controlRequestKindEnum.enumValues].sort());
  });

  it("with execution: host the runner claims no AI kind and the worker claims all of them", () => {
    expect(runnerRequestKinds("host").filter((k) => (AI_CONTROL_REQUEST_KINDS as readonly string[]).includes(k))).toEqual([]);
    expect(aiWorkerRequestKinds("host")).toEqual([...AI_CONTROL_REQUEST_KINDS]);
  });

  it("with execution: container the runner takes the AI kinds except run_ai, which stays with the worker", () => {
    expect(runnerRequestKinds("container")).toEqual([...NON_AI_CONTROL_REQUEST_KINDS, ...AI_CONTROL_REQUEST_KINDS.filter((k) => k !== "run_ai")]);
    expect(aiWorkerRequestKinds("container")).toEqual(["run_ai"]);
  });

  it("registerAiControlHandlers plugs a real handler in for every AI kind; none is reachable before", () => {
    for (const kind of AI_CONTROL_REQUEST_KINDS.filter((k) => k !== "rescore_stale")) expect(getControlHandler(kind)).toBe(noHandler);
    registerAiControlHandlers();
    for (const kind of AI_CONTROL_REQUEST_KINDS) expect(getControlHandler(kind)).not.toBe(noHandler);
  });
});

describe("the worker's heartbeat verdict", () => {
  it("is online up to the limit and offline beyond it or without a heartbeat", () => {
    expect(isWorkerOnline(10, 180)).toBe(true);
    expect(isWorkerOnline(180, 180)).toBe(true);
    expect(isWorkerOnline(181, 180)).toBe(false);
    expect(isWorkerOnline(null, 180)).toBe(false);
  });

  const now = new Date("2026-10-07T12:00:00Z");
  const base = { execution: "host" as const, since: new Date("2026-10-07T11:00:00Z"), now, offlineAfterSeconds: 180 };
  it("alerts only with execution: host and only after the limit", () => {
    expect(aiWorkerOfflineSeconds({ ...base, lastHeartbeatAt: new Date("2026-10-07T11:59:00Z") })).toBeNull();
    expect(aiWorkerOfflineSeconds({ ...base, lastHeartbeatAt: new Date("2026-10-07T11:50:00Z") })).toBe(600);
    expect(aiWorkerOfflineSeconds({ ...base, execution: "container", lastHeartbeatAt: new Date("2026-10-07T11:50:00Z") })).toBeNull();
  });
  it("gives a worker that never beat the full limit counted from when the watcher started", () => {
    expect(aiWorkerOfflineSeconds({ ...base, since: new Date("2026-10-07T11:58:00Z"), lastHeartbeatAt: null })).toBeNull();
    expect(aiWorkerOfflineSeconds({ ...base, lastHeartbeatAt: null })).toBe(3600);
  });
  it("words the alert with minutes and the places to look", () => {
    const alert = aiWorkerOfflineAlert({ offlineSeconds: 600 }, notifyText("zh"));
    expect(alert).toMatchObject({ kind: "ai_worker_offline", key: "ai-worker" });
    expect(alert.detail).toContain("10 分钟");
    expect(alert.detail).toContain("pnpm run doctor");
  });
});

describe("reading what the runner stored and the worker reports", () => {
  it("storedStepResults keeps the step results of a stored summary and ignores junk", () => {
    expect(storedStepResults({ steps: [{ name: "collect", result: { queries: 2 } }, { name: "ai", status: "ok" }, "junk", { name: 3 }] })).toEqual({ collect: { queries: 2 } });
    expect(storedStepResults(null)).toEqual({});
    expect(storedStepResults({ steps: "no" })).toEqual({});
  });

  it("summarizeDelegatedSteps pulls the counters out of the step results", () => {
    const summary = summarizeDelegatedSteps([
      { name: "ai", status: "partial", durationMs: 1, result: { subtasks: [{ name: "score", status: "ok", result: { scored: 3 } }, { name: "signals", status: "failed" }, { name: "translate", status: "ok", result: { translated: 2 } }] } },
      { name: "notify", status: "ok", durationMs: 1, result: { jobs: { pushed: 1 } } },
    ]);
    expect(summary).toEqual({ ai: { status: "partial", scored: 3, translated: 2, failedSubtasks: 1 }, notify: { status: "ok", pushed: 1, pending: false } });
    expect(summarizeDelegatedSteps([])).toEqual({ ai: { status: "skipped", scored: null, translated: null, failedSubtasks: 0 }, notify: { status: "skipped", pushed: null, pending: false } });
  });

  it("summarizeDelegatedSteps names a scoring skip for an incomplete profile instead of 'ok, scored 0'", () => {
    const summary = summarizeDelegatedSteps([
      {
        name: "ai",
        status: "partial",
        durationMs: 1,
        result: { subtasks: [{ name: "score", status: "skipped", reason: "profile_incomplete", result: { scored: 0, stopped: "profile_incomplete", profileMissing: ["summary", "skills"] } }] },
      },
      { name: "notify", status: "ok", durationMs: 1, result: { jobs: { pushed: 0 } } },
    ]);
    expect(summary.ai).toEqual({ status: "skipped_profile_incomplete", reason: "profile_incomplete", profileMissing: ["summary", "skills"], scored: 0, translated: null, failedSubtasks: 0 });
    expect(lastRunOf({ id: 1, kind: "run_ai", payload: {}, status: "done", result: summary, requestedAt: new Date(), startedAt: null, finishedAt: new Date() })).toMatchObject({ aiStatus: "skipped_profile_incomplete", scored: 0 });
  });

  it("lastRunOf shows only finished requests and survives an unexpected result", () => {
    const row = (over: Partial<ControlRequest>): ControlRequest => ({ id: 7, kind: "run_ai", payload: {}, status: "done", result: null, requestedAt: new Date(), startedAt: null, finishedAt: new Date("2026-10-07T10:00:00Z"), ...over });
    expect(lastRunOf(null)).toBeNull();
    expect(lastRunOf(row({ status: "running" }))).toBeNull();
    expect(lastRunOf(row({ result: { cycleId: 4, ai: { status: "ok", scored: 3 }, notify: { status: "ok", pushed: 2 } } }))).toMatchObject({ requestId: 7, status: "done", cycleId: 4, scored: 3, pushed: 2, translated: null });
    expect(lastRunOf(row({ status: "failed", result: { error: "ai_failed" } }))).toMatchObject({ status: "failed", error: "ai_failed", scored: null });
    expect(lastRunOf(row({ result: { ai: "weird", notify: 5, cycleId: "x" } }))).toMatchObject({ cycleId: null, scored: null, pushed: null });
  });
});
