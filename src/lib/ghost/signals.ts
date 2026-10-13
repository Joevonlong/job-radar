/**
 * The five signals of the ghost job check, each a pure function of the stored inputs (no AI, no network). Thresholds and points
 * come from pipeline.yaml `job_checks.ghost`, words from the market packs' `ghost` section (C8).
 */
import { segmentText, type TextSegment } from "@/lib/job-checks/segment";
import { clipQuote } from "@/lib/signals/quote";

import { endsInQuestion, questionEndAsColon, stripTrailingDecoration, trailingDotsAsColon, trailingPauseAsColon } from "./heading-ends";
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
/** A list item's line, as the segmenter reads it (a "#" heading is not one). */
const LIST_LINE = /^\s*(?:[-*•–·]\s+|\d{1,3}[.)]\s+)/u;
const EMPHASIS = /[*_]+/gu;
const END_PUNCTUATION = /[.!?;,)\]"'“”»]$/u;
/** Emoji, arrows and other symbols before a heading ("🚀 Your tasks", "→ Your tasks", "» Deine Aufgaben"), with the joiners and selectors of emoji. */
const DECORATION = /^[\p{Extended_Pictographic}\p{So}\p{Sk}\u{2190}-\u{21FF}\u{00BB}\u{203A}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\s]+/u;
const APOSTROPHES = /[‘’ʼ]/gu;
const AMPERSAND_ENTITY = /&amp;/giu;

/**
 * A line as the ghost check reads it when it looks for a heading: "&amp;" as "&", curly apostrophes as straight ones, without
 * emoji or arrows before it and emoji after it, without list or "#" marker and emphasis, and a final "…", " -" or "—" as ":".
 * Right above a list (`listFollows`) a final "..." is ":" too, and so is a final "?" when the line opens with one of the packs'
 * `question_words` ("What will I be doing?" / "- …"): "Ready to take on new responsibilities?" and a question or "..." in the
 * company text ("Which tasks can our AI automate?" and prose after it) stay sentences. Only for telling headings: quotes and
 * offsets always come from the description itself.
 */
function normalizeHeadingLine(raw: string, rules: CompiledGhostRules, listFollows: boolean): string {
  let text = raw.replace(AMPERSAND_ENTITY, "&").replace(APOSTROPHES, "'").trim().replace(DECORATION, "");
  text = stripTrailingDecoration(text.replace(LIST_OR_HEADING_MARKER, "").replace(DECORATION, "").replace(EMPHASIS, "")).trim();
  text = trailingPauseAsColon(text);
  if (!listFollows) return text;
  text = trailingDotsAsColon(text);
  if (endsInQuestion(text)) {
    const first = (wordsOf(text)[0] ?? "").split("'")[0] ?? "";
    if (rules.questionWords.some((word) => word.test(first))) text = questionEndAsColon(text);
  }
  return text;
}

/** A heading's text as the responsibility patterns see it: normalized (`normalizeHeadingLine`), no final colon, single spaces. */
function headingText(raw: string, rules: CompiledGhostRules, listFollows: boolean): string {
  return normalizeHeadingLine(raw, rules, listFollows).replace(/:\s*$/u, "").replace(/\s+/gu, " ").trim();
}

/** The whole line as a heading (short, and a "#" heading, ending in ":" or without end punctuation), or null. */
function wholeLineHeading(line: string, rules: CompiledGhostRules, listFollows: boolean): string | null {
  const trimmed = line.trim();
  const content = normalizeHeadingLine(trimmed, rules, listFollows);
  if (content.length === 0 || content.length > rules.settings.heading_max_chars) return null;
  if (!/^#{1,6}\s+/u.test(trimmed) && !content.endsWith(":") && END_PUNCTUATION.test(content)) return null;
  const text = headingText(content, rules, listFollows);
  return text.length > 0 ? text : null;
}

/**
 * The heading-shaped pieces of a line: the whole line when it is short and looks like a heading, and a short "Label:" prefix.
 * `listFollows`: a list starts at the next line that is not blank, or after one line of lead-in (see `hasResponsibilityHeading`).
 */
function headingsOfLine(line: string, rules: CompiledGhostRules, listFollows: boolean, wholeLine = true): string[] {
  if (line.trim() === "") return [];
  const out: string[] = [];
  const whole = wholeLine ? wholeLineHeading(line, rules, listFollows) : null;
  if (whole !== null) out.push(whole);
  const content = normalizeHeadingLine(line, rules, listFollows);
  const colon = content.indexOf(":");
  if (colon > 0 && colon <= rules.settings.heading_max_chars && colon < content.length - 1) out.push(headingText(content.slice(0, colon), rules, listFollows));
  return out.filter((text) => text.length > 0);
}

const isDutiesHeading = (heading: string, rules: CompiledGhostRules): boolean => rules.responsibilities.some((pattern) => pattern.re.test(heading));

/** Whether the text has a heading that opens the duties of the role ("Responsibilities", "Deine Aufgaben:"). */
export function hasResponsibilityHeading(description: string | null, rules: CompiledGhostRules): boolean {
  return firstDutiesHeading(description, rules) !== null;
}

/**
 * Where the line of the text's first duties heading starts (as `hasResponsibilityHeading` reads them), or null. With `cap`, a
 * longer line is read only up to `cap` characters and only for a "Label:" prefix (it is no heading as a whole): the time stays
 * linear in the length of a line.
 */
function firstDutiesHeading(description: string | null, rules: CompiledGhostRules, cap?: number): number | null {
  if (description === null || rules.responsibilities.length === 0) return null;
  const lines = description.split("\n");
  // whether a list starts at the next line that is not blank, or after one line of lead-in that ends in ":" or is itself
  // heading-shaped ("What will I be doing?" / "As a senior engineer, you will:" / "- …"; not "Which tasks can our AI automate?" /
  // "Almost all of them." / "- …"), from the end
  const fits = (line: string): boolean => cap === undefined || line.length <= cap;
  const isList = (at: number): boolean => at !== -1 && LIST_LINE.test(lines[at] as string);
  const isLeadIn = (at: number): boolean => {
    const line = (lines[at] as string).trim();
    return line.endsWith(":") || line.endsWith("：") || (fits(line) && wholeLineHeading(line, rules, false) !== null);
  };
  const listFollows = new Array<boolean>(lines.length).fill(false);
  let next = -1;
  let afterNext = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    listFollows[i] = isList(next) || (next !== -1 && isList(afterNext) && isLeadIn(next));
    if ((lines[i] as string).trim() !== "") [next, afterNext] = [i, next];
  }
  let offset = 0;
  for (const [i, line] of lines.entries()) {
    const whole = fits(line);
    for (const heading of headingsOfLine(whole ? line : line.slice(0, cap), rules, listFollows[i] === true, whole)) {
      if (isDutiesHeading(heading, rules)) return offset;
    }
    offset += line.length + 1;
  }
  return null;
}

// ---------------------------------------------------------------- thin_description

/**
 * A short JD, or one without a duties section, judged only when the description comes from a source that keeps the full text. A
 * current AI breakdown decides whether there are duties (its count of responsibilities, an empty list included); without one the
 * duties headings do, unless `infer_from_headings` is off: then only a short JD counts (`responsibilitiesFrom: "none"`).
 */
export function thinDescription(input: Pick<GhostInput, "description" | "descriptionSource" | "breakdownResponsibilities">, rules: CompiledGhostRules): GhostReasonOf<"thin_description"> | null {
  const settings = rules.settings.thin_description;
  if (!settings.enabled || settings.points <= 0 || input.descriptionSource === null) return null;
  const words = countWords(input.description);
  const from: GhostReasonOf<"thin_description">["responsibilitiesFrom"] = input.breakdownResponsibilities !== null ? "breakdown" : settings.infer_from_headings ? "headings" : "none";
  const hasResponsibilities = from === "breakdown" ? (input.breakdownResponsibilities as number) > 0 : from === "headings" && hasResponsibilityHeading(input.description, rules);
  if (words >= settings.min_words && (hasResponsibilities || from === "none")) return null;
  return {
    code: "thin_description",
    points: settings.points,
    words,
    minWords: settings.min_words,
    hasResponsibilities,
    responsibilitiesFrom: from,
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

/** The first index in the ascending `values` whose value is at least `value` (`values.length` when none). */
function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((values[mid] as number) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The matches of `res` in a piece, read once so that each hit finds its clause in log time (re-reading the text before every hit
 * takes the square of the hit count). `ends` ascending, `starts[i]` the last start among the matches up to `ends[i]`.
 */
interface ClauseMarks {
  ends: number[];
  starts: number[];
}

function clauseMarks(text: string, res: readonly RegExp[]): ClauseMarks {
  const found: Array<[number, number]> = [];
  for (const re of res) for (const match of text.matchAll(re)) found.push([match.index + match[0].length, match.index]);
  found.sort((a, b) => a[0] - b[0]);
  const marks: ClauseMarks = { ends: [], starts: [] };
  let last = 0;
  for (const [end, start] of found) {
    last = Math.max(last, start);
    marks.ends.push(end);
    marks.starts.push(last);
  }
  return marks;
}

/** Where the last mark that ends at or before `from` starts (0 when none). */
function lastMarkStart(marks: ClauseMarks, from: number): number {
  const count = lowerBound(marks.ends, from + 1);
  return count === 0 ? 0 : (marks.starts[count - 1] as number);
}

/**
 * A negation cue inside the hit, among the `negation_words_before` words before it or the `negation_words_after` words after it
 * (both within its clause; after it to the end of the clause for a pattern with `negationAfter: "clause"`), in the heading of its
 * list, or, for a heading read with its next line, in that next line.
 */
function negated(segment: TextSegment, hit: Hit, pattern: CompiledGhostPattern, rules: CompiledGhostRules, description: string): boolean {
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
  const clauseAfter = wordsOf(tail.slice(0, firstBreak(tail, rules.clauseBreaks)));
  const after = pattern.negationAfter === "clause" ? clauseAfter : clauseAfter.slice(0, settings.negation_words_after);
  return [...before, ...inside, ...after].some((word) => rules.negationCues.some((cue) => cue.test(word)));
}

/**
 * The heading of a list item's list: the segmenter's, else (ghost-local) the first line above the list when the ghost check reads it
 * as a heading. The segmenter does not take a line ending in "?" or "..." as a list's heading ("What will I be doing?" / "- …").
 */
function listHeadingOf(segment: TextSegment, rules: CompiledGhostRules, description: string): string | null {
  if (segment.listHeading !== undefined) return headingText(description.slice(segment.listHeading.start, segment.listHeading.end), rules, true);
  if (!segment.listItem) return null;
  let lineStart = description.lastIndexOf("\n", segment.start - 1) + 1;
  while (lineStart > 0) {
    const lineEnd = lineStart - 1;
    lineStart = description.lastIndexOf("\n", lineEnd - 1) + 1;
    const line = description.slice(lineStart, lineEnd);
    // blank lines and the items above it in the same list
    if (line.trim() === "" || LIST_LINE.test(line)) continue;
    return wholeLineHeading(line, rules, true);
  }
  return null;
}

/** A list item under a duties heading: the role's work ("Your tasks:" / "- Build our talent pool"), not what the posting is. */
function underDutiesHeading(segment: TextSegment, rules: CompiledGhostRules, description: string): boolean {
  const heading = listHeadingOf(segment, rules, description);
  return heading !== null && isDutiesHeading(heading, rules);
}

/**
 * The question right before a piece, when the text before it ends in one of the packs' `lead_in_question.ends` ("?"): "Don't see a
 * role that fits? Join our talent community" is one thought cut in two, so the question is read as the piece's context. It starts
 * after the last `starts` mark or line break before it; with `line_above` false it must end on the piece's own line. Empty when none.
 */
function leadInQuestion(description: string, start: number, lead: CompiledGhostRules["leadInQuestion"]): string {
  if (lead.ends.length === 0) return "";
  const raw = description.slice(0, start);
  const before = raw.trimEnd();
  if (!lead.line_above && raw.slice(before.length).includes("\n")) return "";
  const end = lead.ends.find((mark) => before.endsWith(mark));
  if (end === undefined) return "";
  const head = before.slice(0, -end.length);
  const from = Math.max(head.lastIndexOf("\n"), ...lead.starts.map((mark) => {
    const at = head.lastIndexOf(mark);
    return at === -1 ? -1 : at + mark.length - 1;
  })) + 1;
  return before.slice(from);
}

/** The piece itself ends in one of the packs' `lead_in_question.ends` marks. */
function isQuestion(text: string, lead: CompiledGhostRules["leadInQuestion"]): boolean {
  const trimmed = text.trimEnd();
  return lead.ends.some((mark) => trimmed.endsWith(mark));
}

/** A comma or colon also starts a clause for the question test ("Recruiters, are you always hiring – interested?"). */
const CLAUSE_PUNCTUATION = /[,:，：]/gu;
const LEADING_NON_WORD = /^[^\p{L}\p{N}]*/u;

/**
 * What a piece's tagged clauses are read with: its clause starts and the starts of its `question_tag.subjects`, read once, and per
 * clause start where its first word after any `question_tag.markers` starts (read on the first hit in the clause).
 */
interface TaggedPiece {
  text: string;
  clauses: ClauseMarks;
  subjects: number[];
  afterMarkers: Map<number, number>;
}

function taggedPiece(text: string, rules: CompiledGhostRules): TaggedPiece {
  const subjects: number[] = [];
  for (const re of rules.questionTag.subjects) for (const match of text.matchAll(re)) if (match[0].length > 0) subjects.push(match.index);
  subjects.sort((a, b) => a - b);
  return { text, clauses: clauseMarks(text, [...rules.clauseBreaks, CLAUSE_PUNCTUATION]), subjects, afterMarkers: new Map() };
}

/**
 * Where the clause that starts at `clauseStart` goes on after the signs and `question_tag.markers` it opens with. Read to the end
 * of the piece rather than to a hit, so that it is the same for every hit in the clause: a hit at or before it opens its clause.
 */
function afterMarkers(piece: TaggedPiece, clauseStart: number, rules: CompiledGhostRules): number {
  const cached = piece.afterMarkers.get(clauseStart);
  if (cached !== undefined) return cached;
  const text = piece.text;
  let at = clauseStart;
  const skip = (): void => {
    at += LEADING_NON_WORD.exec(text.slice(at))?.[0].length ?? 0;
  };
  skip();
  for (let marked = true; marked && at < text.length; ) {
    marked = false;
    const rest = text.slice(at);
    for (const marker of rules.questionTag.markers) {
      const length = marker.exec(rest)?.[0].length ?? 0;
      if (length === 0) continue;
      at += length;
      skip();
      marked = true;
      break;
    }
  }
  piece.afterMarkers.set(clauseStart, at);
  return at;
}

/**
 * Whether the clause of a hit at `from`…`to` (in a statement with an invitation tagged on) is a question after all. The clause
 * starts at the last `clause_breaks` match, comma or colon before the hit; after any `question_tag.markers` it opens with one of
 * `openers` ("Recruiters, are you always hiring – interested?", "So, is it …", "Liebe Recruiter, stellen Sie laufend ein –
 * neugierig?") or with the hit itself ("Always hiring – interested?": no subject, an advert's question), or, when the packs list
 * `subjects`, none of them starts in the clause before the hit's end ("Tired of always hiring – interested?"; "At Acme we are
 * always hiring – want to join?" and "Bei uns suchen wir laufend …" are statements, and so are "When we grow, we are always hiring
 * – want to join?" and "Have a look: we are always hiring – interested?").
 */
function questionClause(piece: TaggedPiece, from: number, to: number, rules: CompiledGhostRules): boolean {
  const tag = rules.questionTag;
  const text = piece.text;
  const clauseStart = lastMarkStart(piece.clauses, from);
  const at = afterMarkers(piece, clauseStart, rules);
  if (at >= from) return true;
  // the subject first: one look-up per hit, where the openers are many expressions
  if (tag.subjects.length > 0) {
    const subject = piece.subjects[lowerBound(piece.subjects, clauseStart)];
    if (subject === undefined || subject >= to) return true;
  }
  const rest = text.slice(at, from);
  return tag.openers.some((opener) => opener.test(rest));
}

/**
 * A piece that ends in a question mark but is a statement with a short invitation tagged on ("We are always hiring – want to
 * join?", "Wir suchen laufend Verstärkung – bist du dabei?"): the length of the statement before the last `question_tag.breaks`
 * match, or null when the piece is a question. The tag must be one of `invitations` and have at most `question_tag_max_words`
 * words; whether the clause of a hit is a question all the same is `questionClause`'s ("Is your company always hiring – interested?").
 */
function taggedStatement(text: string, rules: CompiledGhostRules): number | null {
  const tag = rules.questionTag;
  if (tag.breaks.length === 0 || tag.invitations.length === 0) return null;
  const trimmed = text.trimEnd();
  const mark = rules.leadInQuestion.ends.find((end) => trimmed.endsWith(end));
  const body = mark === undefined ? trimmed : trimmed.slice(0, -mark.length);
  let headEnd = -1;
  let tagStart = -1;
  for (const re of tag.breaks) {
    for (const match of body.matchAll(re)) {
      if (match[0].length > 0 && match.index > headEnd) [headEnd, tagStart] = [match.index, match.index + match[0].length];
    }
  }
  if (headEnd <= 0) return null;
  const tagText = body.slice(tagStart).trim();
  const words = wordsOf(tagText).length;
  if (words === 0 || words > rules.settings.question_tag_max_words || !tag.invitations.some((re) => re.test(tagText))) return null;
  return headEnd;
}

/**
 * The ranges (offsets in the description) that the packs' `exclude_clause` take out: each match to the end of its clause (the
 * first `clause_breaks` or `exclude_clause_ends` match after it), sorted by start. Each end expression is searched forward from
 * the match ends in order and its last find reused while it lies ahead, so the time stays linear in the number of matches.
 */
function clauseExclusions(segment: TextSegment, rules: CompiledGhostRules): Array<[number, number]> {
  if (rules.excludeClause.length === 0) return [];
  const text = segment.text;
  const starts: Array<[number, number]> = [];
  for (const re of rules.excludeClause) {
    for (const match of text.matchAll(re)) if (match[0].length > 0) starts.push([match.index, match.index + match[0].length]);
  }
  starts.sort((a, b) => a[1] - b[1]);
  const ends = [...rules.clauseBreaks, ...rules.excludeClauseEnds].map((re) => ({ re: new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), from: -1, at: -1 }));
  const out: Array<[number, number]> = [];
  for (const [start, after] of starts) {
    let end = text.length;
    for (const cursor of ends) {
      // the first match at or after `from` is `at` (-1: none); still the first one at or after `after` while `after <= at`
      if (cursor.from === -1 || (cursor.at !== -1 && after > cursor.at)) {
        cursor.re.lastIndex = after;
        cursor.from = after;
        cursor.at = cursor.re.exec(text)?.index ?? -1;
      }
      if (cursor.at !== -1 && cursor.at < end) end = cursor.at;
    }
    out.push([segment.start + start, segment.start + end]);
  }
  return out.sort((a, b) => a[0] - b[0]);
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
 * (itself or the question right before it), a sentence that is itself a question (ends in a `lead_in_question.ends` mark; a
 * statement with a short invitation tagged on is none, `question_tag`), a negated hit, a hit in the reach of an `exclude_clause`
 * match, a hit of a pattern with `requires_context` whose sentence has none of it, a hit of an `only_before_duties` pattern below
 * the first duties heading, and a list item under a duties heading do not count. The quote is verified against the description (C7).
 */
export function evergreenWording(description: string | null, rules: CompiledGhostRules, options: EvergreenOptions = {}): GhostReasonOf<"evergreen_wording"> | null {
  const settings = rules.settings.evergreen_wording;
  if (!settings.enabled || settings.points <= 0 || description === null || description.trim() === "" || rules.evergreen.length === 0) return null;
  const prefilter = rules.prefilter;
  if (prefilter !== null && description.search(prefilter) === -1) return null;
  const keep = prefilter === null ? undefined : (start: number, end: number): boolean => description.slice(start, end).search(prefilter) !== -1;
  const segments = segmentText(description, { abbreviations: rules.abbreviations, headingMaxChars: rules.settings.heading_max_chars, ...(keep ? { keep } : {}) });
  // where the first duties heading starts, read once and only for an `only_before_duties` hit (undefined = not read yet)
  let dutiesAt: number | null | undefined;
  for (const segment of segments) {
    if (prefilter !== null && segment.text.search(prefilter) === -1) continue;
    const candidates: Array<{ hit: Hit; pattern: CompiledGhostPattern }> = [];
    for (const pattern of rules.evergreen) for (const hit of hitsOf(pattern, segment)) candidates.push({ hit, pattern });
    if (candidates.length === 0) continue;
    // a question is not a statement about the posting ("Always hiring? Acme automates your sourcing"), unless it is a statement
    // with an invitation tagged on ("We are always hiring – want to join?"): then only hits before the tag count
    let statementEnd = segment.text.length;
    if (isQuestion(segment.text, rules.leadInQuestion)) {
      const head = taggedStatement(segment.text, rules);
      if (head === null) continue;
      statementEnd = head;
    }
    const question = leadInQuestion(description, segment.start, rules.leadInQuestion);
    if (rules.excludeContext.some((re) => segment.text.search(re) !== -1 || (question !== "" && question.search(re) !== -1))) continue;
    if (underDutiesHeading(segment, rules, description)) continue;
    const excluded = clauseExclusions(segment, rules);
    // the exclusions that start at or before the current hit (hits come in text order) and the furthest end among them
    let excludedSeen = 0;
    let excludedTo = -1;
    const tagged = statementEnd < segment.text.length ? taggedPiece(segment.text, rules) : null;
    candidates.sort((a, b) => a.hit.start - b.hit.start || b.hit.end - a.hit.end);
    for (const { hit, pattern } of candidates) {
      if (options.skip?.(hit.start, hit.end)) continue;
      if (tagged !== null) {
        const from = hit.start - segment.start;
        // in the tag, or in a clause that is itself a question ("We grow fast, but are you always hiring – interested?") or has
        // no subject ("Always hiring – interested?", "Tired of always hiring – interested?")
        if (from >= statementEnd) continue;
        if (questionClause(tagged, from, hit.end - segment.start, rules)) continue;
      }
      // a qualification of the candidate, to the end of its clause ("Experience building a talent pipeline for future roles")
      for (; excludedSeen < excluded.length && (excluded[excludedSeen] as [number, number])[0] <= hit.start; excludedSeen++) {
        excludedTo = Math.max(excludedTo, (excluded[excludedSeen] as [number, number])[1]);
      }
      if (hit.start < excludedTo) continue;
      if (pattern.onlyBeforeDuties) {
        // a heading line is short: longer lines are read only up to twice heading_max_chars
        if (dutiesAt === undefined) dutiesAt = firstDutiesHeading(description, rules, rules.settings.heading_max_chars * 2);
        if (dutiesAt !== null && hit.start > dutiesAt) continue;
      }
      // a broad phrase counts only next to recruiting words ("join our AI talent pool" … "future opportunities")
      if (pattern.requiresContext.length > 0 && !pattern.requiresContext.some((re) => segment.text.search(re) !== -1)) continue;
      if (pattern.checkNegation && negated(segment, hit, pattern, rules, description)) continue;
      const { quote, offset } = clipQuote(description, segment.start, segment.end, hit, rules.settings.quote_max_chars);
      // C7: the quote must be the description at its offset; a quote that is not is never stored
      if (quote === "" || description.slice(offset, offset + quote.length) !== quote) continue;
      return { code: "evergreen_wording", points: settings.points, patternId: pattern.id, quote, offset };
    }
  }
  return null;
}
