/**
 * Reason sources: where each fit reason and gap of a score comes from. The model marks a reason `jd` (with a verbatim quote),
 * `inferred` or, for a gap, `unstated`; this module checks every `jd` quote against the stored JD (C7) and keeps it only when the
 * JD really contains it outside an AI trap. A quote that is not found makes the reason `inferred`; the reason itself stays.
 * Pure functions: the scoring task loads the JD and the trap spans, the repository stores the result.
 */
import { z } from "zod";

import { MAX_FIT_REASONS, MAX_GAPS, type ReasonBasis, type ReasonItem, type ScoreOutput } from "@/lib/ai/prompts/score";
import { overlapsTrap } from "@/lib/traps/ai-input";
import { locateLoose } from "@/lib/traps/locate";
import type { TrapSpan } from "@/lib/traps/types";

/** Version of the stored evidence (`scores.reason_evidence.v`): bumped when the prompt's lines about sources change, never `score-v1`. */
export const REASON_EVIDENCE_VERSION = 1;

/** The source of one reason as stored: `quote` is the JD's own text at `offset` (only with `jd`). */
export interface ReasonSource {
  basis: ReasonBasis | null;
  quote: string | null;
  offset: number | null;
}

/** `scores.reason_evidence`: one source per reason and per gap, by index, aligned with `fit_reasons` and `gaps`. */
export interface ReasonEvidence {
  v: number;
  fit: ReasonSource[];
  gaps: ReasonSource[];
}

export interface ResolveContext {
  /** The stored JD (`jobs.description`), not the cut text the model read: what the model quotes lies in it. */
  description: string | null;
  /** The JD's AI trap findings: a quote that touches one is not evidence. */
  trapSpans: readonly TrapSpan[];
}

/** A reason with its checked source. */
export interface ResolvedReason extends ReasonSource {
  text: string;
}

/** A reason of the model's answer in one shape: a plain string (sources off, or an old-shape answer) has no source. */
function asItem(value: string | ReasonItem): ReasonItem {
  return typeof value === "string" ? { text: value, basis: null, quote: null } : value;
}

/**
 * The scoring's `clean()` for reasons with their sources: trimmed, empty ones dropped, at most `max`. A dropped reason takes its
 * source with it, so what is left stays aligned by index.
 */
export function cleanReasons(items: ReadonlyArray<string | ReasonItem>, max: number): ReasonItem[] {
  return items
    .map(asItem)
    .map((item) => ({ ...item, text: item.text.trim() }))
    .filter((item) => item.text !== "")
    .slice(0, max);
}

/** One reason's source after the check, and whether a `jd` claim had to be downgraded. */
function resolveOne(item: ReasonItem, context: ResolveContext): { reason: ResolvedReason; downgraded: boolean } {
  const plain = { text: item.text, quote: null, offset: null };
  if (item.basis !== "jd") return { reason: { ...plain, basis: item.basis }, downgraded: false };
  const quote = item.quote?.trim() ?? "";
  const found = quote !== "" && context.description ? locateLoose(context.description, quote) : null;
  if (found === null || context.description === null || overlapsTrap(found.start, found.end - found.start, context.trapSpans)) {
    return { reason: { ...plain, basis: "inferred" }, downgraded: true };
  }
  return { reason: { text: item.text, basis: "jd", quote: context.description.slice(found.start, found.end), offset: found.start }, downgraded: false };
}

/**
 * Check the sources of cleaned reasons: a `jd` reason keeps its quote only when `locateLoose` finds it in the JD (whitespace and
 * bullets do not count) and it does not touch an AI trap; the stored quote is then the JD's own text. Otherwise the reason becomes
 * `inferred` (counted in `downgraded`). `inferred` / `unstated` drop any quote; a reason without a source stays without one.
 */
export function resolveReasons(items: readonly ReasonItem[], context: ResolveContext): { reasons: ResolvedReason[]; downgraded: number } {
  let downgraded = 0;
  const reasons = items.map((item) => {
    const one = resolveOne(item, context);
    if (one.downgraded) downgraded += 1;
    return one.reason;
  });
  return { reasons, downgraded };
}

export interface ScoredReasons {
  fitReasons: string[];
  gaps: string[];
  /** null when sources are off: the score is stored as before. */
  reasonEvidence: ReasonEvidence | null;
  /** `jd` reasons whose quote was not found in the JD (or touched a trap) and were stored as `inferred`. */
  downgraded: number;
}

/**
 * The reasons, gaps and their sources to store, built from one list each so the indexes line up: clean first, then check the
 * quotes, then split into the text arrays and the evidence.
 */
export function scoredReasons(output: Pick<ScoreOutput, "fit_reasons" | "gaps">, context: ResolveContext & { evidence: boolean }): ScoredReasons {
  const fit = cleanReasons(output.fit_reasons, MAX_FIT_REASONS);
  const gaps = cleanReasons(output.gaps, MAX_GAPS);
  if (!context.evidence) return { fitReasons: fit.map((r) => r.text), gaps: gaps.map((r) => r.text), reasonEvidence: null, downgraded: 0 };
  const resolvedFit = resolveReasons(fit, context);
  const resolvedGaps = resolveReasons(gaps, context);
  const source = ({ basis, quote, offset }: ResolvedReason): ReasonSource => ({ basis, quote, offset });
  return {
    fitReasons: resolvedFit.reasons.map((r) => r.text),
    gaps: resolvedGaps.reasons.map((r) => r.text),
    reasonEvidence: { v: REASON_EVIDENCE_VERSION, fit: resolvedFit.reasons.map(source), gaps: resolvedGaps.reasons.map(source) },
    downgraded: resolvedFit.downgraded + resolvedGaps.downgraded,
  };
}

const storedSource = z.object({
  basis: z.enum(["jd", "inferred", "unstated"]).nullable(),
  quote: z.string().nullable(),
  offset: z.number().int().nonnegative().nullable(),
});
const storedEvidence = z.object({ v: z.number().int().positive(), fit: z.array(storedSource), gaps: z.array(storedSource) });

/**
 * The stored evidence of a score as the detail page reads it: null when there is none, when it cannot be read, or when it does
 * not line up with the reasons and gaps it belongs to (bad data is shown as a score without sources, never guessed). A `jd`
 * source without a quote is shown as having no source.
 */
export function parseReasonEvidence(raw: unknown, counts: { fit: number; gaps: number }): ReasonEvidence | null {
  if (raw === null || raw === undefined) return null;
  const parsed = storedEvidence.safeParse(raw);
  if (!parsed.success) return null;
  const { fit, gaps, v } = parsed.data;
  if (fit.length !== counts.fit || gaps.length !== counts.gaps) return null;
  const tidy = (source: ReasonSource): ReasonSource => (source.basis === "jd" && (source.quote === null || source.quote.trim() === "") ? { basis: null, quote: null, offset: null } : source);
  return { v, fit: fit.map(tidy), gaps: gaps.map(tidy) };
}
