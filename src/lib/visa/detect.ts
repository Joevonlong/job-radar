/**
 * What a JD says about visa sponsorship, by rules (no AI, no tokens). Pure: the cycle's check stores the result, the deal-breaker
 * `visa_not_offered` and `pnpm visa:scan --text` compute it on the spot. docs/visa-sponsorship.md explains the states.
 *
 * Each segment (sentence, list item, heading + next line) is judged on its own:
 * 1. a segment matching `exclude_context` is skipped;
 * 2. an `offered` hit with a negation cue within six words before it (or inside it) counts as unclear, never as offered;
 * 3. a `permit_required` hit with a `permit_alternatives` phrase in the segment counts as unclear;
 * 4. offered and not_offered in one segment → unclear; only not_offered → not_offered; only offered (plus unclear hits) → unclear
 *    when an unclear hit is there, else offered; only unclear hits → unclear;
 * 5. no hit, but a visa word and a context word together → unclear (a mention).
 * Summed up: offered and not_offered segments → unclear (both quoted); else the one clear state; else unclear; else not_mentioned.
 * A text or segment without a `prefilter` match is skipped first (the packs promise every phrase contains one): the speed of the
 * deal-breaker, which runs this over every open job.
 */
import { segmentText, type TextSegment } from "@/lib/job-checks/segment";
import { clipQuote } from "@/lib/signals/quote";
import { overlapsTrap } from "@/lib/traps/ai-input";
import type { TrapSpan } from "@/lib/traps/types";

import { NEGATION_WINDOW_WORDS, type CompiledVisaPattern, type CompiledVisaRules } from "./rules";
import type { VisaEvidence, VisaKind, VisaResult } from "./types";

export interface DetectVisaOptions {
  /** The company's `name_norm`: when `exclude_companies` names it, only `combo` patterns count. */
  companyNameNorm?: string | null;
  /** Pieces of the JD hidden from readers (AI trap findings): hits inside them do not count. The filter's call passes none. */
  trapSpans?: readonly TrapSpan[];
}

interface Hit {
  start: number;
  end: number;
}

interface Verdict {
  status: VisaEvidence["status"];
  kind: VisaKind;
  segment: TextSegment;
  hit: Hit;
}

const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;

const notMentioned = (): VisaResult => ({ status: "not_mentioned", evidence: [] });

function matches(re: RegExp, text: string): boolean {
  return text.search(re) !== -1;
}

/** Hits of the usable patterns in the segment, in description offsets, without those inside hidden text. */
function hitsOf(patterns: readonly CompiledVisaPattern[], segment: TextSegment, usable: (p: CompiledVisaPattern) => boolean, keep: (hit: Hit) => boolean): Hit[] {
  const hits: Hit[] = [];
  for (const pattern of patterns) {
    if (!usable(pattern)) continue;
    for (const match of segment.text.matchAll(pattern.re)) {
      if (match[0].length === 0) continue;
      const hit = { start: segment.start + match.index, end: segment.start + match.index + match[0].length };
      if (keep(hit)) hits.push(hit);
    }
  }
  return hits.sort((a, b) => a.start - b.start || a.end - b.end);
}

function anyHit(patterns: readonly RegExp[], segment: TextSegment, keep: (hit: Hit) => boolean): boolean {
  for (const re of patterns) {
    for (const match of segment.text.matchAll(re)) {
      if (match[0].length === 0) continue;
      if (keep({ start: segment.start + match.index, end: segment.start + match.index + match[0].length })) return true;
    }
  }
  return false;
}

/** A negation cue among the six words before the hit (in its segment) or inside it. */
function negated(segment: TextSegment, hit: Hit, cues: readonly RegExp[]): boolean {
  if (cues.length === 0) return false;
  const before = Array.from(segment.text.slice(0, hit.start - segment.start).matchAll(WORD), (m) => m[0]).slice(-NEGATION_WINDOW_WORDS);
  const inside = Array.from(segment.text.slice(hit.start - segment.start, hit.end - segment.start).matchAll(WORD), (m) => m[0]);
  return [...before, ...inside].some((word) => cues.some((cue) => cue.test(word)));
}

function judgeSegment(segment: TextSegment, rules: CompiledVisaRules, usable: (p: CompiledVisaPattern) => boolean, keep: (hit: Hit) => boolean): Verdict | null {
  if (rules.excludeContext.some((re) => matches(re, segment.text))) return null;
  const offered = hitsOf(rules.offered, segment, usable, keep);
  const refused = hitsOf(rules.noSponsorship, segment, usable, keep).map((hit) => ({ hit, kind: "no_sponsorship" as const }));
  const required = hitsOf(rules.permitRequired, segment, usable, keep);
  const alternative = required.length > 0 && rules.permitAlternatives.some((re) => matches(re, segment.text));

  const clearOffers = offered.filter((hit) => !negated(segment, hit, rules.negationCues));
  const unclear: Hit[] = offered.filter((hit) => !clearOffers.includes(hit));
  const refusals: Array<{ hit: Hit; kind: Exclude<VisaKind, null> }> = [...refused];
  if (alternative) unclear.push(...required);
  else refusals.push(...required.map((hit) => ({ hit, kind: "permit_required" as const })));
  refusals.sort((a, b) => a.hit.start - b.hit.start);
  unclear.sort((a, b) => a.start - b.start);

  const first = refusals[0];
  const firstOffer = clearOffers[0];
  if (firstOffer && first) return { status: "unclear", kind: null, segment, hit: firstOffer.start <= first.hit.start ? firstOffer : first.hit };
  if (first) return { status: "not_offered", kind: first.kind, segment, hit: first.hit };
  const firstUnclear = unclear[0];
  if (firstOffer && firstUnclear) return { status: "unclear", kind: null, segment, hit: firstOffer.start <= firstUnclear.start ? firstOffer : firstUnclear };
  if (firstOffer) return { status: "offered", kind: null, segment, hit: firstOffer };
  if (firstUnclear) return { status: "unclear", kind: null, segment, hit: firstUnclear };

  const term = hitsOf(rules.mentionTerms, segment, usable, keep)[0];
  if (term && anyHit(rules.mentionContext, segment, keep)) return { status: "unclear", kind: null, segment, hit: term };
  return null;
}

/** The quotes kept: the first of each clear state the result rests on, then the rest in text order, at most `max`; in text order. */
function pickEvidence(verdicts: readonly Verdict[], max: number, rules: CompiledVisaRules, description: string): VisaEvidence[] {
  const chosen = new Set<Verdict>();
  for (const status of ["not_offered", "offered"] as const) {
    const first = verdicts.find((v) => v.status === status);
    if (first && chosen.size < max) chosen.add(first);
  }
  for (const verdict of verdicts) {
    if (chosen.size >= max) break;
    chosen.add(verdict);
  }
  return verdicts
    .filter((v) => chosen.has(v))
    .map((v) => {
      const { quote, offset } = clipQuote(description, v.segment.start, v.segment.end, v.hit, rules.quoteMaxChars);
      return { status: v.status, kind: v.kind, quote, offset };
    });
}

export function detectVisa(description: string | null, rules: CompiledVisaRules, options: DetectVisaOptions = {}): VisaResult {
  if (description === null || description.trim() === "") return notMentioned();
  const prefilter = rules.prefilter;
  if (prefilter !== null && !prefilter.test(description)) return notMentioned();
  const name = options.companyNameNorm ?? "";
  const companyIsVisa = name !== "" && rules.excludeCompanies.some((re) => matches(re, name));
  const usable = (pattern: CompiledVisaPattern): boolean => !companyIsVisa || pattern.combo;
  const spans = options.trapSpans ?? [];
  const keep = (hit: Hit): boolean => spans.length === 0 || !overlapsTrap(hit.start, hit.end - hit.start, spans);

  const verdicts: Verdict[] = [];
  for (const segment of segmentText(description, rules.abbreviations)) {
    if (prefilter !== null && !prefilter.test(segment.text)) continue;
    const verdict = judgeSegment(segment, rules, usable, keep);
    if (verdict) verdicts.push(verdict);
  }
  if (verdicts.length === 0) return notMentioned();

  const offered = verdicts.some((v) => v.status === "offered");
  const refused = verdicts.some((v) => v.status === "not_offered");
  const status = offered && refused ? "unclear" : refused ? "not_offered" : offered ? "offered" : "unclear";
  return { status, evidence: pickEvidence(verdicts, rules.maxQuotes, rules, description) };
}
