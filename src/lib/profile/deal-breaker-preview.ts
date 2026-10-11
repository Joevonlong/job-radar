/**
 * What the user's deal-breakers would veto among the jobs in the database now: one count and a few examples per rule. The
 * `/me` card's preview and `pnpm deal-breakers:check` both call `previewDealBreakers`, so their numbers are the same. Read
 * only: nothing is written, the filter step applies the rules on its next run.
 */
import { z } from "zod";

import type { MeConfig, PipelineConfig } from "@/lib/config";
import { dealBreakerSchema, DEAL_BREAKER_HARD_LIMITS, type DealBreaker } from "@/lib/config/schemas/preferences";
import type { Db } from "@/lib/db/client";
import { listFilterCandidates } from "@/lib/db";
import { asGermanLevel } from "@/lib/db/queries/parse";
import { compileDealBreakers, dealBreakerHits, explainDealBreaker, type DealBreakerJob, type DealBreakerWarningCode, type CompiledDealBreaker } from "@/lib/filter/deal-breakers";

import { dealBreakerDraftSchema, dealBreakerDraftToCandidate } from "./draft";

/** Rows read from the database per query. */
const BATCH = 500;

export interface DealBreakerSample {
  jobId: number;
  title: string;
  company: string;
  /** The job's own words the rule rests on (`explain`): verbatim, null when there is none to show. */
  quote?: string | null;
}

export interface DealBreakerRulePreview {
  id: string;
  /** "ok": the rule runs; otherwise why it does nothing (it is still counted when it is only switched off). */
  status: "ok" | "disabled" | DealBreakerWarningCode;
  /** Jobs that are not closed that the rule vetoes (each rule on its own: a job vetoed by two rules counts for both). */
  count: number;
  samples: DealBreakerSample[];
  /** Time the rule took over every job (milliseconds), for the budget of `filter.deal_breakers.rule_warn_ms`. */
  ms: number;
}

export interface DealBreakerPreview {
  /** Jobs that are not closed: what the counts are out of. */
  total: number;
  rules: DealBreakerRulePreview[];
}

export interface PreviewOptions {
  pipeline: PipelineConfig;
  me: Pick<MeConfig, "languages"> | null;
  /** Examples per rule. */
  sampleLimit: number;
  /** Quote the job's words for each example (`explainDealBreaker`). */
  explain?: boolean;
}

interface Prepared {
  rule: DealBreaker;
  /** Null: the rule does nothing (see `status`). */
  compiled: CompiledDealBreaker | null;
  result: DealBreakerRulePreview;
}

function prepare(rules: readonly DealBreaker[], options: PreviewOptions): Prepared[] {
  const limits = options.pipeline.filter.deal_breakers;
  const context = { language: options.pipeline.market.language?.code ?? null, me: options.me, limits };
  return rules.map((rule, index) => {
    const result: DealBreakerRulePreview = { id: rule.id, status: "ok", count: 0, samples: [], ms: 0 };
    if (index >= limits.max_rules) return { rule, compiled: null, result: { ...result, status: "too_many_rules" } };
    // a rule that is switched off is still counted: the preview is how the user decides to switch it on
    const compiled = compileDealBreakers([{ ...rule, enabled: true }], context);
    const warning = compiled.warnings[0];
    if (warning) return { rule, compiled: null, result: { ...result, status: warning.code } };
    return { rule, compiled: compiled.rules[0] ?? null, result: { ...result, status: rule.enabled ? "ok" : "disabled" } };
  });
}

/** Count what each rule vetoes among the jobs that are not closed (the jobs the filter step evaluates). */
export async function previewDealBreakers(db: Db, rules: readonly DealBreaker[], options: PreviewOptions): Promise<DealBreakerPreview> {
  const prepared = prepare(rules, options);
  const maxChars = options.pipeline.filter.deal_breakers.match_text_max_chars;
  const context = { language: options.pipeline.market.language?.code ?? null, me: options.me, limits: options.pipeline.filter.deal_breakers };
  let total = 0;
  for (let afterId = 0; ; ) {
    const batch = await listFilterCandidates(db, { afterId, limit: BATCH });
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]?.id ?? afterId;
    total += batch.length;
    const jobs = batch.map((row) => ({ row, job: { title: row.title, description: row.description, germanLevel: asGermanLevel(row.germanLevel) } satisfies DealBreakerJob }));
    for (const entry of prepared) {
      if (entry.compiled === null) continue;
      const started = performance.now();
      for (const { row, job } of jobs) {
        if (!dealBreakerHits(job, entry.compiled, maxChars)) continue;
        entry.result.count += 1;
        if (entry.result.samples.length < options.sampleLimit) {
          const sample: DealBreakerSample = { jobId: row.id, title: row.title, company: row.companyName };
          if (options.explain) sample.quote = explainDealBreaker(job, entry.rule, context, options.pipeline)?.quote ?? null;
          entry.result.samples.push(sample);
        }
      }
      entry.result.ms += performance.now() - started;
    }
  }
  return { total, rules: prepared.map((entry) => ({ ...entry.result, ms: Math.round(entry.result.ms * 10) / 10 })) };
}

/** The form's rules as sent by the browser: drafts, validated here (C6). */
export const previewRequestSchema = z.array(dealBreakerDraftSchema).max(DEAL_BREAKER_HARD_LIMITS.rules);

/** One row of the form's preview: the rule's result, or "invalid" while the row cannot be saved as it is. */
export type DraftPreviewRule = DealBreakerRulePreview | { id: string; status: "invalid"; count: 0; samples: []; ms: 0 };

/**
 * Preview the form's rules (drafts): each row that is a valid rule is counted; the others say "invalid" (the save shows
 * why). Duplicate ids are counted on their own; saving refuses them.
 */
export async function previewDealBreakerDrafts(db: Db, drafts: z.infer<typeof previewRequestSchema>, options: PreviewOptions): Promise<{ total: number; rules: DraftPreviewRule[] }> {
  const parsed = drafts.map((draft) => dealBreakerSchema.safeParse(dealBreakerDraftToCandidate(draft)));
  const valid = parsed.flatMap((result) => (result.success ? [result.data] : []));
  const preview = await previewDealBreakers(db, valid, options);
  let next = 0;
  const rules = parsed.map((result, index): DraftPreviewRule => {
    if (!result.success) return { id: drafts[index]?.id ?? "", status: "invalid", count: 0, samples: [], ms: 0 };
    const rule = preview.rules[next];
    next += 1;
    return rule ?? { id: result.data.id, status: "invalid", count: 0, samples: [], ms: 0 };
  });
  return { total: preview.total, rules };
}
