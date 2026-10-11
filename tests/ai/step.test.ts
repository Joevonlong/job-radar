// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { AiUnavailableError } from "@/lib/ai/errors";
import { createMemoryQuotaStore } from "@/lib/ai/quota-guard";
import { createAiRouter } from "@/lib/ai/router";
import { createAiStep, listAiSubtasks, registerAiSubtask, resetAiSubtasks, skipSubtask } from "@/lib/ai/step";
import { listCycleSteps } from "@/lib/cycle/steps";
import type { CycleStepContext } from "@/lib/cycle/steps";

import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { scriptedProvider, pinnedAi, usageEntry } from "./helpers";

afterEach(() => resetAiSubtasks());

function ctx(signal: AbortSignal = new AbortController().signal): CycleStepContext {
  return { cycle: { id: null, kind: "manual" }, windowKind: null, dryRun: false, db: null, signal, logger: quietLogger, now: () => new Date(), config: cycleConfig(), channels: undefined as never, results: {} };
}

const deps = {
  loadAiConfig: () => pinnedAi(),
  createRouter: (_ctx: CycleStepContext, config: ReturnType<typeof pinnedAi>) => createAiRouter({ config, providers: [scriptedProvider("codex-cli", ["{}"]).provider], usage: null }),
};

describe("ai cycle step frame", () => {
  it("is the registered `ai` step and does nothing without sub-tasks", async () => {
    expect(listCycleSteps().find(([name]) => name === "ai")).toBeDefined();
    const outcome = await createAiStep(deps)(ctx());
    expect(outcome).toEqual({ result: { subtasks: [] } });
  });

  it("runs sub-tasks in registration order with the router and the per-cycle limit", async () => {
    const order: string[] = [];
    registerAiSubtask({ name: "score", run: async (c) => { order.push(`score:${c.perCycleLimit}`); return { scored: 3 }; } });
    registerAiSubtask({ name: "signals", run: async () => { order.push("signals"); } });
    const outcome = await createAiStep(deps)(ctx());
    expect(order).toEqual(["score:80", "signals"]);
    expect(outcome).toMatchObject({ status: "ok", result: { subtasks: [{ name: "score", status: "ok", result: { scored: 3 } }, { name: "signals", status: "ok" }] } });
  });

  it("isolates a failing sub-task: the next one still runs and the step is partial", async () => {
    const ran: string[] = [];
    registerAiSubtask({ name: "a", run: async () => { throw new Error("boom"); } });
    registerAiSubtask({ name: "b", run: async () => { ran.push("b"); } });
    const outcome = await createAiStep(deps)(ctx());
    expect(ran).toEqual(["b"]);
    expect(outcome).toMatchObject({ status: "partial", result: { subtasks: [{ name: "a", status: "failed", error: expect.stringContaining("boom") }, { name: "b", status: "ok" }] } });
  });

  it("is failed when every sub-task failed, and skips sub-tasks after a cancel", async () => {
    registerAiSubtask({ name: "a", run: async () => { throw new Error("x"); } });
    expect(await createAiStep(deps)(ctx())).toMatchObject({ status: "failed" });
    const controller = new AbortController();
    controller.abort();
    const outcome = await createAiStep(deps)(ctx(controller.signal));
    expect(outcome).toMatchObject({ result: { subtasks: [{ name: "a", status: "skipped" }] } });
  });

  it("records a sub-task skipped for a reason as skipped (not ok) and the step as partial", async () => {
    registerAiSubtask({ name: "score", run: async () => skipSubtask("profile_incomplete", { scored: 0, profileMissing: ["summary", "skills"] }) });
    registerAiSubtask({ name: "signals", run: async () => ({ reviewed: 1 }) });
    const outcome = await createAiStep(deps)(ctx());
    expect(outcome).toMatchObject({
      status: "partial",
      result: { subtasks: [{ name: "score", status: "skipped", reason: "profile_incomplete", result: { scored: 0, profileMissing: ["summary", "skills"] } }, { name: "signals", status: "ok" }] },
    });
  });

  it("replaces a sub-task registered twice under one name", () => {
    registerAiSubtask({ name: "a", run: async () => 1 });
    registerAiSubtask({ name: "a", run: async () => 2 });
    expect(listAiSubtasks()).toHaveLength(1);
  });
});

describe("ai cycle step: Job Radar's usage cap", () => {
  const capped = (resumeAt: string | null) =>
    new AiUnavailableError("score", [{ provider: "codex-cli", outcome: "skipped", kind: "budget", message: "cap", guard: { reason: resumeAt ? "window" : "cycle_cap", resumeAt } }]);

  it("skips the whole step with the code and the earliest resume time when the cap holds every CLI back", async () => {
    const now = new Date("2026-10-07T10:00:00Z");
    const config = pinnedAi((raw) => {
      raw.order = ["codex-cli"];
      raw.quota_guard = { providers: { codex_cli: { hard_requests: 2, cycle_request_cap: 0 } } };
    });
    const entries = [1, 2].map((m) => usageEntry({ provider: "codex-cli", task: "score", at: new Date(now.getTime() - m * 60_000) }));
    const ran: string[] = [];
    registerAiSubtask({ name: "score", run: async () => { ran.push("score"); } });
    const outcome = await createAiStep({
      loadAiConfig: () => config,
      createRouter: (_ctx, c) => createAiRouter({ config: c, providers: [scriptedProvider("codex-cli", ["{}"]).provider], usage: null, quota: createMemoryQuotaStore(entries), now: () => now, timeZone: "UTC" }),
    })(ctx());
    expect(ran).toEqual([]);
    expect(outcome).toMatchObject({ result: { subtasks: [], skipped: "quota_guard", resumeAt: expect.any(String), guards: [{ provider: "codex-cli", reason: "window" }] } });
  });

  it("records a sub-task the cap stopped as skipped (not failed), with its resume time", async () => {
    registerAiSubtask({ name: "translate", run: async () => { throw capped("2026-10-07T12:00:00.000Z"); } });
    registerAiSubtask({ name: "summarize", run: async () => { throw capped(null); } });
    registerAiSubtask({ name: "score", run: async () => skipSubtask("quota_guard", { scored: 0, stopped: "quota_guard", quotaResumeAt: "2026-10-07T13:00:00.000Z" }) });
    const outcome = await createAiStep(deps)(ctx());
    expect(outcome).toMatchObject({
      status: "partial",
      result: {
        subtasks: [
          { name: "translate", status: "skipped", reason: "quota_guard", resumeAt: "2026-10-07T12:00:00.000Z" },
          { name: "summarize", status: "skipped", reason: "quota_guard", resumeAt: null },
          { name: "score", status: "skipped", reason: "quota_guard", resumeAt: "2026-10-07T13:00:00.000Z" },
        ],
      },
    });
  });
});
