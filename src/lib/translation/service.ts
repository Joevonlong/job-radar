import { AiProviderError } from "@/lib/ai/errors";
import type { AiRouter } from "@/lib/ai/router";
import type { AiProviderId } from "@/lib/ai/types";
import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig } from "@/lib/config";
import { translationTarget } from "@/lib/i18n/config";
import { sameLanguage } from "@/lib/i18n/languages";
import type { Executor } from "@/lib/db/executor";
import { cleanDescriptionForAi } from "@/lib/traps/clean";
import {
  deleteTranslationProgress,
  getJobForTranslation,
  getTranslation,
  getTranslationProgress,
  listJobSignalQuotes,
  saveTranslationProgress,
  upsertTranslation,
  type StoredTranslation,
  type TranslationProgress,
  type TranslationProgressChunk,
  type TranslationProgressError,
} from "@/lib/db/repos/translations";

import { joinChunks, splitIntoChunks } from "./chunk";
import { classifyTranslationFailure, TranslationIncompleteError, type TranslationFailure } from "./errors";
import { descriptionHash, isTranslationStale } from "./hash";
import { translateChunk } from "./translate";

export interface JobTranslation {
  content: string;
  provider: string | null;
  createdAt: Date;
  /** Made from an older version of the description. */
  stale: boolean;
}

export function toJobTranslation(row: StoredTranslation, description: string | null): JobTranslation {
  return { content: row.content, provider: row.provider, createdAt: row.createdAt, stale: isTranslationStale(row.sourceHash, description) };
}

export type EnsureTranslationResult =
  | { status: "cached" | "translated"; translation: JobTranslation }
  /** `same_language`: the job is already written in the target language, there is nothing to translate. */
  | { status: "not_found" | "no_description" | "same_language" };

export interface EnsureTranslationOptions {
  /** Translate again even when a current translation is cached. */
  force?: boolean;
  signal?: AbortSignal;
  logger?: ChannelLogger;
  now?: () => Date;
  /** Piece size and timeout (default: `ai.yaml: translation`). */
  settings?: TranslationSettings;
  /** Called after every piece that was translated and saved. */
  onProgress?: (progress: { done: number; total: number }) => void;
  /** The language to translate into (default: `language.yaml: translation.target`). */
  target?: string;
}

/** Requests in flight, so a double click (or a cycle running at the same time) pays for one translation. */
const inFlight = new Map<number, Promise<EnsureTranslationResult>>();

/**
 * The cached translation of a job into the target language when it is current, otherwise a new one from the AI, written to
 * `translations`. The JD is translated piece by piece and every finished piece is saved at once
 * (`translation_progress`), so a failure keeps what is done and the next call only translates the missing
 * pieces. When pieces are missing it throws `TranslationIncompleteError` (what is wrong, how far it got);
 * a cancel throws `AiProviderError("aborted")`.
 */
export function ensureTranslation(db: Executor, router: AiRouter, jobId: number, options: EnsureTranslationOptions = {}): Promise<EnsureTranslationResult> {
  const running = inFlight.get(jobId);
  if (running) return running;
  const promise = run(db, router, jobId, options).finally(() => {
    inFlight.delete(jobId);
  });
  inFlight.set(jobId, promise);
  return promise;
}

/** The two ai.yaml numbers the translation needs (`ai.yaml: translation`). */
export interface TranslationSettings {
  chunk_chars: number;
  chunk_timeout_seconds: number;
  /** Fixed renderings of terms (`translation.glossary`). */
  glossary?: Readonly<Record<string, string>>;
}

/** Providers that timed out or were rate limited are left alone for the rest of the job: the next piece would only wait again. */
const SKIPPABLE_KINDS: readonly string[] = ["timeout", "rate_limited"];

async function run(db: Executor, router: AiRouter, jobId: number, options: EnsureTranslationOptions): Promise<EnsureTranslationResult> {
  const job = await getJobForTranslation(db, jobId);
  if (!job) return { status: "not_found" };
  if (job.description === null || job.description.trim() === "") return { status: "no_description" };
  const target = options.target ?? translationTarget();
  if (sameLanguage(job.language, target)) return { status: "same_language" };

  if (!options.force) {
    const cached = await getTranslation(db, jobId, target);
    if (cached && !isTranslationStale(cached.sourceHash, job.description)) return { status: "cached", translation: toJobTranslation(cached, job.description) };
  }

  const settings = options.settings ?? loadConfig("ai").translation;
  // The AI translates the JD without hidden text and instructions to an AI; the cache key stays the stored JD's hash
  const forAi = (await cleanDescriptionForAi(db, { jobId, description: job.description }, options.logger ? { logger: options.logger } : {})) ?? job.description;
  const pieces = splitIntoChunks(forAi, settings.chunk_chars);
  const sourceHash = descriptionHash(job.description);
  const signals = await listJobSignalQuotes(db, jobId);

  // Pieces that came back during an earlier attempt are kept, as long as they belong to this text cut the same way.
  const earlier = await getTranslationProgress(db, jobId, target);
  const reusable = earlier !== null && earlier.sourceHash === sourceHash && earlier.totalChunks === pieces.length;
  const done = new Map<number, TranslationProgressChunk>(reusable ? earlier.chunks.filter((c) => c.index < pieces.length).map((c) => [c.index, c]) : []);
  const save = (lastError: TranslationProgressError | null): Promise<void> =>
    saveTranslationProgress(db, { jobId, lang: target, sourceHash, totalChunks: pieces.length, chunks: [...done.values()], lastError }, (options.now ?? (() => new Date()))());
  await save(null);
  if (done.size > 0) options.logger?.info("translation continues", { jobId, done: done.size, total: pieces.length });

  const skip = new Set<AiProviderId>();
  let firstFailure: { index: number; failure: TranslationFailure } | null = null;
  for (const [index, piece] of pieces.entries()) {
    if (done.has(index)) continue;
    if (options.signal?.aborted) throw new AiProviderError("claude-cli", "aborted", "cancelled");
    try {
      const result = await translateChunk(router, piece, { language: job.language, target, signals }, {
        ...(options.signal ? { signal: options.signal } : {}),
        jobId,
        timeoutMs: settings.chunk_timeout_seconds * 1000,
        ...(settings.glossary ? { glossary: settings.glossary } : {}),
        skipProviders: [...skip],
        onAttempt: (attempt) => {
          if (attempt.outcome === "failed" && SKIPPABLE_KINDS.includes(attempt.kind)) skip.add(attempt.provider);
        },
      });
      done.set(index, { index, content: result.content, provider: result.provider, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
      await save(firstFailure ? { chunk: firstFailure.index, code: firstFailure.failure.code, message: firstFailure.failure.message } : null);
      options.onProgress?.({ done: done.size, total: pieces.length });
    } catch (error) {
      if (error instanceof AiProviderError && error.kind === "aborted") throw error;
      const failure = classifyTranslationFailure(error);
      options.logger?.warn("translation piece failed", { jobId, piece: index + 1, of: pieces.length, code: failure.code, detail: failure.message });
      firstFailure ??= { index, failure };
      // A problem of the provider (down, login expired, nothing configured) hits the next piece too; a piece the
      // model could not translate properly does not.
      if (failure.providerWide) break;
    }
  }

  if (done.size < pieces.length) {
    const { index, failure } = firstFailure ?? { index: 0, failure: { code: "failed" as const, message: "unknown", providerWide: true } };
    await save({ chunk: index, code: failure.code, message: failure.message });
    throw new TranslationIncompleteError(failure, done.size, pieces.length);
  }

  const ordered = [...done.values()].sort((a, b) => a.index - b.index);
  const providers = [...new Set(ordered.map((c) => c.provider))].join(", ");
  const content = joinChunks(ordered.map((c) => c.content));
  const at = (options.now ?? (() => new Date()))();
  await upsertTranslation(db, { jobId, lang: target, provider: providers, content, sourceHash }, at);
  await deleteTranslationProgress(db, jobId, target);
  return { status: "translated", translation: { content, provider: providers, createdAt: at, stale: false } };
}

/** What a translation that is not finished shows: the pieces that are there, joined, and how far it got. */
export interface PartialTranslation {
  /** Finished pieces in order; a gap (a piece that failed) is a line with `…`. Empty when no piece is done yet. */
  content: string;
  done: number;
  total: number;
  providers: string;
  lastError: { chunk: number; code: string; message: string } | null;
  updatedAt: Date;
}

/** The unfinished translation of a job for the current description, or null (none, or made from an older text). */
export function toPartialTranslation(progress: TranslationProgress, description: string | null): PartialTranslation | null {
  if (progress.sourceHash !== descriptionHash(description)) return null;
  const ordered = [...progress.chunks].sort((a, b) => a.index - b.index);
  const parts: string[] = [];
  let next = 0;
  for (const chunk of ordered) {
    if (chunk.index > next) parts.push("…");
    parts.push(chunk.content);
    next = chunk.index + 1;
  }
  return {
    content: parts.length === 0 ? "" : joinChunks(parts),
    done: ordered.length,
    total: progress.totalChunks,
    providers: [...new Set(ordered.map((c) => c.provider))].join(", "),
    lastError: progress.lastError,
    updatedAt: progress.updatedAt,
  };
}
