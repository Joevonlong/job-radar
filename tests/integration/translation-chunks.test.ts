import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { AiProviderError } from "@/lib/ai/errors";
import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import { createLogger } from "@/lib/channels/logger";
import { processNextControlRequest, registerControlHandler, resetControlHandlers, aiWorkerRequestKinds } from "@/lib/control";
import { createTranslateJobHandler } from "@/lib/control/translate-job";
import { readPartialTranslation, readTranslateRequest, requestTranslateJob } from "@/lib/control/translate-request";
import { closeDb, getDb, getTranslation, getTranslationProgress, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { classifyTranslationFailure, TranslationIncompleteError } from "@/lib/translation/errors";
import { ensureTranslation, type TranslationSettings } from "@/lib/translation/service";

import { pinnedAi } from "../ai/helpers";

/** These tests exercise fallback from the first provider; pin translate to the global order (claude-cli first). */
const claudeFirstAi = () => pinnedAi((raw) => { raw.order = ["claude-cli", "codex-cli", "api"]; (raw.tasks as Record<string, unknown>).translate = {}; });

const url = inject("testDatabaseUrl");
const logger = createLogger({ sink: () => {} });
const db = () => getDb();
const SETTINGS: TranslationSettings = { chunk_chars: 600, chunk_timeout_seconds: 7 };

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(() => db().execute(sql`truncate table control_requests, translation_progress, translations, jobs, companies restart identity cascade`));
afterEach(() => resetControlHandlers());
afterAll(async () => {
  await db().execute(sql`truncate table control_requests, translation_progress, translations, jobs, companies restart identity cascade`);
  await closeDb();
});

/** Four paragraphs of about 500 characters: with 600-character pieces every paragraph is one piece. */
const paragraph = (n: number): string => `Paragraph ${n}: ${"We build careful retrieval systems for clinical data. ".repeat(9)}`.trim();
const DESCRIPTION = [1, 2, 3, 4].map(paragraph).join("\n\n");

async function addJob(description: string | null = DESCRIPTION): Promise<number> {
  const [company] = await db().insert(schema.companies).values({ name: "Acme", nameNorm: "acme" }).onConflictDoNothing().returning();
  const companyId = company?.id ?? (await db().select().from(schema.companies).limit(1))[0]!.id;
  const [job] = await db().insert(schema.jobs).values({ companyId, title: "ML Engineer", titleNorm: `ml engineer ${Math.random()}`, description, language: "en" }).returning();
  return job!.id;
}

const pieceOf = (request: AiTransportRequest): number => Number(/Paragraph (\d)/.exec(request.user)?.[1] ?? 0);
const chinese = (n: number): string => `第${n}段：${"我们为临床数据构建严谨的检索系统。".repeat(8)}`;

type Behaviour = (piece: number, call: number) => Error | "ok" | "garbage";

/** A provider that answers each piece as `behaviour` says; records which pieces it was asked for. */
function fakeProvider(id: "claude-cli" | "codex-cli", behaviour: Behaviour) {
  const pieces: number[] = [];
  const timeouts: Array<number | undefined> = [];
  const transport: AiTransport = {
    id,
    availability: () => ({ available: true }),
    async call(request) {
      const piece = pieceOf(request);
      pieces.push(piece);
      timeouts.push(request.timeoutMs);
      const outcome = behaviour(piece, pieces.length);
      if (outcome instanceof Error) throw outcome;
      const text = outcome === "garbage" ? "not json at all" : JSON.stringify({ translation: chinese(piece) });
      return { text, model: `${id}-model`, usage: { tokensIn: 100, tokensOut: 50 } };
    },
  };
  return { id, pieces, timeouts, provider: createProvider(transport) };
}

const router = (...fakes: Array<ReturnType<typeof fakeProvider>>) => createAiRouter({ config: claudeFirstAi(), providers: fakes.map((f) => f.provider), usage: null });
const timeout = (id: "claude-cli" | "codex-cli") => new AiProviderError(id, "timeout", "timed out after 7s");
const ensure = (r: ReturnType<typeof router>, jobId: number, over: Partial<Parameters<typeof ensureTranslation>[3]> = {}) => ensureTranslation(db(), r, jobId, { settings: SETTINGS, logger, ...over });

describe("a long JD is translated piece by piece", () => {
  it("falls back to the next provider after a timeout and does not wait for the slow one again", async () => {
    const claude = fakeProvider("claude-cli", () => timeout("claude-cli"));
    const codex = fakeProvider("codex-cli", () => "ok");
    const jobId = await addJob();
    const outcome = await ensure(router(claude, codex), jobId);

    expect(outcome.status).toBe("translated");
    // claude-cli is tried once (the first piece), then skipped for the other three
    expect(claude.pieces).toEqual([1]);
    expect(codex.pieces).toEqual([1, 2, 3, 4]);
    // every call got the per-piece limit of ai.yaml: translation.chunk_timeout_seconds
    expect([...claude.timeouts, ...codex.timeouts].every((t) => t === 7000)).toBe(true);
    const stored = await getTranslation(db(), jobId, "zh");
    expect(stored?.provider).toBe("codex-cli");
    expect(stored?.content).toContain("第1段");
    expect(stored?.content).toContain("第4段");
    // finished: nothing left over
    expect(await getTranslationProgress(db(), jobId, "zh")).toBeNull();
  });

  it("keeps the finished pieces when one fails, and the retry translates only the missing ones", async () => {
    const jobId = await addJob();
    let broken = true;
    const codex = fakeProvider("codex-cli", (piece) => (piece === 2 && broken ? new AiProviderError("codex-cli", "provider_error", "exit code 1") : "ok"));
    const claude = fakeProvider("claude-cli", () => timeout("claude-cli"));

    await expect(ensure(router(claude, codex), jobId)).rejects.toMatchObject({ name: "TranslationIncompleteError", done: 1, total: 4, failure: { code: "timeout" } });
    // no half translation is presented as the translation
    expect(await getTranslation(db(), jobId, "zh")).toBeNull();
    const progress = await getTranslationProgress(db(), jobId, "zh");
    expect(progress?.totalChunks).toBe(4);
    expect(progress?.chunks.map((c) => c.index)).toEqual([0]);
    expect(progress?.lastError).toMatchObject({ chunk: 1, code: "timeout" });
    const partial = await readPartialTranslation(db(), jobId);
    expect(partial).toMatchObject({ done: 1, total: 4 });
    expect(partial?.content).toContain("第1段");

    // the retry: the provider works now; pieces 2, 3 and 4 are requested, piece 1 is not
    broken = false;
    const claude2 = fakeProvider("claude-cli", () => "ok");
    const codex2 = fakeProvider("codex-cli", () => "ok");
    const outcome = await ensure(router(claude2, codex2), jobId);
    expect(outcome.status).toBe("translated");
    expect(claude2.pieces).toEqual([2, 3, 4]);
    expect(codex2.pieces).toEqual([]);
    const stored = await getTranslation(db(), jobId, "zh");
    expect(stored?.content.indexOf("第1段")).toBeLessThan(stored?.content.indexOf("第2段") ?? -1);
    expect(stored?.provider).toBe("codex-cli, claude-cli");
    expect(await getTranslationProgress(db(), jobId, "zh")).toBeNull();
  });

  it("goes on with the next piece when only one piece could not be translated, and marks the gap", async () => {
    const jobId = await addJob();
    const codex = fakeProvider("codex-cli", (piece) => (piece === 2 ? "garbage" : "ok"));
    await expect(ensure(router(codex), jobId)).rejects.toMatchObject({ done: 3, total: 4, failure: { code: "invalid_output", providerWide: false } });
    const partial = await readPartialTranslation(db(), jobId);
    expect(partial).toMatchObject({ done: 3, total: 4, lastError: { chunk: 1, code: "invalid_output" } });
    expect(partial?.content).toContain("第1段");
    expect(partial?.content).toContain("…");
    expect(partial?.content).toContain("第3段");
  });

  it("starts over when the description changed since the pieces were saved", async () => {
    const jobId = await addJob();
    const broken = fakeProvider("codex-cli", (piece) => (piece === 2 ? new AiProviderError("codex-cli", "auth", "login expired") : "ok"));
    await expect(ensure(router(broken), jobId)).rejects.toBeInstanceOf(TranslationIncompleteError);
    expect((await getTranslationProgress(db(), jobId, "zh"))?.chunks).toHaveLength(1);

    await db().update(schema.jobs).set({ description: [5, 6].map(paragraph).join("\n\n").replaceAll("Paragraph 5", "Paragraph 1").replaceAll("Paragraph 6", "Paragraph 2") }).where(eq(schema.jobs.id, jobId));
    expect(await readPartialTranslation(db(), jobId)).toBeNull();
    const fresh = fakeProvider("codex-cli", () => "ok");
    expect((await ensure(router(fresh), jobId)).status).toBe("translated");
    expect(fresh.pieces).toEqual([1, 2]);
  });

  it("a forced new translation of a finished one starts from scratch", async () => {
    const jobId = await addJob();
    await ensure(router(fakeProvider("codex-cli", () => "ok")), jobId);
    const again = fakeProvider("codex-cli", () => "ok");
    expect((await ensure(router(again), jobId, { force: true })).status).toBe("translated");
    expect(again.pieces).toEqual([1, 2, 3, 4]);
  });
});

describe("the real cause of a failure is named", () => {
  const fail = async (fakes: Array<ReturnType<typeof fakeProvider>>) => {
    const jobId = await addJob();
    try {
      await ensure(router(...fakes), jobId);
    } catch (error) {
      return classifyTranslationFailure(error);
    }
    throw new Error("expected a failure");
  };

  it("timeout, login problem, provider error, and nothing available are different codes", async () => {
    expect(await fail([fakeProvider("claude-cli", () => timeout("claude-cli")), fakeProvider("codex-cli", () => timeout("codex-cli"))])).toMatchObject({ code: "timeout" });
    expect(await fail([fakeProvider("claude-cli", () => new AiProviderError("claude-cli", "auth", "login expired"))])).toMatchObject({ code: "auth" });
    expect(await fail([fakeProvider("claude-cli", () => new AiProviderError("claude-cli", "provider_error", "boom"))])).toMatchObject({ code: "provider_error" });
    // a login problem on one provider and a timeout on the other: the login is what to fix first
    expect(await fail([fakeProvider("claude-cli", () => new AiProviderError("claude-cli", "auth", "x")), fakeProvider("codex-cli", () => timeout("codex-cli"))])).toMatchObject({ code: "auth" });
    const none: AiTransport = { id: "claude-cli", availability: () => ({ available: false, reason: "not found" }), call: async () => { throw new Error("never"); } };
    const empty = createAiRouter({ config: claudeFirstAi(), providers: [createProvider(none)], usage: null });
    const jobId = await addJob();
    await expect(ensure(empty, jobId)).rejects.toMatchObject({ failure: { code: "unavailable" }, done: 0 });
  });

  it("the message names the providers but nothing of the JD", async () => {
    const failure = await fail([fakeProvider("claude-cli", () => timeout("claude-cli")), fakeProvider("codex-cli", () => new AiProviderError("codex-cli", "provider_error", "boom"))]);
    expect(failure.message).toBe("claude-cli: timeout; codex-cli: provider_error");
  });
});

describe("translate_job reports progress and the cause", () => {
  it("a failed attempt reports the code, how far it got and keeps the pieces; the next request completes", async () => {
    const jobId = await addJob();
    let broken = true;
    const codex = fakeProvider("codex-cli", (piece) => (piece === 3 && broken ? timeout("codex-cli") : "ok"));
    registerControlHandler("translate_job", createTranslateJobHandler({ createRouter: () => router(codex), settings: SETTINGS }));
    const options = { db: db(), signal: new AbortController().signal, logger, kinds: () => aiWorkerRequestKinds("host") };

    const first = await requestTranslateJob(db(), { jobId, force: false, origin: "user" });
    if (first.state !== "queued") throw new Error("expected a queued request");
    expect(await processNextControlRequest(options)).toMatchObject({ status: "failed", result: { error: "timeout", done: 2, total: 4, detail: "codex-cli: timeout" } });
    const state = await readTranslateRequest(db(), { requestId: first.requestId, jobId });
    expect(state).toMatchObject({ state: "failed", error: "timeout", detail: "codex-cli: timeout", partial: { done: 2, total: 4 } });

    // retry: a new request, only the missing pieces are translated
    broken = false;
    codex.pieces.length = 0;
    const second = await requestTranslateJob(db(), { jobId, force: false, origin: "user" });
    if (second.state !== "queued") throw new Error("expected a queued request");
    expect(second.requestId).not.toBe(first.requestId);
    expect(await processNextControlRequest(options)).toMatchObject({ status: "done" });
    expect(codex.pieces).toEqual([3, 4]);
    expect(await readTranslateRequest(db(), { requestId: second.requestId, jobId })).toMatchObject({ state: "done" });
    expect(await readPartialTranslation(db(), jobId)).toBeNull();
  });

  it("while the request runs the page can read how many pieces are done", async () => {
    const jobId = await addJob();
    const queued = await requestTranslateJob(db(), { jobId, force: false, origin: "user" });
    if (queued.state !== "queued") throw new Error("expected a queued request");
    // no piece yet
    expect(await readTranslateRequest(db(), { requestId: queued.requestId, jobId })).toMatchObject({ state: "waiting", stage: "pending", partial: null });
    // The provider holds the third piece until the test lets it go, and says when it got there: the first two
    // pieces are saved by then (each is saved before the next one starts), so one read is enough, no polling.
    const gate = { release: () => {}, reached: () => {} };
    const blocked = new Promise<void>((resolve) => (gate.release = resolve));
    const atGate = new Promise<void>((resolve) => (gate.reached = resolve));
    const slow = fakeProvider("codex-cli", () => "ok");
    const wrapped = {
      ...slow.provider,
      run: async (...args: Parameters<typeof slow.provider.run>) => {
        if (pieceCount() >= 2) {
          gate.reached();
          await blocked;
        }
        return slow.provider.run(...args);
      },
    } as typeof slow.provider;
    const pieceCount = () => slow.pieces.length;
    registerControlHandler("translate_job", createTranslateJobHandler({ createRouter: () => createAiRouter({ config: claudeFirstAi(), providers: [wrapped], usage: null }), settings: SETTINGS }));
    const running = processNextControlRequest({ db: db(), signal: new AbortController().signal, logger, kinds: () => aiWorkerRequestKinds("host") });
    await atGate;
    const seen = await readTranslateRequest(db(), { requestId: queued.requestId, jobId });
    expect(seen).toMatchObject({ state: "waiting", stage: "running", partial: { done: 2, total: 4 } });
    gate.release();
    expect(await running).toMatchObject({ status: "done" });
  });
});
