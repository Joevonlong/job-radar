/**
 * What a JD says about visa sponsorship, by rules (no AI, no tokens). Pure: the cycle's check stores the result, the deal-breaker
 * `visa_not_offered` and `pnpm visa:scan --text` compute it on the spot. docs/visa-sponsorship.md explains the states.
 *
 * Each segment (sentence, list item, short heading + next line) is judged on its own:
 * 1. a segment matching `exclude_context` is skipped; a `list_item` pattern counts only in a list item;
 * 2. an `offered` hit with a negation cue inside it, within `negation_words_before` words before it, within `negation_words_after`
 *    words after it up to a `clause_breaks` match, or in the heading of its list ("What we can't offer:" / "- Visa sponsorship")
 *    counts as unclear, never as offered;
 * 3. a `permit_required` hit with a `permit_alternatives` phrase in the segment counts as unclear;
 * 4. offered and not_offered in one segment → unclear; only not_offered → not_offered; only offered (plus unclear hits) → unclear
 *    when an unclear hit is there, else offered; only unclear hits → unclear;
 * 5. no hit, but a visa word and a context word together → unclear (a mention);
 * 6. a heading about visas read with its next line, where that line has a negation cue ("Visa sponsorship" / "We can't help with
 *    this.") → unclear, and so is a list under a negated heading: such a heading block keeps the whole result from being offered.
 * Summed up: offered and not_offered segments → unclear (both quoted); else not_offered; else offered unless a heading block of 6.
 * doubts it; else unclear; else not_mentioned.
 * A text, line or segment without a `prefilter` match is skipped first (the packs promise every phrase contains one, and
 * `pnpm config:check` warns about a pattern that breaks it): the speed of the deal-breaker, which runs this over every open job. Only
 * the lines with a prefilter match (with their heading) are cut into sentences.
 */
import { segmentText, type TextSegment } from "@/lib/job-checks/segment";
import { clipQuote } from "@/lib/signals/quote";
import { overlapsTrap } from "@/lib/traps/ai-input";
import type { TrapSpan } from "@/lib/traps/types";

import type { CompiledVisaPattern, CompiledVisaRules } from "./rules";
import type { VisaEvidence, VisaKind, VisaResult } from "./types";

export interface DetectVisaOptions {
  /** Cut every line, not only those with a prefilter match (tests: the result must be the same). */
  unfiltered?: boolean;
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
  /** A heading block says no (rule 6): the result cannot be offered. */
  doubt: boolean;
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
    if (!usable(pattern) || (pattern.listItem && !segment.listItem)) continue;
    // most patterns miss: `search` says so without building the match iterator
    if (segment.text.search(pattern.re) === -1) continue;
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
    if (segment.text.search(re) === -1) continue;
    for (const match of segment.text.matchAll(re)) {
      if (match[0].length === 0) continue;
      if (keep({ start: segment.start + match.index, end: segment.start + match.index + match[0].length })) return true;
    }
  }
  return false;
}

const wordsOf = (text: string): string[] => Array.from(text.matchAll(WORD), (m) => m[0]);

/** The text after a hit up to the end of its clause: the first `clause_breaks` match. */
function clauseAfter(text: string, breaks: readonly RegExp[]): string {
  let end = text.length;
  for (const re of breaks) {
    const at = text.search(re);
    if (at !== -1 && at < end) end = at;
  }
  return text.slice(0, end);
}

const hasCue = (text: string, rules: CompiledVisaRules): boolean => wordsOf(text).some((word) => rules.negationCues.some((cue) => cue.test(word)));

/** The heading of the segment's list has a negation cue ("What we can't offer:", "Was wir leider nicht bieten können:"). */
function underNegatedHeading(segment: TextSegment, rules: CompiledVisaRules, description: string): boolean {
  return segment.listHeading !== undefined && hasCue(description.slice(segment.listHeading.start, segment.listHeading.end), rules);
}

/**
 * A heading read with its next line, the heading about visas (a prefilter word, else a mention term) and the next line with a
 * negation cue: "Visa sponsorship" / "We can't help with this.". Returns where the heading's topic is, for the quote.
 */
function refusingHeading(segment: TextSegment, rules: CompiledVisaRules, description: string): Hit | null {
  if (segment.headingEnd === undefined || !hasCue(description.slice(segment.headingEnd, segment.end), rules)) return null;
  const heading = description.slice(segment.start, segment.headingEnd);
  const topics = rules.prefilter === null ? rules.mentionTerms.map((pattern) => pattern.re) : [rules.prefilter];
  return topics.some((re) => matches(re, heading)) ? { start: segment.start, end: segment.headingEnd } : null;
}

/**
 * A negation cue inside the hit, among the words before it, among the words after it in its clause (all in its segment), or in
 * the heading of its list (`headingSaysNo`).
 */
function negated(segment: TextSegment, hit: Hit, rules: CompiledVisaRules, headingSaysNo: boolean): boolean {
  const cues = rules.negationCues;
  if (cues.length === 0) return false;
  if (headingSaysNo) return true;
  const from = hit.start - segment.start;
  const to = hit.end - segment.start;
  const before = rules.negationWordsBefore === 0 ? [] : wordsOf(segment.text.slice(0, from)).slice(-rules.negationWordsBefore);
  const inside = wordsOf(segment.text.slice(from, to));
  const after = rules.negationWordsAfter === 0 ? [] : wordsOf(clauseAfter(segment.text.slice(to), rules.clauseBreaks)).slice(0, rules.negationWordsAfter);
  return [...before, ...inside, ...after].some((word) => cues.some((cue) => cue.test(word)));
}

function judgeSegment(segment: TextSegment, rules: CompiledVisaRules, usable: (p: CompiledVisaPattern) => boolean, keep: (hit: Hit) => boolean, description: string): Verdict | null {
  const block = refusingHeading(segment, rules, description);
  const headingBlock = block !== null && keep(block) ? block : null;
  // most segments that pass the prefilter match no phrase at all: one search says so
  if (headingBlock === null && rules.anyPhrase !== null && segment.text.search(rules.anyPhrase) === -1) return null;
  const offered = hitsOf(rules.offered, segment, usable, keep);
  const refused = hitsOf(rules.noSponsorship, segment, usable, keep).map((hit) => ({ hit, kind: "no_sponsorship" as const }));
  const required = hitsOf(rules.permitRequired, segment, usable, keep);
  const phrases = offered.length + refused.length + required.length > 0;
  const term = phrases ? undefined : hitsOf(rules.mentionTerms, segment, usable, keep)[0];
  // nothing to judge (most segments that only passed the prefilter): the exclusions need not run
  if (!phrases && term === undefined && headingBlock === null) return null;
  if (rules.excludeContext.some((re) => matches(re, segment.text))) return null;
  const verdict = judgeHits(segment, rules, keep, { offered, refused, required, term }, underNegatedHeading(segment, rules, description));
  if (headingBlock === null) return verdict;
  // rule 6: the heading block says no; a refusal stays one, anything else is unclear and doubts the result
  if (verdict?.status === "not_offered") return verdict;
  return { status: "unclear", kind: null, segment, hit: verdict?.hit ?? headingBlock, doubt: true };
}

interface SegmentHits {
  offered: Hit[];
  refused: Array<{ hit: Hit; kind: "no_sponsorship" }>;
  required: Hit[];
  term: Hit | undefined;
}

function judgeHits(segment: TextSegment, rules: CompiledVisaRules, keep: (hit: Hit) => boolean, hits: SegmentHits, headingSaysNo: boolean): Verdict | null {
  const { offered, refused, required, term } = hits;
  const alternative = required.length > 0 && rules.permitAlternatives.some((re) => matches(re, segment.text));
  // a list under a negated heading doubts the result like a refusing heading block (rule 6)
  const doubt = headingSaysNo && offered.length > 0;

  const clearOffers = offered.filter((hit) => !negated(segment, hit, rules, headingSaysNo));
  const unclear: Hit[] = offered.filter((hit) => !clearOffers.includes(hit));
  const refusals: Array<{ hit: Hit; kind: Exclude<VisaKind, null> }> = [...refused];
  if (alternative) unclear.push(...required);
  else refusals.push(...required.map((hit) => ({ hit, kind: "permit_required" as const })));
  refusals.sort((a, b) => a.hit.start - b.hit.start);
  unclear.sort((a, b) => a.start - b.start);

  const first = refusals[0];
  const firstOffer = clearOffers[0];
  if (firstOffer && first) return { status: "unclear", kind: null, segment, hit: firstOffer.start <= first.hit.start ? firstOffer : first.hit, doubt };
  if (first) return { status: "not_offered", kind: first.kind, segment, hit: first.hit, doubt };
  const firstUnclear = unclear[0];
  if (firstOffer && firstUnclear) return { status: "unclear", kind: null, segment, hit: firstOffer.start <= firstUnclear.start ? firstOffer : firstUnclear, doubt };
  if (firstOffer) return { status: "offered", kind: null, segment, hit: firstOffer, doubt };
  if (firstUnclear) return { status: "unclear", kind: null, segment, hit: firstUnclear, doubt };

  if (term && anyHit(rules.mentionContext, segment, keep)) return { status: "unclear", kind: null, segment, hit: term, doubt };
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

/** The global copy of each prefilter, for `matchAll` (which copies it again, so it keeps no state). */
const scanners = new WeakMap<RegExp, RegExp>();

/** Where the prefilter matches in the text, in one pass (non-overlapping, in text order). */
function prefilterRanges(description: string, prefilter: RegExp): Hit[] {
  let scanner = scanners.get(prefilter);
  if (scanner === undefined) {
    scanner = new RegExp(prefilter.source, "giu");
    scanners.set(prefilter, scanner);
  }
  return Array.from(description.matchAll(scanner), (m) => ({ start: m.index, end: m.index + Math.max(m[0].length, 1) }));
}

/**
 * Whether a range overlaps one of `ranges`, for ranges asked in text order (one pointer, no copies). A prefilter match the scan
 * skipped lies inside a match it found, so a line with any prefilter word overlaps a found one.
 */
function overlapsAny(ranges: readonly Hit[]): (start: number, end: number) => boolean {
  let at = 0;
  return (start, end) => {
    while (at < ranges.length && (ranges[at] as Hit).end <= start) at += 1;
    const next = ranges[at];
    return next !== undefined && next.start < end;
  };
}

export function detectVisa(description: string | null, rules: CompiledVisaRules, options: DetectVisaOptions = {}): VisaResult {
  if (description === null || description.trim() === "") return notMentioned();
  const prefilter = rules.prefilter;
  const focus = prefilter === null ? null : prefilterRanges(description, prefilter);
  if (focus !== null && focus.length === 0) return notMentioned();
  const name = options.companyNameNorm ?? "";
  const companyIsVisa = name !== "" && rules.excludeCompanies.some((re) => matches(re, name));
  const usable = (pattern: CompiledVisaPattern): boolean => !companyIsVisa || pattern.combo;
  const spans = options.trapSpans ?? [];
  const keep = (hit: Hit): boolean => spans.length === 0 || !overlapsTrap(hit.start, hit.end - hit.start, spans);

  const verdicts: Verdict[] = [];
  const keepLine = focus === null || options.unfiltered === true ? undefined : overlapsAny(focus);
  // a segment without a prefilter match is skipped too (segments come in text order, like the lines)
  const keepSegment = focus === null ? null : overlapsAny(focus);
  for (const segment of segmentText(description, { abbreviations: rules.abbreviations, headingMaxChars: rules.headingMaxChars, keep: keepLine })) {
    if (keepSegment !== null && !keepSegment(segment.start, segment.end)) continue;
    const verdict = judgeSegment(segment, rules, usable, keep, description);
    if (verdict) verdicts.push(verdict);
  }
  if (verdicts.length === 0) return notMentioned();

  const offered = verdicts.some((v) => v.status === "offered");
  const refused = verdicts.some((v) => v.status === "not_offered");
  const doubted = verdicts.some((v) => v.doubt);
  const status = offered && refused ? "unclear" : refused ? "not_offered" : offered && !doubted ? "offered" : "unclear";
  return { status, evidence: pickEvidence(verdicts, rules.maxQuotes, rules, description) };
}
