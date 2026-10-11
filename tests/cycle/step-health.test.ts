// @vitest-environment node
import { describe, expect, it } from "vitest";

import { cycleStateFace, problemSteps, processingFailed, readCycleSteps, unprocessedBlocks } from "@/lib/cycle/step-health";

const summary = (steps: Array<{ name: string; status: string; error?: string }>) => ({ version: 1, steps });

describe("readCycleSteps / problemSteps", () => {
  it("reads the step statuses of cycles.summary_json and ignores what it does not know", () => {
    const steps = readCycleSteps(summary([{ name: "collect", status: "ok" }, { name: "pipeline", status: "failed", error: "ConfigError: x" }, { name: "mystery", status: "failed" }, { name: "ai", status: "weird" }]));
    expect(steps).toEqual([
      { name: "collect", status: "ok", error: null },
      { name: "pipeline", status: "failed", error: "ConfigError: x" },
      { name: "ai", status: "ok", error: null },
    ]);
    expect(readCycleSteps(null)).toEqual([]);
    expect(readCycleSteps({ seed: true })).toEqual([]);
  });

  it("lists failed steps, then partial ones; a partly failed fetch is the failed sources, not a step to name", () => {
    const steps = readCycleSteps(summary([{ name: "collect", status: "partial" }, { name: "pipeline", status: "failed" }, { name: "signals", status: "partial" }, { name: "ai", status: "failed" }]));
    expect(problemSteps(steps)).toEqual({ failed: ["pipeline", "ai"], partial: ["signals"] });
  });
});

describe("cycleStateFace: a cycle that did not do its job never reads as finished", () => {
  it("finished only when nothing went wrong", () => {
    expect(cycleStateFace({ status: "succeeded", steps: [], finished: true })).toMatchObject({ tone: "ok", key: "finished" });
  });

  it("partial: names the failed steps (warn), or the failed sources when no step failed", () => {
    const steps = readCycleSteps(summary([{ name: "pipeline", status: "failed" }, { name: "filter", status: "failed" }, { name: "ai", status: "failed" }]));
    expect(cycleStateFace({ status: "partial", steps, finished: true })).toEqual({ tone: "warn", key: "partialSteps", steps: ["pipeline", "filter", "ai"] });
    expect(cycleStateFace({ status: "partial", steps: [], failedChannels: 2, finished: true })).toMatchObject({ tone: "warn", key: "partialSources" });
    expect(cycleStateFace({ status: "partial", steps: [], failedChannels: 0, finished: true })).toMatchObject({ tone: "warn", key: "partial" });
  });

  it("failed is bad, with the failed steps when they are known", () => {
    expect(cycleStateFace({ status: "failed", steps: [], finished: true })).toMatchObject({ tone: "bad", key: "failed" });
    expect(cycleStateFace({ status: "failed", steps: readCycleSteps(summary([{ name: "collect", status: "failed" }])) })).toMatchObject({ tone: "bad", key: "failedSteps", steps: ["collect"] });
  });
});

describe("unprocessedBlocks: which summary blocks must not show a fake 0", () => {
  it("a failed pipeline or filter makes passed / salary / qualified unknown", () => {
    const steps = readCycleSteps(summary([{ name: "pipeline", status: "failed" }, { name: "ai", status: "failed" }]));
    expect(unprocessedBlocks(steps)).toEqual({ passed: "unprocessed", salary: "unprocessed", qualified: "unprocessed" });
    expect(processingFailed(steps)).toBe(true);
  });

  it("only the AI score missing makes just the push-line block unscored; a failed push makes pushed unknown", () => {
    expect(unprocessedBlocks(readCycleSteps(summary([{ name: "ai", status: "failed" }])))).toEqual({ qualified: "unscored" });
    expect(unprocessedBlocks(readCycleSteps(summary([{ name: "notify", status: "failed" }])))).toEqual({ pushed: "unprocessed" });
    // a push that only half went out is not a number to trust either
    expect(unprocessedBlocks(readCycleSteps(summary([{ name: "notify", status: "partial" }])))).toEqual({ pushed: "unprocessed" });
    expect(unprocessedBlocks(readCycleSteps(summary([{ name: "collect", status: "partial" }])))).toEqual({});
  });
});
