import type { InterestsConfig, PipelineConfig } from "@/lib/config";
import { compileRules } from "@/lib/pipeline/rules";
import { isBenefitAmount } from "@/lib/pipeline/salary";

import { parseHitAmount, type AmountOptions } from "./amount";
import { buildCatalog } from "./catalog";
import { lineBounds, sentenceAround } from "./quote";
import { amountKind, type SignalAmount, type SignalCategoryId, type Span } from "./types";

/** What the rule stage found in the JD: a quoted sentence plus, for the amount category, the parsed amount. */
export interface RuleCandidate {
  /** Category id. */
  tier: SignalCategoryId;
  kind: string;
  /** Verbatim sentence of the JD that holds the hit (C7). */
  quote: string;
  quoteOffset: number;
  /** Where the hit itself is. */
  hit: Span;
  /** Amount category only. */
  value: SignalAmount | null;
  /** Needs the AI's confirmation before it counts (a category with `ai_confirm_only`). */
  aiConfirmOnly: boolean;
  /** A tag category's candidate: never sent to the AI, kept as the rules found it. */
  isTag?: boolean;
}

interface KeywordRules {
  id: string;
  kind: string;
  hits: RegExp[];
  exclude: RegExp[];
  aiConfirmOnly: boolean;
}

interface CompiledSignalRules {
  amount: { id: string; patterns: RegExp[]; exclude: RegExp[]; aiConfirmOnly: boolean; minAnnualEur: number; assumeCurrency: string | null } | null;
  keyword: KeywordRules[];
  tags: Array<{ id: string; entries: Array<{ name: string; pattern: RegExp }> }>;
  order: (id: string) => number;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A literal term as a whole-word regex; spaces match any whitespace. */
function termRegex(term: string): RegExp {
  const body = term.trim().split(/\s+/u).map(escapeRegex).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

const patternRegex = (source: string): RegExp => new RegExp(source, "giu");

const cache = new WeakMap<object, CompiledSignalRules>();

/** The active categories of interests.yaml compiled once per loaded config object (a hot reload yields a new object). */
export function compileSignalRules(config: Pick<InterestsConfig, "signals">): CompiledSignalRules {
  const hit = cache.get(config.signals);
  if (hit) return hit;
  const catalog = buildCatalog(config);
  const compiled: CompiledSignalRules = { amount: null, keyword: [], tags: [], order: catalog.order };
  for (const category of catalog.categories) {
    if (category.kind === "amount") {
      compiled.amount = {
        id: category.id,
        patterns: category.patterns.map(patternRegex),
        exclude: category.exclude.map(patternRegex),
        aiConfirmOnly: category.ai_confirm_only === true,
        minAnnualEur: category.amount.min_annual,
        assumeCurrency: category.amount.assume_currency,
      };
    } else if (category.kind === "keyword") {
      compiled.keyword.push({
        id: category.id,
        kind: catalog.kindOf(category.id),
        hits: [...category.keywords.map(termRegex), ...category.patterns.map(patternRegex)],
        exclude: category.exclude.map(patternRegex),
        aiConfirmOnly: category.ai_confirm_only === true,
      });
    } else {
      compiled.tags.push({
        id: category.id,
        entries: [...category.tags.map((name) => ({ name, pattern: termRegex(name) })), ...category.tag_patterns.map((p) => ({ name: p.name, pattern: patternRegex(p.pattern) }))],
      });
    }
  }
  cache.set(config.signals, compiled);
  return compiled;
}

function allHits(patterns: readonly RegExp[], text: string): Span[] {
  const hits: Span[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[0] === "" || match.index === undefined) continue;
      hits.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return hits;
}

/** Greedy: longest hits first, a hit that overlaps one already kept is dropped; result in text order. */
function withoutOverlaps(hits: readonly Span[]): Span[] {
  const kept: Span[] = [];
  for (const hit of [...hits].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)) {
    if (!kept.some((k) => hit.start < k.end && hit.end > k.start)) kept.push(hit);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** An exclude match that starts inside the hit, or up to `lookbehind` characters before it, vetoes the hit. */
function isExcluded(text: string, hit: Span, exclude: readonly RegExp[], lookbehind: number): boolean {
  if (exclude.length === 0) return false;
  const line = lineBounds(text, hit.start);
  const lineText = text.slice(line.start, line.end);
  for (const pattern of exclude) {
    for (const match of lineText.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const start = line.start + match.index;
      if (start < hit.end && start >= hit.start - lookbehind) return true;
    }
  }
  return false;
}

/**
 * Every signal candidate in a JD, by the active categories of interests.yaml: amounts (parsed, converted to a year,
 * below-minimum ones dropped), keyword hits and tags, each with its quoted sentence. At most `limits.per_category_max`
 * per category and one per sentence and category; tags one per name, at most `limits.tags_max` per tag category.
 * Pure and deterministic; no AI. Candidates of `ai_confirm_only` categories are marked, not removed.
 */
export function findCandidates(description: string, config: Pick<InterestsConfig, "signals" | "limits">, pipeline: PipelineConfig): RuleCandidate[] {
  const rules = compileSignalRules(config);
  const { limits } = config;
  const salaryContext = compileRules(pipeline).salaryContext;
  const out: RuleCandidate[] = [];
  if (rules.amount) findAmounts(description, rules.amount, limits, pipeline, salaryContext, out);

  // ---- keyword categories
  for (const category of rules.keyword) {
    const seen = new Set<number>();
    for (const hit of withoutOverlaps(allHits(category.hits, description))) {
      if (isExcluded(description, hit, category.exclude, limits.exclude_lookbehind_chars)) continue;
      const { quote, offset } = sentenceAround(description, hit, limits.quote_max_chars);
      if (seen.has(offset)) continue;
      seen.add(offset);
      out.push({ tier: category.id, kind: category.kind, quote, quoteOffset: offset, hit, value: null, aiConfirmOnly: category.aiConfirmOnly });
      if (seen.size >= limits.per_category_max) break;
    }
  }

  // ---- tag categories: one per tag name
  for (const category of rules.tags) {
    const tagNames = new Set<string>();
    const tagHits = category.entries
      .flatMap((tag) => {
        const first = allHits([tag.pattern], description)[0];
        return first ? [{ name: tag.name, hit: first }] : [];
      })
      .sort((a, b) => a.hit.start - b.hit.start);
    for (const { name, hit } of tagHits) {
      if (tagNames.has(name) || tagNames.size >= limits.tags_max) continue;
      tagNames.add(name);
      const { quote, offset } = sentenceAround(description, hit, limits.quote_max_chars);
      out.push({ tier: category.id, kind: name, quote, quoteOffset: offset, hit, value: null, aiConfirmOnly: false, isTag: true });
    }
  }

  return out.sort((a, b) => rules.order(a.tier) - rules.order(b.tier) || a.hit.start - b.hit.start);
}

function findAmounts(
  description: string,
  amount: NonNullable<CompiledSignalRules["amount"]>,
  limits: InterestsConfig["limits"],
  pipeline: PipelineConfig,
  salaryContext: readonly RegExp[],
  out: RuleCandidate[],
): void {
  const options = (hasSalaryWord: boolean): AmountOptions => ({ minAnnualEur: amount.minAnnualEur, assumeCurrency: amount.assumeCurrency, salaryContext: hasSalaryWord, description });
  const t1Hits: Array<{ hit: Span; quote: string; offset: number; value: SignalAmount }> = [];
  for (const hit of allHits(amount.patterns, description)) {
    if (isExcluded(description, hit, amount.exclude, limits.exclude_lookbehind_chars)) continue;
    // "Relocation support: up to €25,000", "€30,000 learning budget": a benefit, not a salary (pipeline.yaml salary.negative_context_patterns)
    if (isBenefitAmount(description, hit, pipeline)) continue;
    const { quote, offset } = sentenceAround(description, hit, limits.quote_max_chars);
    const line = lineBounds(description, hit.start);
    const hasSalaryWord = salaryContext.some((p) => p.test(quote));
    const value = parseHitAmount(
      description.slice(hit.start, hit.end),
      description.slice(line.start, hit.start),
      description.slice(hit.end, line.end),
      pipeline,
      options(hasSalaryWord),
    );
    if (value) t1Hits.push({ hit, quote, offset, value });
  }
  // overlapping hits (several patterns match the same amount): keep the one that reads the most (a range beats a single figure), then the longest
  const rangeness = (v: SignalAmount): number => (v.min !== null && v.max !== null && v.min !== v.max ? 1 : 0);
  const keptT1: typeof t1Hits = [];
  for (const candidate of [...t1Hits].sort((a, b) => rangeness(b.value) - rangeness(a.value) || b.hit.end - b.hit.start - (a.hit.end - a.hit.start) || a.hit.start - b.hit.start)) {
    if (!keptT1.some((k) => candidate.hit.start < k.hit.end && candidate.hit.end > k.hit.start)) keptT1.push(candidate);
  }
  const seenT1 = new Set<number>();
  for (const found of keptT1.sort((a, b) => a.hit.start - b.hit.start)) {
    if (seenT1.has(found.offset)) continue;
    seenT1.add(found.offset);
    out.push({ tier: amount.id, kind: amountKind(found.value), quote: found.quote, quoteOffset: found.offset, hit: found.hit, value: found.value, aiConfirmOnly: amount.aiConfirmOnly });
    if (seenT1.size >= limits.per_category_max) break;
  }
}

/**
 * Where the term that makes `quote` a signal of category `tier` stands in the quote (the amount, the keyword): what
 * the detail page keeps visible when it shortens a long quote. The vocabulary is looked up again in the quote, so it
 * also works for a quote the AI found. Null for tags, unknown categories and when nothing in the quote hits.
 */
export function findQuoteTerm(quote: string, tier: SignalCategoryId, config: Pick<InterestsConfig, "signals">): Span | null {
  const rules = compileSignalRules(config);
  const isAmount = rules.amount?.id === tier;
  const patterns = isAmount ? rules.amount?.patterns : rules.keyword.find((category) => category.id === tier)?.hits;
  if (!patterns) return null;
  const hits = allHits(patterns, quote);
  if (hits.length === 0) return null;
  const first = [...hits].sort((a, b) => a.start - b.start || b.end - a.end)[0] ?? null;
  return isAmount && first ? widenToRange(quote, first, hits) : first;
}

/** What may stand between the two ends of a stated range ("€100,000/yr - €120,000/yr", "85k to 105k", "85.000 bis 105.000 EUR"). */
const RANGE_CONNECTOR = /^[\s/.\-–—~]*(?:(?:yr|year|years|jahr|p\.?\s?a\.?|per annum|pro jahr|to|bis|and|und|gross|brutto)\b[\s/.\-–—~]*)*$/i;

/** The amounts of a stated range are two hits with only a connector between them: the term is the whole range, not its first end. */
function widenToRange(quote: string, first: Span, hits: readonly Span[]): Span {
  let end = first.end;
  for (const next of [...hits].sort((a, b) => a.start - b.start)) {
    if (next.start < end) {
      end = Math.max(end, next.end);
      continue;
    }
    if (RANGE_CONNECTOR.test(quote.slice(end, next.start))) end = next.end;
    else break;
  }
  return { ...first, end };
}
