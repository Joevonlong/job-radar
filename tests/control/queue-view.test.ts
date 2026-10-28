// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildQueueView, requestProcessOf, workerOnline } from "@/lib/control/queue-view";
import { controlQueueViewSchema } from "@/lib/control/request-view-schema";
import { CONTROL_REQUEST_KINDS } from "@/lib/db/repos/control-requests";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const OFFLINE_AFTER = 90;

describe("requestProcessOf", () => {
  it("host: the ai-worker takes translation and scoring, the runner takes the collect-side kinds", () => {
    expect(requestProcessOf("translate_job", "host")).toBe("ai-worker");
    expect(requestProcessOf("score_jobs", "host")).toBe("ai-worker");
    expect(requestProcessOf("test_ai", "host")).toBe("ai-worker");
    expect(requestProcessOf("run_cycle", "host")).toBe("runner");
  });

  it("container: the runner takes translation, scoring and the AI test; run_ai stays with the ai-worker", () => {
    expect(requestProcessOf("translate_job", "container")).toBe("runner");
    expect(requestProcessOf("score_jobs", "container")).toBe("runner");
    expect(requestProcessOf("test_ai", "container")).toBe("runner");
    expect(requestProcessOf("run_ai", "container")).toBe("ai-worker");
  });

  it.each(["host", "container"] as const)("every kind has a process under %s", (execution) => {
    for (const kind of CONTROL_REQUEST_KINDS) expect(requestProcessOf(kind, execution), kind).not.toBeNull();
  });
});

describe("workerOnline", () => {
  it("the ai-worker is online up to offline_after_seconds, offline one second later, and offline without a heartbeat", () => {
    expect(workerOnline({ process: "ai-worker", heartbeatAt: ago(OFFLINE_AFTER), now: NOW, offlineAfterSeconds: OFFLINE_AFTER })).toBe(true);
    expect(workerOnline({ process: "ai-worker", heartbeatAt: ago(OFFLINE_AFTER + 1), now: NOW, offlineAfterSeconds: OFFLINE_AFTER })).toBe(false);
    expect(workerOnline({ process: "ai-worker", heartbeatAt: null, now: NOW, offlineAfterSeconds: OFFLINE_AFTER })).toBe(false);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("the runner is judged by its own heartbeat interval, not by the ai-worker's setting", () => {
    // RUNNER_HEARTBEAT_SECONDS times the stale factor 3
    vi.stubEnv("RUNNER_HEARTBEAT_SECONDS", "30");
    expect(workerOnline({ process: "runner", heartbeatAt: ago(80), now: NOW, offlineAfterSeconds: 10 })).toBe(true);
    expect(workerOnline({ process: "runner", heartbeatAt: ago(91), now: NOW, offlineAfterSeconds: 1000 })).toBe(false);
    expect(workerOnline({ process: "runner", heartbeatAt: null, now: NOW, offlineAfterSeconds: 1000 })).toBe(false);
  });

  it("no process counts as offline", () => {
    expect(workerOnline({ process: null, heartbeatAt: NOW, now: NOW, offlineAfterSeconds: OFFLINE_AFTER })).toBe(false);
  });
});

describe("buildQueueView", () => {
  const base = { process: "ai-worker" as const, heartbeatAt: ago(5), now: NOW, offlineAfterSeconds: OFFLINE_AFTER };

  it("a pending request: its place, what runs before it, the database clock and the worker", () => {
    const view = buildQueueView({ ...base, status: "pending", position: { ahead: 2, running: { kind: "run_ai", since: ago(600) }, startedAt: null } });
    expect(view).toEqual({
      ahead: 2,
      running: { kind: "run_ai", since: ago(600).toISOString() },
      startedAt: null,
      now: NOW.toISOString(),
      worker: { process: "ai-worker", online: true, heartbeatAgeSeconds: 5 },
    });
    expect(controlQueueViewSchema.parse(view)).toEqual(view);
  });

  it("a running request has its own start and nothing ahead", () => {
    const view = buildQueueView({ ...base, status: "running", position: { ahead: 3, running: null, startedAt: ago(5400) } });
    expect(view).toMatchObject({ ahead: 0, running: null, startedAt: ago(5400).toISOString(), worker: { online: true } });
  });

  it("a stale heartbeat, or none, is offline with its age", () => {
    expect(buildQueueView({ ...base, heartbeatAt: ago(OFFLINE_AFTER + 1), status: "pending", position: null })?.worker).toEqual({ process: "ai-worker", online: false, heartbeatAgeSeconds: OFFLINE_AFTER + 1 });
    expect(buildQueueView({ ...base, heartbeatAt: null, status: "pending", position: null })?.worker).toEqual({ process: "ai-worker", online: false, heartbeatAgeSeconds: null });
  });

  it("no claiming process reads as offline", () => {
    expect(buildQueueView({ ...base, process: null, status: "pending", position: null })?.worker).toEqual({ process: null, online: false, heartbeatAgeSeconds: null });
  });

  it.each(["done", "failed"] as const)("a %s request has no queue", (status) => {
    expect(buildQueueView({ ...base, status, position: { ahead: 0, running: null, startedAt: ago(10) } })).toBeNull();
  });
});
