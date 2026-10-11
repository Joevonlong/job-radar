import { and, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { z } from "zod";

import { jobs, scores, signals, translationProgress, translations } from "../schema";

export interface StoredTranslation {
  jobId: number;
  lang: string;
  provider: string | null;
  content: string;
  /** SHA-256 (hex) of the description this translation was made from. */
  sourceHash: string;
  createdAt: Date;
}

export async function getTranslation(db: Executor, jobId: number, lang: string): Promise<StoredTranslation | null> {
  const [row] = await db
    .select()
    .from(translations)
    .where(and(eq(translations.jobId, jobId), eq(translations.lang, lang)))
    .limit(1);
  return row ?? null;
}

export interface TranslationInput {
  jobId: number;
  lang: string;
  provider: string | null;
  content: string;
  sourceHash: string;
}

/** One translation per (job, language); a new one replaces the old (re-translation after the JD changed). */
export async function upsertTranslation(db: Executor, input: TranslationInput, at: Date = new Date()): Promise<void> {
  await db
    .insert(translations)
    .values({ ...input, createdAt: at })
    .onConflictDoUpdate({
      target: [translations.jobId, translations.lang],
      set: { provider: input.provider, content: input.content, sourceHash: input.sourceHash, createdAt: at },
    });
}

export interface TranslationCandidate {
  jobId: number;
  description: string;
  language: string;
  rankValue: number;
}

/** SQL for the SHA-256 (hex) of a description, identical to `descriptionHash` in `lib/translation/hash.ts`. */
export const descriptionHashSql = sql<string>`encode(sha256(convert_to(${jobs.description}, 'UTF8')), 'hex')`;

/**
 * Jobs the cycle should translate automatically: the newest score has `rank_value >= minRank`, the job
 * is not closed, has a description, and has no translation in `lang` yet, or one made from an older
 * description. Best rank first.
 */
export async function listTranslationCandidates(db: Executor, args: { lang: string; minRank: number; limit: number }): Promise<TranslationCandidate[]> {
  const latest = db
    .selectDistinctOn([scores.jobId], { jobId: scores.jobId, rankValue: scores.rankValue })
    .from(scores)
    .orderBy(scores.jobId, desc(scores.createdAt), desc(scores.id))
    .as("latest_score");
  const rows = await db
    .select({ jobId: jobs.id, description: jobs.description, language: jobs.language, rankValue: latest.rankValue })
    .from(jobs)
    .innerJoin(latest, eq(latest.jobId, jobs.id))
    .leftJoin(translations, and(eq(translations.jobId, jobs.id), eq(translations.lang, args.lang)))
    .where(
      and(
        isNotNull(latest.rankValue),
        sql`${latest.rankValue} >= ${args.minRank}`,
        ne(jobs.status, "closed"),
        isNotNull(jobs.description),
        sql`btrim(${jobs.description}) <> ''`,
        sql`(${translations.jobId} is null or ${translations.sourceHash} <> ${descriptionHashSql})`,
        // A job already written in the target language is never translated (`jobs.language` holds primary subtags)
        ne(jobs.language, args.lang.split("-")[0]?.toLowerCase() ?? args.lang),
      ),
    )
    .orderBy(desc(latest.rankValue), jobs.id)
    .limit(args.limit);
  const out: TranslationCandidate[] = [];
  for (const row of rows) {
    if (row.description === null || row.rankValue === null) continue;
    out.push({ jobId: row.jobId, description: row.description, language: row.language, rankValue: row.rankValue });
  }
  return out;
}

/** The job's description and language for a translation request (null: unknown job). */
export async function getJobForTranslation(db: Executor, jobId: number): Promise<{ id: number; description: string | null; language: string } | null> {
  const [row] = await db.select({ id: jobs.id, description: jobs.description, language: jobs.language }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

/** The quotes of the job's signals (C7: verbatim JD text), for highlighting them in the translation. */
export async function listJobSignalQuotes(db: Executor, jobId: number): Promise<Array<{ tier: (typeof signals.$inferSelect)["tier"]; quote: string }>> {
  return db.select({ tier: signals.tier, quote: signals.quote }).from(signals).where(eq(signals.jobId, jobId)).orderBy(asc(signals.tier), asc(signals.id));
}

// ---------------------------------------------------------------- unfinished translations

const progressChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  content: z.string(),
  provider: z.string(),
  tokensIn: z.number().int().nonnegative().catch(0),
  tokensOut: z.number().int().nonnegative().catch(0),
});
export type TranslationProgressChunk = z.infer<typeof progressChunkSchema>;

const progressErrorSchema = z.object({ chunk: z.number().int().nonnegative(), code: z.string(), message: z.string() });
export type TranslationProgressError = z.infer<typeof progressErrorSchema>;

export interface TranslationProgress {
  jobId: number;
  lang: string;
  sourceHash: string;
  totalChunks: number;
  /** The finished pieces, in the order they were saved. */
  chunks: TranslationProgressChunk[];
  lastError: TranslationProgressError | null;
  updatedAt: Date;
}

export async function getTranslationProgress(db: Executor, jobId: number, lang: string): Promise<TranslationProgress | null> {
  const [row] = await db
    .select()
    .from(translationProgress)
    .where(and(eq(translationProgress.jobId, jobId), eq(translationProgress.lang, lang)))
    .limit(1);
  if (!row) return null;
  const chunks = z.array(progressChunkSchema).safeParse(row.chunks);
  const lastError = progressErrorSchema.safeParse(row.lastError);
  return {
    jobId: row.jobId,
    lang: row.lang,
    sourceHash: row.sourceHash,
    totalChunks: row.totalChunks,
    chunks: chunks.success ? chunks.data : [],
    lastError: lastError.success ? lastError.data : null,
    updatedAt: row.updatedAt,
  };
}

/** Replace the progress of (job, language) with `input` (one writer per job, so the whole row is written). */
export async function saveTranslationProgress(
  db: Executor,
  input: { jobId: number; lang: string; sourceHash: string; totalChunks: number; chunks: readonly TranslationProgressChunk[]; lastError: TranslationProgressError | null },
  at: Date = new Date(),
): Promise<void> {
  const values = { sourceHash: input.sourceHash, totalChunks: input.totalChunks, chunks: [...input.chunks], lastError: input.lastError, updatedAt: at };
  await db
    .insert(translationProgress)
    .values({ jobId: input.jobId, lang: input.lang, ...values })
    .onConflictDoUpdate({ target: [translationProgress.jobId, translationProgress.lang], set: values });
}

export async function deleteTranslationProgress(db: Executor, jobId: number, lang: string): Promise<void> {
  await db.delete(translationProgress).where(and(eq(translationProgress.jobId, jobId), eq(translationProgress.lang, lang)));
}
