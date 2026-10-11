/**
 * The five signals of the ghost job check, each a pure function of the stored inputs (no AI, no network). Thresholds and points
 * come from pipeline.yaml `job_checks.ghost`, words from the market packs' `ghost` section (C8).
 */
import { segmentText, type TextSegment } from "@/lib/job-checks/segment";
import { clipQuote } from "@/lib/signals/quote";

import type { CompiledGhostPattern, CompiledGhostRules } from "./rules";
import type { GhostInput, GhostPosting, GhostReasonOf, RepostEvent } from "./types";

const DAY_MS = 86_400_000;
const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const daysBetween = (from: Date, to: Date): number => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
const wordsOf = (text: string): string[] => Array.from(text.matchAll(WORD), (m) => m[0]);

/** The number of words of a text (letters and digits, "don't" as one). */
export function countWords(text: string | null): number {
  return text === null ? 0 : (text.match(WORD)?.length ?? 0);
}

// ---------------------------------------------------------------- long_open

export interface LongOpenOutcome {
  reason: GhostReasonOf<"long_open"> | null;
  /** When the points would next change; null = never (no higher tier, or the cap is reached). */
  recheckAt: Date | null;
}

/**
 * Open for long: only for active jobs. With a trusted posted date the days count from it; otherwise from the first time the job was
 * seen, and then at most `first_seen_max_points`.
 */
export function longOpen(input: Pick<GhostInput, "status" | "firstSeenAt" | "trustedPostedAt">, rules: CompiledGhostRules, now: Date): LongOpenOutcome {
  const settings = rules.settings.long_open;
  if (!settings.enabled || input.status !== "active") return { reason: null, recheckAt: null };
  const trusted = input.trustedPostedAt;
  const since = trusted?.at ?? input.firstSeenAt;
  const cap = trusted ? Number.POSITIVE_INFINITY : settings.first_seen_max_points;
  const days = daysBetween(since, now);
  const pointsAt = (d: number): number => Math.min(cap, settings.tiers.reduce((best, tier) => (d >= tier.days ? Math.max(best, tier.points) : best), 0));
  const points = pointsAt(days);
  const next = settings.tiers.find((tier) => tier.days > days && pointsAt(tier.days) > points);
  const recheckAt = next ? new Date(since.getTime() + next.days * DAY_MS) : null;
  if (points <= 0) return { reason: null, recheckAt };
  return {
    reason: { code: "long_open", points, days, since: isoDay(since), from: trusted ? "posted" : "first_seen", channelId: trusted?.channelId ?? null },
    recheckAt,
  };
}

// ---------------------------------------------------------------- repost_label

/** The first source label that a `repost_label_patterns` entry matches ("Reposted 2 weeks ago"). */
export function repostLabel(postings: readonly GhostPosting[], rules: CompiledGhostRules): GhostReasonOf<"repost_label"> | null {
  const settings = rules.settings.repost_label;
  if (!settings.enabled || settings.points <= 0) return null;
  for (const posting of postings) {
    const label = posting.repostLabel?.trim();
    if (!label) continue;
    if (rules.repostLabels.some((pattern) => label.search(pattern.re) !== -1)) {
      return { code: "repost_label", points: settings.points, channelId: posting.channelId, label: label.slice(0, 120) };
    }
  }
  return null;
}

// ---------------------------------------------------------------- reposted

const placeKey = (label: string | null): string => (label ?? "").normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();

/**
 * Relisted under a new id: postings of one channel that keeps its ids stable, at the same place (or both without one), whose first
 * sightings are at least `min_gap_days` apart. Never across channels (one id space per channel), never for channels without stable
 * ids. The channel with the most relistings is reported (its first ten events).
 */
export function reposted(postings: readonly GhostPosting[], rules: CompiledGhostRules): GhostReasonOf<"reposted"> | null {
  const settings = rules.settings.reposted;
  if (!settings.enabled || settings.points <= 0) return null;
  const groups = new Map<string, GhostPosting[]>();
  for (const posting of postings) {
    if (!posting.stableIds) continue;
    const key = `${posting.channelId}\u0000${placeKey(posting.locationLabel)}`;
    const group = groups.get(key) ?? [];
    group.push(posting);
    groups.set(key, group);
  }
  const byChannel = new Map<string, RepostEvent[]>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.externalId.localeCompare(b.externalId));
    for (let i = 1; i < sorted.length; i += 1) {
      const older = sorted[i - 1] as GhostPosting;
      const newer = sorted[i] as GhostPosting;
      if (older.externalId === newer.externalId) continue;
      const gapDays = daysBetween(older.firstSeenAt, newer.firstSeenAt);
      if (gapDays < settings.min_gap_days) continue;
      const events = byChannel.get(newer.channelId) ?? [];
      events.push({ oldId: older.externalId.slice(0, 300), newId: newer.externalId.slice(0, 300), oldSeen: isoDay(older.firstSeenAt), newSeen: isoDay(newer.firstSeenAt), gapDays });
      byChannel.set(newer.channelId, events);
    }
  }
  let best: [string, RepostEvent[]] | null = null;
  for (const entry of [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (best === null || entry[1].length > best[1].length) best = entry;
  }
  if (best === null) return null;
  const events = [...best[1]].sort((a, b) => a.newSeen.localeCompare(b.newSeen) || a.newId.localeCompare(b.newId)).slice(0, 10);
  return { code: "reposted", points: settings.points, channelId: best[0], events };
}

// ---------------------------------------------------------------- headings (duties section)

const LIST_OR_HEADING_MARKER = /^(?:[-*•–·]\s+|\d{1,3}[.)]\s+|#{1,6}\s+)/u;
const EMPHASIS = /[*_]+/gu;
const END_PUNCTUATION = /[.!?;,)\]"'“”»]$/u;

/** A heading's text as the responsibility patterns see it: no markers, no emphasis, no final colon, single spaces. */
function headingText(raw: string): string {
  return raw.replace(EMPHASIS, "").replace(/:\s*$/u, "").replace(/\s+/gu, " ").trim();
}

/** The heading-shaped pieces of a line: the whole line when it is short and looks like a heading, and a short "Label:" prefix. */
function headingsOfLine(line: string, maxChars: number): string[] {
  const trimmed = line.trim();
  if (trimmed === "") return [];
  const markdown = /^#{1,6}\s+/u.test(trimmed);
  const content = trimmed.replace(LIST_OR_HEADING_MARKER, "").trim();
  const out: string[] = [];
  const plain = content.replace(EMPHASIS, "").trim();
  if (plain.length > 0 && plain.length <= maxChars && (markdown || plain.endsWith(":") || !END_PUNCTUATION.test(plain))) out.push(headingText(content));
  const colon = content.indexOf(":");
  if (colon > 0 && colon <= maxChars && colon < content.length - 1) out.push(headingText(content.slice(0, colon)));
  return out.filter((text) => text.length > 0);
}

/** Whether the text has a heading that opens the duties of the role ("Responsibilities", "Deine Aufgaben:"). */
export function hasResponsibilityHeading(description: string | null, rules: CompiledGhostRules): boolean {
  if (description === null || rules.responsibilities.length === 0) return false;
  const max = rules.settings.heading_max_chars;
  for (const line of description.split("\n")) {
    for (const heading of headingsOfLine(line, max)) {
      if (rules.responsibilities.some((pattern) => pattern.re.test(heading))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- thin_description

/**
 * A short JD, or one without a duties section, judged only when the description comes from a source that keeps the full text. A
 * current AI breakdown decides whether there are duties (its count of responsibilities) instead of the headings.
 */
export function thinDescription(input: Pick<GhostInput, "description" | "descriptionSource" | "breakdownResponsibilities">, rules: CompiledGhostRules): GhostReasonOf<"thin_description"> | null {
  const settings = rules.settings.thin_description;
  if (!settings.enabled || settings.points <= 0 || input.descriptionSource === null) return null;
  const words = countWords(input.description);
  const fromBreakdown = input.breakdownResponsibilities !== null;
  const hasResponsibilities = fromBreakdown ? (input.breakdownResponsibilities as number) > 0 : hasResponsibilityHeading(input.description, rules);
  if (words >= settings.min_words && hasResponsibilities) return null;
  return {
    code: "thin_description",
    points: settings.points,
    words,
    minWords: settings.min_words,
    hasResponsibilities,
    responsibilitiesFrom: fromBreakdown ? "breakdown" : "headings",
    channelId: input.descriptionSource.channelId,
  };
}

// ---------------------------------------------------------------- evergreen_wording

interface Hit {
  start: number;
  end: number;
}

const hasCue = (text: string, rules: CompiledGhostRules): boolean => wordsOf(text).some((word) => rules.negationCues.some((cue) => cue.test(word)));

/** The end of the first clause break in `text` (or its length). */
function firstBreak(text: string, breaks: readonly RegExp[]): number {
  let end = text.length;
  for (const re of breaks) {
    const at = text.search(re);
    if (at !== -1 && at < end) end = at;
  }
  return end;
}

/** Where the clause that ends at the end of `text` starts: right after the last clause break in it (0 when none). */
function lastBreakEnd(text: string, breaks: readonly RegExp[]): number {
  let from = 0;
  for (const re of breaks) {
    for (const match of text.matchAll(re)) {
      const end = match.index + match[0].length;
      if (end > from) from = end;
    }
  }
  return from;
}

/**
 * A negation cue inside the hit, among the `negation_words_before` words before it or the `negation_words_after` words after it
 * (both within its clause), in the heading of its list, or, for a heading read with its next line, in that next line.
 */
function negated(segment: TextSegment, hit: Hit, rules: CompiledGhostRules, description: string): boolean {
  if (rules.negationCues.length === 0) return false;
  if (segment.listHeading !== undefined && hasCue(description.slice(segment.listHeading.start, segment.listHeading.end), rules)) return true;
  if (segment.headingEnd !== undefined && hit.end <= segment.headingEnd && hasCue(description.slice(segment.headingEnd, segment.end), rules)) return true;
  const settings = rules.settings;
  const from = hit.start - segment.start;
  const to = hit.end - segment.start;
  const head = segment.text.slice(0, from);
  const before = settings.negation_words_before === 0 ? [] : wordsOf(head.slice(lastBreakEnd(head, rules.clauseBreaks))).slice(-settings.negation_words_before);
  const inside = wordsOf(segment.text.slice(from, to));
  const tail = segment.text.slice(to);
  const after = settings.negation_words_after === 0 ? [] : wordsOf(tail.slice(0, firstBreak(tail, rules.clauseBreaks))).slice(0, settings.negation_words_after);
  return [...before, ...inside, ...after].some((word) => rules.negationCues.some((cue) => cue.test(word)));
}

/** A list item under a duties heading: the role's work ("Your tasks:" / "- Build our talent pool"), not what the posting is. */
function underDutiesHeading(segment: TextSegment, rules: CompiledGhostRules, description: string): boolean {
  if (segment.listHeading === undefined) return false;
  const heading = headingText(description.slice(segment.listHeading.start, segment.listHeading.end).replace(LIST_OR_HEADING_MARKER, ""));
  return rules.responsibilities.some((pattern) => pattern.re.test(heading));
}

/**
 * The question right before a piece (same line or the line above), when the text before it ends in "?": "Don't see a role that
 * fits? Join our talent community" is one thought cut in two, so the question is read as the piece's context. Empty when none.
 */
function leadInQuestion(description: string, start: number): string {
  const before = description.slice(0, start).trimEnd();
  if (!before.endsWith("?")) return "";
  const head = before.slice(0, -1);
  const from = Math.max(head.lastIndexOf("\n"), head.lastIndexOf("."), head.lastIndexOf("!"), head.lastIndexOf("?")) + 1;
  return before.slice(from);
}

function hitsOf(pattern: CompiledGhostPattern, segment: TextSegment): Hit[] {
  if (segment.text.search(pattern.re) === -1) return [];
  const hits: Hit[] = [];
  for (const match of segment.text.matchAll(pattern.re)) {
    if (match[0].length === 0) continue;
    hits.push({ start: segment.start + match.index, end: segment.start + match.index + match[0].length });
  }
  return hits;
}

export interface EvergreenOptions {
  /** Hits inside these ranges do not count (pieces of the JD hidden from readers: the AI trap findings). */
  skip?: (start: number, end: number) => boolean;
}

/**
 * The first sentence (in text order) that says the posting is a talent pool or always open. A sentence matching `exclude_context`
 * (itself or the question right before it), a negated hit and a list item under a duties heading do not count. The quote is verified against the description (C7).
 */
export function evergreenWording(description: string | null, rules: CompiledGhostRules, options: EvergreenOptions = {}): GhostReasonOf<"evergreen_wording"> | null {
  const settings = rules.settings.evergreen_wording;
  if (!settings.enabled || settings.points <= 0 || description === null || description.trim() === "" || rules.evergreen.length === 0) return null;
  const prefilter = rules.prefilter;
  if (prefilter !== null && description.search(prefilter) === -1) return null;
  const keep = prefilter === null ? undefined : (start: number, end: number): boolean => description.slice(start, end).search(prefilter) !== -1;
  const segments = segmentText(description, { abbreviations: rules.abbreviations, headingMaxChars: rules.settings.heading_max_chars, ...(keep ? { keep } : {}) });
  for (const segment of segments) {
    if (prefilter !== null && segment.text.search(prefilter) === -1) continue;
    const candidates: Array<{ hit: Hit; pattern: CompiledGhostPattern }> = [];
    for (const pattern of rules.evergreen) for (const hit of hitsOf(pattern, segment)) candidates.push({ hit, pattern });
    if (candidates.length === 0) continue;
    const question = leadInQuestion(description, segment.start);
    if (rules.excludeContext.some((re) => segment.text.search(re) !== -1 || (question !== "" && question.search(re) !== -1))) continue;
    if (underDutiesHeading(segment, rules, description)) continue;
    candidates.sort((a, b) => a.hit.start - b.hit.start || b.hit.end - a.hit.end);
    for (const { hit, pattern } of candidates) {
      if (options.skip?.(hit.start, hit.end)) continue;
      if (pattern.checkNegation && negated(segment, hit, rules, description)) continue;
      const { quote, offset } = clipQuote(description, segment.start, segment.end, hit, rules.settings.quote_max_chars);
      // C7: the quote must be the description at its offset; a quote that is not is never stored
      if (quote === "" || description.slice(offset, offset + quote.length) !== quote) continue;
      return { code: "evergreen_wording", points: settings.points, patternId: pattern.id, quote, offset };
    }
  }
  return null;
}
