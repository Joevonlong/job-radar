// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import type { AiRouter } from "@/lib/ai/router";
import { runBreakdown } from "@/lib/breakdown/service";
import type { BreakdownConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { descriptionHash } from "@/lib/translation/hash";

import { emptyOutput, JD } from "./helpers";

const repo = vi.hoisted(() => ({ getJobForBreakdown: vi.fn(), getJobBreakdown: vi.fn(), upsertJobBreakdown: vi.fn() }));
vi.mock("@/lib/db/repos/breakdowns", () => repo);

const settings: BreakdownConfig = { enabled: true, mode: "manual", auto: { min_rank: 80, per_cycle_limit: 5 }, jd_max_chars: 12000, jd_head_share: 0.7, timeout_seconds: 240 };
const db = {} as Db;
const job = { id: 7, title: "AI Engineer", company: "Acme", description: JD };

function router(value: ReturnType<typeof emptyOutput>) {
  const run = vi.fn(async () => ({ value, provider: "codex-cli", model: "gpt-5.5", tokensIn: 1, tokensOut: 1, costUsd: 0, attempts: [] }));
  return { run, router: { plan: () => [], usable: async () => ({ usable: true, blocked: [] }), run } as unknown as AiRouter };
}
const good = () => ({ ...emptyOutput(), responsibilities: [{ text: "构建", quote: "Build and operate retrieval pipelines in production." }] });

beforeEach(() => {
  repo.getJobForBreakdown.mockReset().mockResolvedValue(job);
  repo.getJobBreakdown.mockReset().mockResolvedValue(null);
  repo.upsertJobBreakdown.mockReset().mockResolvedValue(undefined);
});

describe("runBreakdown", () => {
  it.each([false, true])("merges concurrent work in the same language; the first force=%s and router win", async (force) => {
    const first = router(good());
    const later = router(good());
    const a = runBreakdown(db, first.router, 7, { force, settings, outputLanguage: "zh" });
    const b = runBreakdown(db, later.router, 7, { force: !force, settings: { ...settings, timeout_seconds: 1 }, outputLanguage: "zh" });
    const [one, two] = await Promise.all([a, b]);
    expect(one).toBe(two);
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(later.run).not.toHaveBeenCalled();
    expect(repo.upsertJobBreakdown).toHaveBeenCalledTimes(1);
  });

  it("resolves the default language before merging and keeps different languages separate", async () => {
    const first = router(good());
    const later = router(good());
    const { aiOutputLanguage } = await import("@/lib/i18n/config");
    const [a, b] = await Promise.all([
      runBreakdown(db, first.router, 7, { force: false, settings }),
      runBreakdown(db, later.router, 7, { force: true, settings, outputLanguage: aiOutputLanguage() }),
    ]);
    expect(a).toBe(b);
    expect(later.run).not.toHaveBeenCalled();
    first.run.mockClear();
    await Promise.all([
      runBreakdown(db, first.router, 7, { force: true, settings, outputLanguage: "en" }),
      runBreakdown(db, first.router, 7, { force: true, settings, outputLanguage: "zh" }),
    ]);
    expect(first.run).toHaveBeenCalledTimes(2);
  });

  it("fails for an unknown job and a job without a JD, without calling the AI", async () => {
    const { router: r, run } = router(good());
    repo.getJobForBreakdown.mockResolvedValueOnce(null);
    expect(await runBreakdown(db, r, 7, { force: false, settings })).toEqual({ status: "failed", error: "not_found" });
    repo.getJobForBreakdown.mockResolvedValueOnce({ ...job, description: "  \n" });
    expect(await runBreakdown(db, r, 7, { force: false, settings })).toEqual({ status: "failed", error: "no_description" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns the cached result of the same JD and prompt version without calling the AI; force calls it", async () => {
    const { router: r, run } = router(good());
    repo.getJobBreakdown.mockResolvedValue({ jobId: 7, sourceHash: descriptionHash(JD), promptVersion: BREAKDOWN_PROMPT_VERSION, provider: "x", model: "y", content: {}, droppedItems: 2, analyzedAt: new Date() });
    expect(await runBreakdown(db, r, 7, { force: false, settings })).toMatchObject({ status: "done", cached: true });
    expect(run).not.toHaveBeenCalled();
    expect(await runBreakdown(db, r, 7, { force: true, settings })).toMatchObject({ status: "done", cached: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a breakdown of another JD or an older prompt is not current", async () => {
    const { router: r, run } = router(good());
    repo.getJobBreakdown.mockResolvedValue({ jobId: 7, sourceHash: "other", promptVersion: BREAKDOWN_PROMPT_VERSION, provider: null, model: null, content: {}, droppedItems: 0, analyzedAt: new Date() });
    await runBreakdown(db, r, 7, { force: false, settings });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("asks the router for the breakdown task with the configured timeout, and sends no profile", async () => {
    const { router: r, run } = router(good());
    await runBreakdown(db, r, 7, { force: false, settings });
    const call = run.mock.calls[0] as unknown as [string, { system: string; user: string }, unknown, { timeoutMs: number }];
    expect(call[0]).toBe("breakdown");
    expect(call[1].user).toContain("Acme");
    expect(call[3].timeoutMs).toBe(240_000);
  });

  it("stores the verified content with provider, model, hash, version and the dropped count", async () => {
    const output = { ...good(), projects: [{ text: "p", requirement: "must" as const, quote: "never in the JD" }] };
    const { router: r } = router(output);
    const outcome = await runBreakdown(db, r, 7, { force: false, settings });
    expect(outcome).toMatchObject({ status: "done", cached: false, provider: "codex-cli", model: "gpt-5.5", items: 1, dropped: 1 });
    expect(repo.upsertJobBreakdown).toHaveBeenCalledWith(db, expect.objectContaining({ jobId: 7, sourceHash: descriptionHash(JD), promptVersion: BREAKDOWN_PROMPT_VERSION, provider: "codex-cli", model: "gpt-5.5", droppedItems: 1 }));
  });

  it("writes nothing when every quote is wrong", async () => {
    const { router: r } = router({ ...emptyOutput(), responsibilities: [{ text: "a", quote: "invented" }] });
    expect(await runBreakdown(db, r, 7, { force: false, settings })).toEqual({ status: "failed", error: "no_verified_quotes" });
    expect(repo.upsertJobBreakdown).not.toHaveBeenCalled();
  });

  it("an empty answer is saved as empty (the card says the AI found nothing)", async () => {
    const { router: r } = router(emptyOutput());
    expect(await runBreakdown(db, r, 7, { force: false, settings })).toMatchObject({ status: "done", items: 0 });
    expect(repo.upsertJobBreakdown).toHaveBeenCalledTimes(1);
  });

  it("lets AI errors through", async () => {
    const r = { run: async () => { throw new Error("boom"); } } as unknown as AiRouter;
    await expect(runBreakdown(db, r, 7, { force: false, settings })).rejects.toThrow("boom");
  });
});
