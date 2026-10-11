// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { AiProviderError, AiUnavailableError, createAiRouter, type AiSubtaskContext } from "@/lib/ai";
import { runBreakdownSubtask, type BreakdownSubtaskDeps } from "@/lib/breakdown/subtask";
import { createLogger } from "@/lib/channels/logger";
import { ConfigError, type BreakdownConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";

import { pinnedAi } from "../ai/helpers";

const logger = createLogger({ sink: () => {} });
const fakeDb = {} as Db;
const settings = (over: Partial<BreakdownConfig> = {}): BreakdownConfig => ({ enabled: true, mode: "auto", auto: { min_rank: 80, per_cycle_limit: 2 }, jd_max_chars: 12000, jd_head_share: 0.7, timeout_seconds: 240, ...over });

function ctx(over: { dryRun?: boolean; aborted?: boolean } = {}): AiSubtaskContext {
  const controller = new AbortController();
  if (over.aborted) controller.abort();
  const config = pinnedAi();
  return {
    cycle: { cycle: { id: 1, kind: "manual" }, windowKind: null, dryRun: over.dryRun ?? false, db: fakeDb, signal: controller.signal, logger, now: () => new Date(), config: undefined as never, channels: undefined as never, results: {} },
    router: createAiRouter({ config, providers: [], usage: null }),
    config,
    perCycleLimit: config.per_cycle_limit,
  };
}

function deps(s: BreakdownConfig | Error, candidates: number[], run: BreakdownSubtaskDeps["run"]) {
  const listed: Array<{ minRank: number; limit: number }> = [];
  const d: BreakdownSubtaskDeps = {
    loadSettings: () => {
      if (s instanceof Error) throw s;
      return s;
    },
    listCandidates: vi.fn(async (_db, args) => {
      listed.push(args);
      return candidates.slice(0, args.limit).map((jobId) => ({ jobId }));
    }),
    run,
  };
  return { d, listed };
}
const done = { status: "done", cached: false, provider: "codex-cli", model: "m", items: 3, dropped: 0 } as const;

describe("breakdown sub-task (auto mode)", () => {
  it.each([
    ["disabled", settings({ enabled: false }), "disabled"],
    ["manual", settings({ mode: "manual" }), "manual"],
    ["config error", new ConfigError({ configName: "breakdown", filePath: "breakdown.yaml", kind: "schema", issues: [] }), "config_error"],
  ])("%s: nothing runs, the result says why, and it is not a skipSubtask", async (_name, s, skipped) => {
    const run = vi.fn();
    const { d } = deps(s, [1, 2], run);
    const result = await runBreakdownSubtask(ctx(), d);
    expect(result).toMatchObject({ skipped, candidates: 0, done: 0 });
    expect(result).not.toHaveProperty("skipReason");
    expect(d.listCandidates).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("auto: asks for candidates at min_rank, capped by per_cycle_limit, in order", async () => {
    const seen: number[] = [];
    const { d, listed } = deps(settings(), [5, 2, 9], async (_c, _db, jobId) => {
      seen.push(jobId);
      return done;
    });
    const result = await runBreakdownSubtask(ctx(), d);
    expect(listed).toEqual([{ minRank: 80, limit: 2 }]);
    expect(seen).toEqual([5, 2]);
    expect(result).toMatchObject({ minRank: 80, candidates: 2, done: 2, failed: 0, aiUnavailable: false });
  });

  it("a failed outcome is counted and the next job still runs", async () => {
    const { d } = deps(settings(), [1, 2], async (_c, _db, jobId) => (jobId === 1 ? { status: "failed", error: "no_verified_quotes" } : done));
    const result = await runBreakdownSubtask(ctx(), d);
    expect(result).toMatchObject({ done: 1, failed: 1, failures: [{ jobId: 1, reason: "no_verified_quotes" }] });
  });

  it("stops when no provider is reachable, but not for unusable output", async () => {
    const unavailable = new AiUnavailableError("breakdown", [{ provider: "codex-cli", outcome: "failed", kind: "network", message: "down" }]);
    const calls: number[] = [];
    const first = deps(settings(), [1, 2], async (_c, _db, jobId) => {
      calls.push(jobId);
      throw unavailable;
    });
    expect(await runBreakdownSubtask(ctx(), first.d)).toMatchObject({ aiUnavailable: true, failed: 1 });
    expect(calls).toEqual([1]);
    const invalid = new AiUnavailableError("breakdown", [{ provider: "codex-cli", outcome: "failed", kind: "invalid_output", message: "bad" }]);
    const second = deps(settings(), [1, 2], async () => {
      throw invalid;
    });
    expect(await runBreakdownSubtask(ctx(), second.d)).toMatchObject({ aiUnavailable: false, failed: 2 });
  });

  it("an aborted run stops quietly", async () => {
    const { d } = deps(settings(), [1, 2], async () => {
      throw new AiProviderError("codex-cli", "aborted", "stopped");
    });
    expect(await runBreakdownSubtask(ctx(), d)).toMatchObject({ done: 0, failed: 0 });
    const cancelled = deps(settings(), [1, 2], async () => done);
    expect(await runBreakdownSubtask(ctx({ aborted: true }), cancelled.d)).toMatchObject({ done: 0 });
  });

  it("a dry run does not touch the database", async () => {
    const { d } = deps(settings(), [1], async () => done);
    expect(await runBreakdownSubtask(ctx({ dryRun: true }), d)).toMatchObject({ skipped: "dry run" });
    expect(d.listCandidates).not.toHaveBeenCalled();
  });
});
