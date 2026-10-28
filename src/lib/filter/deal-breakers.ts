/**
 * Deal-breakers: the user's own veto rules (preferences.yaml `deal_breakers`), judged in the hard filter before any AI
 * call. Pure: no database, no file reads; the caller passes the market's local language and the user's level of it.
 * A vetoed job is kept (C1) with the reason `deal_breaker:<id>`; what a posting does not say never vetoes (C3).
 *
 * User patterns are regular expressions, and JavaScript has no time limit for them. So every pattern run happens inside a
 * `TimeBox` the server passes in (`vmTimeBox`, which interrupts a running expression): before a run each pattern is tried on
 * long test texts (`startDealBreakerRun`), and during it each rule has a time budget (`dealBreakerVetoes`). The schema
 * refuses the usual slow shapes earlier (`slowPatternReason`).
 */
import type { MeConfig, PipelineConfig } from "@/lib/config";
import type { DealBreaker } from "@/lib/config/schemas/preferences";
import { isGermanRequirement, type GermanLevel } from "@/lib/domain/types";
import { requiredLevelSpan } from "@/lib/pipeline/language";
import { sentenceAround } from "@/lib/signals/quote";
import { detectVisa } from "@/lib/visa/detect";
import type { CompiledVisaRules } from "@/lib/visa/rules";
import type { VisaKind } from "@/lib/visa/types";

import { wholeWordSource } from "./rules";

/** CEFR levels in ascending order: the index is the rank (-1 = none, 6 = native). */
const CEFR: readonly string[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
const NATIVE_RANK = CEFR.length;

/** What the rules read of me.yaml: the languages (a language gate) and whether the user needs sponsorship (a visa rule). */
export type DealBreakerMe = Pick<MeConfig, "languages"> & Partial<Pick<MeConfig, "needs_visa_sponsorship">>;

/** What the rules need besides the job: the limits and the language the gate compares. */
export interface DealBreakerContext {
  /** The market's local language (`market.language.code`); null = the language step is off, a language gate does nothing. */
  language: string | null;
  /** me.yaml, or null when it cannot be read (a gate without `at_least` and a visa rule then do nothing). */
  me: DealBreakerMe | null;
  limits: DealBreakerLimits;
  /** The visa patterns of the market packs (`compileVisaRules`); absent = none, a visa rule never vetoes. */
  visa?: CompiledVisaRules | null;
}

/** The fields of a job the rules read. */
export interface DealBreakerJob {
  title: string;
  description: string | null;
  /** `jobs.german_level_required`: the pipeline's rule reading of the local language (never the AI's). */
  germanLevel: GermanLevel;
  /** The company's `name_norm` (the visa rule: a company named like a visa word counts only combined visa phrases). */
  companyNameNorm?: string | null;
}

export type DealBreakerWarningCode = "no_language_step" | "me_unreadable" | "visa_not_needed" | "too_many_rules" | "pattern_too_long" | "too_slow";

export type DealBreakerLimits = PipelineConfig["filter"]["deal_breakers"];

/**
 * Runs `work` and stops it after `ms` milliseconds, even inside a regular expression: true when it finished, false when it
 * was stopped. The server's is `vmTimeBox` (node:vm); this module only takes it as a parameter, because the job pages'
 * client code reaches this file.
 */
export type TimeBox = (work: () => void, ms: number) => boolean;

export interface DealBreakerWarning {
  id: string;
  code: DealBreakerWarningCode;
}

interface CompiledGate {
  rule: Extract<DealBreaker, { type: "language_gate" }>;
  /** The lowest rank that vetoes. */
  threshold: number;
}

interface CompiledPhrase {
  rule: Extract<DealBreaker, { type: "phrase" }>;
  /** Terms and patterns, global (scanned with `exec`). */
  matchers: RegExp[];
  unless: RegExp[];
}

interface CompiledVisa {
  rule: Extract<DealBreaker, { type: "visa_not_offered" }>;
  visa: CompiledVisaRules | null;
}

export type CompiledDealBreaker = CompiledGate | CompiledPhrase | CompiledVisa;

export interface CompiledDealBreakers {
  rules: readonly CompiledDealBreaker[];
  /** Rules that are written but do nothing (see `DealBreakerWarningCode`). */
  warnings: readonly DealBreakerWarning[];
  limits: DealBreakerLimits;
}

const isGate = (rule: CompiledDealBreaker): rule is CompiledGate => rule.rule.type === "language_gate";
const isVisa = (rule: CompiledDealBreaker): rule is CompiledVisa => rule.rule.type === "visa_not_offered";
const isPhrase = (rule: CompiledDealBreaker): rule is CompiledPhrase => rule.rule.type === "phrase";

/**
 * The user's rank of the local language (-1 = none listed, 0..5 = A1..C2, 6 = native): the same reading as
 * `userLanguageRank` of scoring, kept here because that module loads config files, and the job pages' client code reaches
 * this one through the filter's text helpers (a test holds the two equal).
 */
export function userLocalRank(me: Pick<MeConfig, "languages">, language: string): number {
  for (const entry of me.languages) {
    const level = entry[language];
    if (level === undefined) continue;
    return level === "native" ? NATIVE_RANK : CEFR.indexOf(level);
  }
  return -1;
}

/** Rank -> "B1", "native", "none". */
export function rankLabel(rank: number): string {
  return rank < 0 ? "none" : rank >= NATIVE_RANK ? "native" : (CEFR[rank] ?? "none");
}

/**
 * A user pattern as a RegExp. V8 runs `\b` very slowly when the `i` and `u` flags are both set (no position can be skipped:
 * about 15 times slower over a description), and `\bno travel\b` is the usual way to write a pattern. So a pattern with a
 * word boundary and nothing that needs `u` (no `\p{…}`, no `\u{…}`) is compiled without it; the schema has already checked
 * it with `u`, the stricter syntax. That is not the same matching in every case: without `u` the pattern works on UTF-16
 * code units, so `.` or `.{0,N}` counts an emoji as two characters, and case folding differs for a few letters (`ẞ`/`ß`,
 * the Kelvin sign, the long s). `\b` sees ASCII word characters only either way (`\bMünchen\b` fails after "Mü"); the
 * user guide says so.
 */
function userRegExp(source: string, flags: "giu" | "iu"): RegExp {
  if (/\\[bB]/u.test(source) && !/\\(?:[pP]|u\{)/u.test(source)) {
    try {
      return new RegExp(source, flags.replace("u", ""));
    } catch {
      // not valid without u: keep it
    }
  }
  return new RegExp(source, flags);
}

/** Compile the enabled rules once for many jobs. Rules over the pipeline.yaml limits and gates that cannot work are left out, with a warning. */
export function compileDealBreakers(rules: readonly DealBreaker[], context: DealBreakerContext): CompiledDealBreakers {
  const compiled: CompiledDealBreaker[] = [];
  const warnings: DealBreakerWarning[] = [];
  const { limits } = context;
  rules.forEach((rule, index) => {
    if (index >= limits.max_rules) {
      warnings.push({ id: rule.id, code: "too_many_rules" });
      return;
    }
    if (!rule.enabled) return;
    if (rule.type === "language_gate") {
      if (context.language === null) {
        warnings.push({ id: rule.id, code: "no_language_step" });
        return;
      }
      if (rule.at_least !== undefined) {
        compiled.push({ rule, threshold: CEFR.indexOf(rule.at_least) });
        return;
      }
      if (context.me === null) {
        warnings.push({ id: rule.id, code: "me_unreadable" });
        return;
      }
      compiled.push({ rule, threshold: userLocalRank(context.me, context.language) + 1 });
      return;
    }
    if (rule.type === "visa_not_offered") {
      if (context.me === null) {
        warnings.push({ id: rule.id, code: "me_unreadable" });
        return;
      }
      if (context.me.needs_visa_sponsorship !== true) {
        warnings.push({ id: rule.id, code: "visa_not_needed" });
        return;
      }
      compiled.push({ rule, visa: context.visa ?? null });
      return;
    }
    if ([...rule.terms, ...rule.patterns, ...rule.unless].some((text) => text.length > limits.max_pattern_chars)) {
      warnings.push({ id: rule.id, code: "pattern_too_long" });
      return;
    }
    const matchers: RegExp[] = [];
    if (rule.terms.length > 0) matchers.push(new RegExp(wholeWordSource(rule.terms, true), "giu"));
    for (const pattern of rule.patterns) matchers.push(userRegExp(pattern, "giu"));
    compiled.push({ rule, matchers, unless: rule.unless.map((pattern) => userRegExp(pattern, "iu")) });
  });
  return { rules: compiled, warnings, limits };
}

interface Hit {
  field: "title" | "description";
  start: number;
  end: number;
}

const endsSentence = (char: string): boolean => char === "." || char === "!" || char === "?";
const isSpace = (char: string): boolean => /\s/u.test(char);

/**
 * The sentence around a hit, the way the quotes cut it (`sentenceAround`): within its line, from after the last ".", "!" or "?"
 * that is followed by whitespace, to the next one. Found by scanning from the hit (a description is often one long line).
 */
function sentenceOf(text: string, start: number, end: number): string {
  let from = start;
  while (from > 0) {
    const before = text.charAt(from - 1);
    if (before === "\n" || (isSpace(before) && from >= 2 && endsSentence(text.charAt(from - 2)))) break;
    from -= 1;
  }
  let to = Math.max(end, start + 1);
  while (to < text.length) {
    const char = text.charAt(to);
    if (char === "\n") break;
    if (endsSentence(char) && (to + 1 === text.length || isSpace(text.charAt(to + 1)))) {
      to += 1;
      break;
    }
    to += 1;
  }
  return text.slice(from, to);
}

/** A sentence holding the hit matches one of `unless` ("no travel required"): the hit does not count. */
function excused(text: string, start: number, end: number, unless: readonly RegExp[]): boolean {
  if (unless.length === 0) return false;
  const sentence = sentenceOf(text, start, end);
  return unless.some((pattern) => pattern.test(sentence));
}

function firstHit(text: string, rule: CompiledPhrase): { start: number; end: number } | null {
  for (const matcher of rule.matchers) {
    matcher.lastIndex = 0;
    for (let m = matcher.exec(text); m !== null; m = matcher.exec(text)) {
      if (m[0].length === 0) {
        matcher.lastIndex += 1;
        continue;
      }
      if (!excused(text, m.index, m.index + m[0].length, rule.unless)) return { start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

function phraseHit(job: DealBreakerJob, rule: CompiledPhrase, maxChars: number): Hit | null {
  const scope = rule.rule.scope;
  if (scope !== "description") {
    const hit = firstHit(job.title, rule);
    if (hit) return { field: "title", ...hit };
  }
  if (scope !== "title" && job.description) {
    const hit = firstHit(job.description.length > maxChars ? job.description.slice(0, maxChars) : job.description, rule);
    if (hit) return { field: "description", ...hit };
  }
  return null;
}

function gateHits(job: DealBreakerJob, rule: CompiledGate): boolean {
  return isGermanRequirement(job.germanLevel) && CEFR.indexOf(job.germanLevel) >= rule.threshold;
}

/**
 * The visa rule: the JD refuses sponsorship or asks for a permit (`not_offered`, computed on the spot from the packs' patterns,
 * hidden text included: the stored check may differ, see docs/visa-sponsorship.md). The first quote of that verdict, or null.
 */
function visaRefusal(job: DealBreakerJob, rule: CompiledVisa): { quote: string; offset: number; kind: VisaKind } | null {
  if (rule.visa === null || !job.description) return null;
  const result = detectVisa(job.description, rule.visa, { companyNameNorm: job.companyNameNorm ?? null });
  if (result.status !== "not_offered") return null;
  const evidence = result.evidence.find((e) => e.status === "not_offered");
  return evidence ? { quote: evidence.quote, offset: evidence.offset, kind: evidence.kind } : null;
}

/**
 * How long a run of digits or of whitespace is in the test texts. Real text has short runs (an order number, an IBAN, the
 * spaces of a layout), and a pattern that backtracks exponentially on them (`(\d+)+x`, `(\d+[.,]?)+\s*k`) takes seconds
 * at 30 characters already; repeated runs of this length show that, while a pattern that is merely quadratic in the run
 * (`\d+\s*k`) stays fast, as it is on real text.
 */
const PROBE_RUN_CHARS = 64;

/** `run` repeated, each copy closed by "!" (which nothing expects), up to `length` characters. */
const runs = (run: string, length: number): string => `${run}!`.repeat(Math.ceil(length / (run.length + 1))).slice(0, length);

/** Test texts as long as the text a pattern searches: a long line without a match is where backtracking shows. */
function probeTexts(source: string, length: number): string[] {
  const filler = "Lorem ipsum 100 % vor Ort, dolor-sit_amet 42 Reisetätigkeit ";
  const texts = [
    "a".repeat(Math.max(0, length - 1)) + "!",
    filler.repeat(Math.ceil(length / filler.length)).slice(0, length),
    // the classes \d and \s, which the letters the pattern names below never stand for
    runs("1".repeat(PROBE_RUN_CHARS), length),
    runs(" ".repeat(PROBE_RUN_CHARS), length),
  ];
  const withTail = [runs("a".repeat(PROBE_RUN_CHARS), length), ...texts.slice(2)];
  // the letters and digits the pattern names, each repeated: `(a|a)+` and its kind fail on these
  const chars = [...new Set(source.toLowerCase().replace(/\\./gu, "").match(/[\p{L}\p{N}]/gu) ?? [])].filter((char) => char !== "a").slice(0, 6);
  for (const char of chars) {
    texts.push(char.repeat(Math.max(0, length - 1)) + "!");
    withTail.push(runs(char.repeat(PROBE_RUN_CHARS), length));
  }
  // and the pattern's own text at the end: a text without a literal the pattern needs ("€", "Tsd") is refused at once by
  // the engine's quick check, while a real description has that literal somewhere else. Keep the original texts too:
  // adding a required literal may make a slow pattern match immediately. Only separated short runs get the tail, so an
  // ordinary pattern such as `\p{Lu}{6,}!` does not backtrack over a synthetic 20,000-letter run missing its final "!".
  const tail = ` ${source}`;
  return [...texts, ...withTail.map((text) => text.slice(0, Math.max(0, length - tail.length)) + tail)];
}

/**
 * Patterns that passed the probe, by use, limits and pattern: a fast pattern is tried once per process (until the cache is
 * full). A failure is not kept: a pattern that was slow on a busy machine is tried again in the next run.
 */
const probeCache = new Set<string>();
const PROBE_CACHE_MAX = 512;

/** The limits the probe reads: the length of a test text and the time one pattern may take on it. */
export type PatternProbeLimits = Pick<DealBreakerLimits, "match_text_max_chars" | "match_ms">;

/**
 * Whether `pattern` finishes on every test text within `limits.match_ms` each: a pattern (flags "giu") is run the way a rule
 * scans a text (every match), an `unless` pattern (flags "iu") the way it tests a sentence. A `signal` pattern (an
 * interests.yaml pattern) is compiled as the signal rules compile it (flags "giu", always with `u`) and scanned like a pattern.
 */
export function patternIsFast(pattern: string, use: "pattern" | "unless" | "signal", limits: PatternProbeLimits, timeBox: TimeBox): boolean {
  const key = `${use}\u0000${limits.match_text_max_chars}\u0000${limits.match_ms}\u0000${pattern}`;
  if (probeCache.has(key)) return true;
  const regexp = use === "signal" ? new RegExp(pattern, "giu") : userRegExp(pattern, use === "pattern" ? "giu" : "iu");
  const fast = probeTexts(pattern, limits.match_text_max_chars).every((text) =>
    timeBox(() => {
      if (use === "unless") {
        regexp.test(text);
        return;
      }
      regexp.lastIndex = 0;
      for (let m = regexp.exec(text); m !== null; m = regexp.exec(text)) if (m[0].length === 0) regexp.lastIndex += 1;
    }, limits.match_ms),
  );
  if (!fast) return false;
  if (probeCache.size >= PROBE_CACHE_MAX) probeCache.clear();
  probeCache.add(key);
  return true;
}

/** A pattern of `rules` that is too slow on the test texts (`patternIsFast`); `path` is inside preferences.yaml `deal_breakers`. */
export interface SlowPatternProblem {
  path: [number, "patterns" | "unless", number];
}

/** Every pattern of `rules` that is too slow; saving and `config:check` refuse these. */
export function slowPatternProblems(rules: readonly DealBreaker[], limits: DealBreakerLimits, timeBox: TimeBox): SlowPatternProblem[] {
  const problems: SlowPatternProblem[] = [];
  rules.forEach((rule, index) => {
    if (rule.type !== "phrase") return;
    rule.patterns.forEach((pattern, at) => {
      if (!patternIsFast(pattern, "pattern", limits, timeBox)) problems.push({ path: [index, "patterns", at] });
    });
    rule.unless.forEach((pattern, at) => {
      if (!patternIsFast(pattern, "unless", limits, timeBox)) problems.push({ path: [index, "unless", at] });
    });
  });
  return problems;
}

const ruleIsFast = (rule: CompiledPhrase, limits: DealBreakerLimits, timeBox: TimeBox): boolean =>
  rule.rule.patterns.every((pattern) => patternIsFast(pattern, "pattern", limits, timeBox)) && rule.rule.unless.every((pattern) => patternIsFast(pattern, "unless", limits, timeBox));

/** One filter run (or one preview) of the compiled rules: the rules still running, the time each may still take, what stopped. */
export interface DealBreakerRun {
  readonly timeBox: TimeBox;
  readonly limits: DealBreakerLimits;
  /** The ids of every compiled rule, in the order of the file (also those left out as too slow). */
  readonly order: readonly string[];
  /** `left`: milliseconds of `limits.rule_budget_ms` the rule may still use; 0 = stopped as too slow. */
  readonly active: Array<{ rule: CompiledDealBreaker; left: number }>;
  /** Rules left out or stopped because they are too slow, in the order found. */
  readonly warnings: DealBreakerWarning[];
}

/** Start a run: a phrase rule with a pattern that is too slow on the test texts is left out, with the warning `too_slow`. */
export function startDealBreakerRun(compiled: CompiledDealBreakers, timeBox: TimeBox): DealBreakerRun {
  const run: DealBreakerRun = { timeBox, limits: compiled.limits, order: compiled.rules.map((rule) => rule.rule.id), active: [], warnings: [] };
  for (const rule of compiled.rules) {
    if (isPhrase(rule) && !ruleIsFast(rule, compiled.limits, timeBox)) run.warnings.push({ id: rule.rule.id, code: "too_slow" });
    else run.active.push({ rule, left: compiled.limits.rule_budget_ms });
  }
  return run;
}

/**
 * The ids of the rules that veto each job of `jobs`, in the order of the file. Each phrase rule, and the visa rule, runs over the
 * whole batch in one time box: a rule that uses up its budget is stopped where it is, keeps the vetoes it found, does nothing for the rest
 * of the run, and is reported in `run.warnings` (`too_slow`). A rule that did not judge a job (left out as too slow, or
 * stopped before it reached the job) keeps the veto the job had from it before: `previous[i]` are the ids of the rules that
 * vetoed `jobs[i]` in the stored result, so a slow machine never turns a vetoed job into a passed one. With a `deadline` (a
 * `performance.now()` time) the batch stops there too: `complete` is then false and the vetoes are not usable.
 */
export function dealBreakerVetoes(
  run: DealBreakerRun,
  jobs: readonly DealBreakerJob[],
  options: { deadline?: number; previous?: ReadonlyArray<readonly string[] | undefined> } = {},
): { vetoes: string[][]; complete: boolean } {
  const { deadline, previous } = options;
  const hitBy = jobs.map(() => new Set<string>());
  // rules that did not judge the job: those not running, and those stopped before they reached it
  const undecided = jobs.map(() => new Set<string>());
  const running = new Set(run.active.map((entry) => entry.rule.rule.id));
  for (const id of run.order) if (!running.has(id)) for (const set of undecided) set.add(id);
  const maxChars = run.limits.match_text_max_chars;
  for (const entry of run.active) {
    const { rule } = entry;
    const id = rule.rule.id;
    if (entry.left <= 0) {
      for (const set of undecided) set.add(id);
      continue;
    }
    if (isGate(rule)) {
      jobs.forEach((job, i) => {
        if (gateHits(job, rule)) hitBy[i]?.add(id);
      });
      continue;
    }
    // a phrase rule and the visa rule (the packs' patterns read every open JD) share the time box and budget
    const hitsJob = isVisa(rule) ? (job: DealBreakerJob): boolean => visaRefusal(job, rule) !== null : (job: DealBreakerJob): boolean => phraseHit(job, rule, maxChars) !== null;
    const untilDeadline = deadline === undefined ? Infinity : deadline - performance.now();
    if (untilDeadline <= 0) return { vetoes: [], complete: false };
    const box = Math.min(entry.left, untilDeadline);
    const byDeadline = untilDeadline < entry.left;
    const hits: number[] = [];
    let done = 0;
    const started = performance.now();
    const finished = run.timeBox(() => {
      for (; done < jobs.length; done += 1) {
        const job = jobs[done];
        if (job && hitsJob(job)) hits.push(done);
      }
    }, box);
    entry.left -= performance.now() - started;
    if (!finished && byDeadline) return { vetoes: [], complete: false };
    for (const i of hits) hitBy[i]?.add(id);
    if (!finished) {
      entry.left = 0;
      run.warnings.push({ id, code: "too_slow" });
      for (let i = done; i < jobs.length; i += 1) if (!hitBy[i]?.has(id)) undecided[i]?.add(id);
    }
  }
  const vetoes = jobs.map((_, i) => {
    const before = previous?.[i] ?? [];
    return run.order.filter((id) => hitBy[i]?.has(id) || (undecided[i]?.has(id) && before.includes(id)));
  });
  return { vetoes: vetoes.map((ids) => [...new Set(ids)]), complete: true };
}

/** Why a rule vetoes a job, for the detail page and `deal-breakers:check`; computed when shown, never stored. */
export interface DealBreakerExplanation {
  id: string;
  type: DealBreaker["type"];
  /** Verbatim text of the job around the hit (C7): a substring of the title or of the description; null when there is none to show. */
  quote: string | null;
  /** Where `quote` comes from and where it starts. */
  field: "title" | "description" | null;
  offset: number | null;
  /** Language gate: the level the rules read in the posting, and the user's level (or the rule's `at_least`). */
  required?: GermanLevel;
  /** Visa rule: why the JD counts as not offering sponsorship. */
  visaKind?: VisaKind;
  userLevel?: string;
  atLeast?: string;
}

/** The longest quote shown for a hit. */
const QUOTE_MAX_CHARS = 280;

/**
 * Explain a rule that vetoes `job` (null when it does not, or the rule is not active). A language gate quotes the sentence the
 * pipeline's rules read the level from (none when it is in the title or not found) and names both levels.
 */
export function explainDealBreaker(job: DealBreakerJob, rule: DealBreaker, context: DealBreakerContext, pipeline: PipelineConfig, timeBox: TimeBox): DealBreakerExplanation | null {
  const compiled = compileDealBreakers([{ ...rule, enabled: true }], context).rules[0];
  if (!compiled) return null;
  if (isGate(compiled)) {
    if (!gateHits(job, compiled)) return null;
    const level = job.germanLevel;
    const base: DealBreakerExplanation = { id: rule.id, type: rule.type, quote: null, field: null, offset: null, required: level };
    if (rule.type === "language_gate" && rule.at_least !== undefined) base.atLeast = rule.at_least;
    else if (context.me !== null && context.language !== null) base.userLevel = rankLabel(userLocalRank(context.me, context.language));
    const prefix = `${job.title}\n`;
    const span = job.description ? requiredLevelSpan(`${prefix}${job.description}`, level, pipeline) : null;
    if (span !== null && job.description && span.start >= prefix.length) {
      const { quote, offset } = sentenceAround(job.description, { start: span.start - prefix.length, end: span.end - prefix.length }, QUOTE_MAX_CHARS);
      return { ...base, quote, field: "description", offset };
    }
    return base;
  }
  if (isVisa(compiled)) {
    // within `match_ms`, like a phrase rule
    const visa: { refusal: ReturnType<typeof visaRefusal> } = { refusal: null };
    if (!timeBox(() => void (visa.refusal = visaRefusal(job, compiled)), context.limits.match_ms)) return null;
    const { refusal } = visa;
    if (refusal === null) return null;
    return { id: rule.id, type: rule.type, quote: refusal.quote, field: "description", offset: refusal.offset, visaKind: refusal.kind };
  }
  // one job, within `match_ms`: a page never waits longer for its explanation
  const found: { hit: Hit | null } = { hit: null };
  if (!timeBox(() => void (found.hit = phraseHit(job, compiled, context.limits.match_text_max_chars)), context.limits.match_ms)) return null;
  const { hit } = found;
  if (hit === null) return null;
  const text = hit.field === "title" ? job.title : (job.description ?? "");
  const { quote, offset } = sentenceAround(text, hit, QUOTE_MAX_CHARS);
  return { id: rule.id, type: rule.type, quote, field: hit.field, offset };
}

/** A rule list over the limits of pipeline.yaml `filter.deal_breakers` (`path` is inside preferences.yaml `deal_breakers`). */
export interface DealBreakerLimitProblem {
  path: Array<string | number>;
  kind: "too_many_rules" | "pattern_too_long";
  max: number;
}

/** Where `rules` break the limits of pipeline.yaml (the schema only knows the hard upper bounds). Saving and `config:check` refuse these. */
export function dealBreakerLimitProblems(rules: readonly DealBreaker[], limits: DealBreakerLimits): DealBreakerLimitProblem[] {
  const problems: DealBreakerLimitProblem[] = [];
  if (rules.length > limits.max_rules) problems.push({ path: [], kind: "too_many_rules", max: limits.max_rules });
  rules.forEach((rule, index) => {
    if (rule.type !== "phrase") return;
    for (const field of ["terms", "patterns", "unless"] as const) {
      const at = rule[field].findIndex((text) => text.length > limits.max_pattern_chars);
      if (at !== -1) problems.push({ path: [index, field, at], kind: "pattern_too_long", max: limits.max_pattern_chars });
    }
  });
  return problems;
}
