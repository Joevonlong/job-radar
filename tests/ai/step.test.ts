// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { createAiRouter } from "@/lib/ai/router";
import { createAiStep, listAiSubtasks, registerAiSubtask, resetAiSubtasks, skipSubtask } from "@/lib/ai/step";
import { listCycleSteps } from "@/lib/cycle/steps";
import type { CycleStepContext } from "@/lib/cycle/steps";

import { config as cycleConfig, quietLogger } from "../cycle/helpers";
import { scriptedProvider, pinnedAi } from "./helpers";

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
