// @vitest-environment node
import { describe, expect, it } from "vitest";

import { AiProviderError, AiUnavailableError, createAiRouter, listAiSubtasks, resetAiSubtasks, type AiSubtaskContext } from "@/lib/ai";
import { createLogger } from "@/lib/channels/logger";
import { registerBuiltinAiSubtasks } from "@/lib/cycle/builtin-steps";
import type { Db } from "@/lib/db/client";
import type { TranslationCandidate } from "@/lib/db/repos/translations";
import { TranslationIncompleteError } from "@/lib/translation/errors";
import { fakeRecorder } from "../activity/helpers";
import { runTranslateSubtask, type TranslateSubtaskDeps } from "@/lib/translation/subtask";

import { pinnedAi } from "../ai/helpers";

const logger = createLogger({ sink: () => {} });
const fakeDb = {} as Db;

function ctx(over: { dryRun?: boolean; db?: Db | null; aborted?: boolean; limit?: number } = {}): AiSubtaskContext {
  const controller = new AbortController();
  if (over.aborted) controller.abort();
  const config = pinnedAi();
  return {
    cycle: { cycle: { id: 1, kind: "manual" }, windowKind: null, dryRun: over.dryRun ?? false, db: over.db === undefined ? fakeDb : over.db, signal: controller.signal, logger, now: () => new Date(), config: undefined as never, channels: undefined as never, results: {} },
    router: createAiRouter({ config, providers: [], usage: null }),
    config,
    perCycleLimit: over.limit ?? config.per_cycle_limit,
  };
}

const candidate = (jobId: number, rankValue: number): TranslationCandidate => ({ jobId, description: "text", language: "en", rankValue });

function deps(candidates: TranslationCandidate[], translate: TranslateSubtaskDeps["translate"]): TranslateSubtaskDeps & { listed: Array<{ lang: string; minRank: number; limit: number }> } {
  const listed: Array<{ lang: string; minRank: number; limit: number }> = [];
  return {
    listed,
    listCandidates: async (_db, args) => {
      listed.push(args);
      return candidates.slice(0, args.limit);
    },
    translate,
  };
}

const translated = { status: "translated", translation: { content: "x", provider: "codex-cli", createdAt: new Date(), stale: false } } as const;

describe("translate sub-task", () => {
  it("asks for candidates at translate_auto_min_score, capped by the per-cycle limit, in the order given", async () => {
    const seen: number[] = [];
    const d = deps([candidate(5, 90), candidate(2, 80), candidate(9, 71)], async (_c, _db, jobId) => {
      seen.push(jobId);
      return translated;
    });
    const result = await runTranslateSubtask(ctx({ limit: 2 }), d);
    expect(d.listed).toEqual([{ lang: "zh", minRank: 70, limit: 2 }]);
    expect(seen).toEqual([5, 2]);
    expect(result).toMatchObject({ minRank: 70, candidates: 2, translated: 2, failed: 0, aiUnavailable: false });
  });

  it("uses the configured threshold, not a built-in one", async () => {
    const d = deps([], async () => translated);
    await runTranslateSubtask({ ...ctx(), config: pinnedAi((raw) => { raw.translate_auto_min_score = 55; }) }, d);
    expect(d.listed[0]?.minRank).toBe(55);
  });

  it("does nothing in a dry run or without a database", async () => {
    const d = deps([candidate(1, 99)], async () => translated);
    expect(await runTranslateSubtask(ctx({ dryRun: true }), d)).toMatchObject({ skipped: "dry run", translated: 0 });
    expect(await runTranslateSubtask(ctx({ db: null }), d)).toMatchObject({ skipped: "no database" });
    expect(d.listed).toEqual([]);
  });

  it("counts cached results as not translated and isolates a failing job", async () => {
    const d = deps([candidate(1, 90), candidate(2, 85), candidate(3, 80)], async (_c, _db, jobId) => {
      if (jobId === 1) return { status: "cached", translation: translated.translation };
      if (jobId === 2) throw new Error("boom");
      return translated;
    });
    const result = await runTranslateSubtask(ctx(), d);
    expect(result).toMatchObject({ candidates: 3, translated: 1, failed: 1, aiUnavailable: false, failures: [{ jobId: 2, reason: expect.stringContaining("boom") }] });
  });

  it("stops when no provider is reachable, but carries on past a job that only produced unusable output", async () => {
    const down = new AiUnavailableError("translate", [{ provider: "codex-cli", outcome: "failed", kind: "network", message: "x" }]);
    const stopped = await runTranslateSubtask(ctx(), deps([candidate(1, 90), candidate(2, 85)], async () => { throw down; }));
    expect(stopped).toMatchObject({ failed: 1, aiUnavailable: true });

    const bad = new AiUnavailableError("translate", [{ provider: "codex-cli", outcome: "failed", kind: "invalid_output", message: "x" }]);
    const seen: number[] = [];
    const carried = await runTranslateSubtask(ctx(), deps([candidate(1, 90), candidate(2, 85)], async (_c, _db, jobId) => {
      seen.push(jobId);
      if (jobId === 1) throw bad;
      return translated;
    }));
    expect(seen).toEqual([1, 2]);
    expect(carried).toMatchObject({ failed: 1, translated: 1, aiUnavailable: false });
  });

  it("stops at once when the cycle was cancelled", async () => {
    const d = deps([candidate(1, 90)], async () => translated);
    expect(await runTranslateSubtask(ctx({ aborted: true }), d)).toMatchObject({ candidates: 1, translated: 0 });
  });
});

describe("registration", () => {
  it("the built-in AI sub-tasks include signals and translate, after score", () => {
    resetAiSubtasks();
    registerBuiltinAiSubtasks();
    expect(listAiSubtasks().map((s) => s.name)).toEqual(["traps", "score", "signals", "translate", "breakdown"]);
    resetAiSubtasks();
  });
});


describe("translation job activity", () => {
  it("records wrapped quota errors as pauses while retaining the business failure result", async () => {
    const fake = fakeRecorder();
    const activity = fake.recorder.systemRoot("system.backup");
    const error = new TranslationIncompleteError({ code: "quota_guard", message: "private", providerWide: true, resumeAt: null }, 1, 2);
    const result = await runTranslateSubtask({ ...ctx(), activity }, deps([candidate(7, 90)], async () => { throw error; }));
    expect(result).toMatchObject({ failed: 1, aiUnavailable: true });
    expect(fake.spans[0]?.items).toEqual([["item.paused", { jobId: 7, errorCode: "quota_guard" }]]);
    expect(fake.spans[0]?.progress).toEqual([[0, 1], [1, 1]]);
  });

  it("records a completed job even if shutdown arrives during its save", async () => {
    const fake = fakeRecorder();
    const controller = new AbortController();
    const context = ctx();
    context.cycle.signal = controller.signal;
    const result = await runTranslateSubtask({ ...context, activity: fake.recorder.systemRoot("system.backup") }, deps([candidate(7, 90)], async () => { controller.abort(); return translated; }));
    expect(result.translated).toBe(1);
    expect(fake.spans[0]?.items).toEqual([["item.ok", { jobId: 7 }]]);
    expect(fake.spans[0]?.progress).toEqual([[0, 1], [1, 1]]);
  });

  it("records no item for a job whose call aborts", async () => {
    const fake = fakeRecorder();
    await runTranslateSubtask({ ...ctx(), activity: fake.recorder.systemRoot("system.backup") }, deps([candidate(7, 90)], async () => { throw new AiProviderError("codex-cli", "aborted", "private"); }));
    expect(fake.spans[0]?.items).toEqual([]);
    expect(fake.spans[0]?.progress).toEqual([[0, 1]]);
  });
});
