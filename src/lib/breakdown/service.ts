/** `runBreakdown`: the one place that turns a job's JD into a stored breakdown; the request handler and the cycle sub-task share it. */
import { breakdownOutputSchema, buildBreakdownPrompt, BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { aiOutputLanguage } from "@/lib/i18n/config";
import type { AiRouter } from "@/lib/ai/router";
import type { ChannelLogger } from "@/lib/channels/types";
import type { BreakdownConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getJobBreakdown, getJobForBreakdown, upsertJobBreakdown } from "@/lib/db/repos/breakdowns";
import { cleanDescriptionForAi } from "@/lib/traps/clean";
import { descriptionHash } from "@/lib/translation/hash";

import { countItems } from "./content";
import { verifyBreakdown } from "./verify";

export type BreakdownRunOutcome =
  | { status: "done"; cached: boolean; provider: string | null; model: string | null; items: number; dropped: number }
  | { status: "failed"; error: "not_found" | "no_description" | "no_verified_quotes" };

export interface BreakdownRunOptions {
  /** Break down again although a current breakdown exists. */
  force: boolean;
  settings: BreakdownConfig;
  signal?: AbortSignal;
  logger?: ChannelLogger;
  /** The language to write in (default: `language.yaml: ai.output`). */
  outputLanguage?: string;
}

/**
 * Break one job down. AI errors (`AiUnavailableError`, `AiProviderError`) are thrown as they are; the caller classifies them.
 * Only the title, the company and the JD go to the AI (C5); every item is checked against the JD (C7) before it is saved.
 */
export async function runBreakdown(db: Db, router: AiRouter, jobId: number, opts: BreakdownRunOptions): Promise<BreakdownRunOutcome> {
  const job = await getJobForBreakdown(db, jobId);
  if (!job) return { status: "failed", error: "not_found" };
  const description = job.description;
  if (description === null || description.trim() === "") return { status: "failed", error: "no_description" };
  const hash = descriptionHash(description);

  if (!opts.force) {
    const existing = await getJobBreakdown(db, jobId);
    if (existing && existing.sourceHash === hash && existing.promptVersion === BREAKDOWN_PROMPT_VERSION) {
      return { status: "done", cached: true, provider: existing.provider, model: existing.model, items: 0, dropped: existing.droppedItems };
    }
  }

  // Written in language.yaml's ai.output; a breakdown in another language is marked on the page, not re-run by itself
  const outputLanguage = opts.outputLanguage ?? aiOutputLanguage();
  // The AI reads the JD without hidden text and instructions to an AI; its quotes are checked against the stored JD
  const forAi = (await cleanDescriptionForAi(db, { jobId, description }, opts.logger ? { logger: opts.logger } : {})) ?? description;
  const prompt = buildBreakdownPrompt({
    title: job.title,
    company: job.company,
    description: forAi,
    jdMaxChars: opts.settings.jd_max_chars,
    jdHeadShare: opts.settings.jd_head_share,
    outputLanguage,
  });
  const result = await router.run("breakdown", prompt, breakdownOutputSchema, {
    timeoutMs: opts.settings.timeout_seconds * 1000,
    jobId,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const verified = verifyBreakdown(result.value, description);
  const items = countItems(verified.content);
  if (verified.returned > 0 && items === 0) return { status: "failed", error: "no_verified_quotes" };

  await upsertJobBreakdown(db, {
    jobId,
    sourceHash: hash,
    promptVersion: BREAKDOWN_PROMPT_VERSION,
    provider: result.provider,
    model: result.model,
    content: verified.content,
    droppedItems: verified.dropped,
    outputLang: outputLanguage,
  });
  opts.logger?.info("job broken down", { jobId, provider: result.provider, model: result.model, items, dropped: verified.dropped });
  return { status: "done", cached: false, provider: result.provider, model: result.model, items, dropped: verified.dropped };
}
