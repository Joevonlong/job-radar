import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { createAiRouter, createDbUsageStore, registerAiSubtask, resetAiSubtasks, type AiRouter } from "@/lib/ai";
import { createAiStep } from "@/lib/ai/step";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { createTranslateJobHandler } from "@/lib/control/translate-job";
import { createLogger } from "@/lib/channels/logger";
import type { CycleStepContext } from "@/lib/cycle/steps";
import { closeDb, getDb, getJobDetail, getTranslation, insertControlRequest, listTranslationCandidates, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { descriptionHash } from "@/lib/translation/hash";
import { splitIntoChunks } from "@/lib/translation/chunk";
import { ensureTranslation, toJobTranslation } from "@/lib/translation/service";
import { translateSubtask } from "@/lib/translation/subtask";

import { pinnedAi, scriptedProvider } from "../ai/helpers";
import { config as cycleConfig } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const logger = createLogger({ sink: () => {} });
const NOW = new Date("2026-10-07T10:00:00Z");

const description = (n: number): string => `## Role ${n}\n\n- Base salary of EUR 90,000 per year\n- Größe & Ärger: 30 Tage Urlaub\n\nJoin our team and build retrieval systems for clinical data. ${"We value careful engineering. ".repeat(6)}`;
const chinese = "## 职位\n\n- [[S1]]年薪 90,000 欧元[[/S1]]\n- 30 天假期\n\n加入我们的团队，为临床数据构建检索系统。我们重视严谨的工程实践，欢迎认真做事的人加入我们。";

interface Seeded {
  top: number;
  second: number;
  low: number;
  closed: number;
  noText: number;
  fresh: number;
  stale: number;
  filtered: number;
  rescored: number;
}
let ids: Seeded;

async function addJob(title: string, over: Partial<typeof schema.jobs.$inferInsert> = {}): Promise<number> {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title.toLowerCase()}` }).returning();
  const [job] = await db
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description: description(title.length), language: "en", ...over })
    .returning();
  return job!.id;
}

async function addScore(jobId: number, rankValue: number | null, at: Date, filterResult: "passed" | "filtered_out" = "passed"): Promise<void> {
  await withRebuiltCurrentScores(getDb(), getDb().insert(schema.scores).values({ jobId, filterResult, score: rankValue === null ? null : Math.round(rankValue), rankValue, createdAt: at }));
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

// Every test gets the same freshly seeded jobs, so none depends on what an earlier test translated or changed.
beforeEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications, ai_usage restart identity cascade`);
  const hour = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

  const top = await addJob("Top");
  await addScore(top, 92.5, hour(1));
  await db.insert(schema.signals).values({ jobId: top, tier: "T1", kind: "salary", quote: "Base salary of EUR 90,000 per year", extractor: "rule" });
  const second = await addJob("Second");
  await addScore(second, 70, hour(1)); // exactly the threshold counts
  const low = await addJob("Low");
  await addScore(low, 69.99, hour(1));
  const closed = await addJob("Closed", { status: "closed" });
  await addScore(closed, 99, hour(1));
  const noText = await addJob("NoText", { description: null });
  await addScore(noText, 88, hour(1));
  const fresh = await addJob("Fresh");
  await addScore(fresh, 85, hour(1));
  await db.insert(schema.translations).values({ jobId: fresh, lang: "zh", provider: "codex-cli", content: "已有译文", sourceHash: descriptionHash(description("Fresh".length)) });
  const stale = await addJob("Stale");
  await addScore(stale, 75, hour(1));
  await db.insert(schema.translations).values({ jobId: stale, lang: "zh", provider: "codex-cli", content: "旧译文", sourceHash: descriptionHash("an older description") });
  const filtered = await addJob("Filtered");
  await addScore(filtered, null, hour(1), "filtered_out");
  const rescored = await addJob("Rescored"); // the newest score decides
  await addScore(rescored, 95, hour(5));
  await addScore(rescored, 40, hour(1));
  ids = { top, second, low, closed, noText, fresh, stale, filtered, rescored };
});

afterAll(async () => {
  resetAiSubtasks();
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications, ai_usage restart identity cascade`);
  await closeDb();
});

function fakeAi(reply = chinese, beforeCall?: () => Promise<void>): { router: AiRouter; calls: () => number } {
  const { provider, transport } = scriptedProvider("codex-cli", [JSON.stringify({ translation: reply })]);
  const call = transport.call;
  transport.call = async (request) => { await beforeCall?.(); return call(request); };
  const router = createAiRouter({ config: pinnedAi(), providers: [provider], usage: createDbUsageStore(getDb()), now: () => NOW });
  return { router, calls: () => transport.calls.length };
}

describe("translation candidates (auto-translate selection)", () => {
  it("picks open jobs whose newest rank reaches the threshold and that lack a current translation, best first", async () => {
    const found = await listTranslationCandidates(getDb(), { lang: "zh", minRank: 70, limit: 80 });
    expect(found.map((c) => c.jobId)).toEqual([ids.top, ids.stale, ids.second]);
    expect(found.map((c) => c.rankValue)).toEqual([92.5, 75, 70]);
  });

  it("honours the threshold, the limit and the language", async () => {
    expect((await listTranslationCandidates(getDb(), { lang: "zh", minRank: 80, limit: 80 })).map((c) => c.jobId)).toEqual([ids.top]);
    expect((await listTranslationCandidates(getDb(), { lang: "zh", minRank: 70, limit: 2 })).map((c) => c.jobId)).toEqual([ids.top, ids.stale]);
    // nothing is translated into another language yet, so the fresh job is a candidate there
    expect((await listTranslationCandidates(getDb(), { lang: "de", minRank: 85, limit: 80 })).map((c) => c.jobId)).toEqual([ids.top, ids.fresh]);
    // A JD already written in the target language is never a candidate (these postings are English)
    expect(await listTranslationCandidates(getDb(), { lang: "en", minRank: 0, limit: 80 })).toEqual([]);
    expect(await listTranslationCandidates(getDb(), { lang: "en-GB", minRank: 0, limit: 80 })).toEqual([]);
  });
});

describe("one cycle's ai step with the translate sub-task (fake AI)", () => {
  it("translates the high-ranked jobs without a current translation and leaves the rest", async () => {
    const { router, calls } = fakeAi();
    resetAiSubtasks();
    registerAiSubtask(translateSubtask);
    const step = createAiStep({ loadAiConfig: () => pinnedAi(), createRouter: () => router });
    const ctx: CycleStepContext = { cycle: { id: null, kind: "manual" }, windowKind: null, dryRun: false, db: getDb(), signal: new AbortController().signal, logger, now: () => NOW, config: cycleConfig(), channels: undefined as never, results: {} };
    const outcome = await step(ctx);
    resetAiSubtasks();

    expect(outcome).toMatchObject({ status: "ok", result: { subtasks: [{ name: "translate", status: "ok", result: { candidates: 3, translated: 3, failed: 0 } }] } });
    expect(calls()).toBe(3);

    const db = getDb();
    for (const id of [ids.top, ids.second, ids.stale]) {
      const row = await getTranslation(db, id, "zh");
      expect(row?.provider).toBe("codex-cli");
      expect(row?.content).toContain("加入我们的团队");
      const [job] = await db.select({ description: schema.jobs.description }).from(schema.jobs).where(eq(schema.jobs.id, id));
      expect(row?.sourceHash).toBe(descriptionHash(job?.description));
    }
    // the signal quote was highlighted with its tier
    expect((await getTranslation(db, ids.top, "zh"))?.content).toContain("[[T1]]年薪 90,000 欧元[[/T1]]");
    // untouched: low rank, closed, no text, filtered, re-scored down, already current
    for (const id of [ids.low, ids.closed, ids.noText, ids.filtered, ids.rescored]) expect(await getTranslation(db, id, "zh")).toBeNull();
    expect((await getTranslation(db, ids.fresh, "zh"))?.content).toBe("已有译文");

    // usage was recorded under the translate task
    const usage = await db.select().from(schema.aiUsage);
    expect(usage).toHaveLength(3);
    expect(usage.every((u) => u.task === "translate" && u.provider === "codex-cli")).toBe(true);

    // a second cycle finds nothing left to do
    expect(await listTranslationCandidates(db, { lang: "zh", minRank: 70, limit: 80 })).toEqual([]);
  });
});

describe("ensureTranslation (what the translate button runs)", () => {
  it.each([false, true])("merges the same target with first force=%s, router, settings and progress callback winning", async (force) => {
    const first = fakeAi();
    const later = fakeAi();
    const onProgress = vi.fn();
    const ignoredProgress = vi.fn();
    const [a, b] = await Promise.all([
      ensureTranslation(getDb(), first.router, ids.closed, { force, target: "zh", settings: { chunk_chars: 200, chunk_timeout_seconds: 90 }, onProgress }),
      ensureTranslation(getDb(), later.router, ids.closed, { force: !force, target: "zh", settings: { chunk_chars: 1000, chunk_timeout_seconds: 1 }, onProgress: ignoredProgress }),
    ]);
    const chunks = splitIntoChunks(description("Closed".length), 200).length;
    expect(a).toBe(b);
    expect(first.calls()).toBe(chunks);
    expect(onProgress).toHaveBeenCalledTimes(chunks);
    expect(later.calls()).toBe(0);
    expect(ignoredProgress).not.toHaveBeenCalled();
  });

  it("different target languages each call AI and store their own translation", async () => {
    const first = fakeAi();
    const other = fakeAi();
    const [a, b] = await Promise.all([
      ensureTranslation(getDb(), first.router, ids.closed, { target: "zh" }),
      ensureTranslation(getDb(), other.router, ids.closed, { target: "de" }),
    ]);
    expect(a).not.toBe(b);
    expect(first.calls()).toBe(1);
    expect(other.calls()).toBe(1);
    for (const lang of ["zh", "de"]) expect(await getTranslation(getDb(), ids.closed, lang)).not.toBeNull();
  });

  it("a real late subtask and interactive handler translate each chunk only once", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    let first = true;
    const lateAi = fakeAi(chinese, async () => {
      if (first) { first = false; entered.resolve(); await release.promise; }
    });
    const interactiveAi = fakeAi();
    const text = Array.from({ length: 8 }, (_, i) => description(i)).join("\n\n");
    await getDb().update(schema.jobs).set({ description: text }).where(eq(schema.jobs.id, ids.top));
    const config = pinnedAi((raw) => { raw.per_cycle_limit = 1; (raw.translation as Record<string, unknown>).chunk_chars = 500; });
    resetAiSubtasks();
    registerAiSubtask(translateSubtask);
    registerControlHandler("translate_job", createTranslateJobHandler({ createRouter: () => { joined.resolve(); return interactiveAi.router; } }));
    const step = createAiStep({ loadAiConfig: () => config, createRouter: () => lateAi.router, phase: "late" });
    const ctx: CycleStepContext = { cycle: { id: null, kind: "manual" }, windowKind: null, dryRun: false, db: getDb(), signal: new AbortController().signal, logger, now: () => NOW, config: cycleConfig(), channels: undefined as never, results: {} };
    const late = step(ctx);
    let interactive: ReturnType<typeof processNextControlRequest> | undefined;
    try {
      await entered.promise;
      await insertControlRequest(getDb(), { kind: "translate_job", payload: { jobId: ids.top, force: true } });
      interactive = processNextControlRequest({ db: getDb(), signal: ctx.signal, logger, lane: "interactive" });
      await joined.promise;
    } finally {
      release.resolve();
      await late;
      await interactive;
      resetControlHandlers();
      resetAiSubtasks();
    }
    expect(await interactive).toMatchObject({ status: "done" });
    expect(lateAi.calls()).toBe(splitIntoChunks(text, 500).length);
    expect(interactiveAi.calls()).toBe(0);
  });

  it("translates on the first request, writes the cache and reads it on the second", async () => {
    const { router, calls } = fakeAi();
    const db = getDb();
    expect(await getTranslation(db, ids.low, "zh")).toBeNull();
    expect((await getJobDetail(db, ids.low))?.translatedLanguages).toEqual([]);

    const first = await ensureTranslation(db, router, ids.low, { now: () => NOW });
    expect(first.status).toBe("translated");
    expect(calls()).toBe(1);
    expect((await getJobDetail(db, ids.low))?.translatedLanguages).toEqual(["zh"]);

    const second = await ensureTranslation(db, router, ids.low);
    expect(second.status).toBe("cached");
    expect(second).toMatchObject({ translation: { stale: false, provider: "codex-cli" } });
    expect(calls()).toBe(1); // no second AI call
    if (first.status === "translated" && second.status === "cached") expect(second.translation.content).toBe(first.translation.content);
  });

  it("collapses concurrent requests for one job into one AI call", async () => {
    const { router, calls } = fakeAi();
    const [a, b] = await Promise.all([ensureTranslation(getDb(), router, ids.closed), ensureTranslation(getDb(), router, ids.closed)]);
    expect(a).toBe(b);
    expect(calls()).toBe(1);
  });

  it("marks the cached translation outdated when the JD changes, and translates again", async () => {
    const { router, calls } = fakeAi();
    const db = getDb();
    await ensureTranslation(db, router, ids.low, { now: () => NOW });
    await db.update(schema.jobs).set({ description: `${description(1)}\n\nNew paragraph about the benefits package and the team.` }).where(eq(schema.jobs.id, ids.low));
    const row = await getTranslation(db, ids.low, "zh");
    const [job] = await db.select({ description: schema.jobs.description }).from(schema.jobs).where(eq(schema.jobs.id, ids.low));
    expect(toJobTranslation(row!, job!.description).stale).toBe(true);
    expect((await listTranslationCandidates(db, { lang: "zh", minRank: 60, limit: 80 })).map((c) => c.jobId)).toContain(ids.low);

    const again = await ensureTranslation(db, router, ids.low);
    expect(again.status).toBe("translated");
    expect(calls()).toBe(2); // the first translation above, then this one
    expect(toJobTranslation((await getTranslation(db, ids.low, "zh"))!, job!.description).stale).toBe(false);
  });

  it("reports unknown jobs and jobs without JD text without calling the AI", async () => {
    const { router, calls } = fakeAi();
    expect(await ensureTranslation(getDb(), router, 987654)).toEqual({ status: "not_found" });
    expect(await ensureTranslation(getDb(), router, ids.noText)).toEqual({ status: "no_description" });
    expect(calls()).toBe(0);
  });

  it("does not store anything when the AI fails", async () => {
    const { provider } = scriptedProvider("codex-cli", [new Error("boom")]);
    const router = createAiRouter({ config: pinnedAi(), providers: [provider], usage: null });
    await expect(ensureTranslation(getDb(), router, ids.rescored)).rejects.toThrow();
    expect(await getTranslation(getDb(), ids.rescored, "zh")).toBeNull();
  });
});
