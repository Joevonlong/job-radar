// @vitest-environment node
import v8 from "node:v8";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import type { TextSegment } from "@/lib/job-checks/segment";
import { detectVisa, negated } from "@/lib/visa/detect";
import { negationIndex, type NegationIndex, type NegationReach } from "@/lib/visa/negation";
import { compileVisaRules, visaRulesFor, type CompiledVisaRules } from "@/lib/visa/rules";

import { shippedPipeline } from "../pipeline/helpers";

/**
 * The reference: the negation test as it read the slices before, inside and after each hit on their own (the time grew with the
 * square of the hits in one segment). The index must give the same answer. The reference matches the clause breaks on the slice
 * after the hit, the index on the whole segment: the same for the packs' breaks (no `^`, no `\b`, and their only lookbehind reads
 * one character that a hit's last character can never satisfy). The cases under "where the whole segment reads differently" pin
 * what a pack's break could change (docs/market-packs.md lists it); if a pack adds such a break and the fixture fuzz fails, the
 * reference should match the breaks on the whole segment too, not the index go back to slices.
 */
const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
const wordsOf = (text: string): string[] => Array.from(text.matchAll(WORD), (m) => m[0]);
const isCue = (word: string, cues: readonly RegExp[]): boolean => cues.some((cue) => cue.test(word));

function clauseAfter(text: string, breaks: readonly RegExp[]): string {
  let end = text.length;
  for (const re of breaks) {
    const at = text.search(re);
    if (at !== -1 && at < end) end = at;
  }
  return text.slice(0, end);
}

interface Hit {
  start: number;
  end: number;
}

function referenceNegated(segment: TextSegment, hit: Hit, rules: CompiledVisaRules, headingSaysNo: boolean): boolean {
  const cues = rules.negationCues;
  if (cues.length === 0) return false;
  if (headingSaysNo) return true;
  const from = hit.start - segment.start;
  const to = hit.end - segment.start;
  const before = rules.negationWordsBefore === 0 ? [] : wordsOf(segment.text.slice(0, from)).slice(-rules.negationWordsBefore);
  const inside = wordsOf(segment.text.slice(from, to));
  const after = rules.negationWordsAfter === 0 ? [] : wordsOf(clauseAfter(segment.text.slice(to), rules.clauseBreaks)).slice(0, rules.negationWordsAfter);
  return [...before, ...inside, ...after].some((word) => isCue(word, cues));
}

/**
 * For the run through `detectVisa`: the negation module's two tests can be switched to the reference's reading (`hooks.reference`),
 * so the negation part of the detection is compared with the reading it replaced, inside full `detectVisa` runs. Off, they are
 * the module's own. Both sides run the same `detect.ts` (the per-list heading reading, the split into clear and negated offers):
 * its directed cases are in tests/visa/detect.test.ts.
 */
const hooks = vi.hoisted(() => ({ reference: false, breaks: [] as readonly RegExp[] }));

vi.mock("@/lib/visa/negation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/visa/negation")>();
  return {
    ...actual,
    cueInside: (text: string, from: number, to: number, cues: readonly RegExp[]): boolean =>
      hooks.reference ? wordsOf(text.slice(from, to)).some((word) => isCue(word, cues)) : actual.cueInside(text, from, to, cues),
    negatedInWindow: (index: NegationIndex, from: number, to: number, reach: NegationReach): boolean => {
      if (!hooks.reference) return actual.negatedInWindow(index, from, to, reach);
      const before = reach.before === 0 ? [] : wordsOf(index.text.slice(0, from)).slice(-reach.before);
      const after = reach.after === 0 ? [] : wordsOf(clauseAfter(index.text.slice(to), hooks.breaks)).slice(0, reach.after);
      return [...before, ...after].some((word) => isCue(word, index.cues));
    },
  };
});

/** A small seeded generator (mulberry32): the same texts on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PHRASES = [
  "we offer relocation support",
  "visa sponsorship is available",
  "relocation package",
  "Relocation is not offered",
  "relocation is covered",
  "we sponsor your visa",
  "Visa support: yes",
  "helping with relocation",
  "wir bieten Relocation-Support",
  "Umzugszuschuss",
  "Visa-Sponsoring ist möglich",
  "Unterstützung beim Visumprozess",
  "übernehmen die Umzugskosten",
];
/** Sentences of the descriptions run through `detectVisa`, so that refusals (and conflicts with offers) come out too. */
const REFUSALS = ["Visa sponsorship is not available", "We cannot sponsor visas", "You must hold a valid work permit", "Ein Visa-Sponsoring ist leider nicht möglich", "No visa sponsorship"];
const NEGATIONS = ["NOT", "not", "no", "Kein", "keinen", "Don’t", "can't", "ohne", "nicht", "leider", "never", "without", "none"];
const BREAKS = [";", "(", " – ", "but", "However", "and we", "und wir", "aber", "jedoch"];
const FILLER = ["x'y", "a’b", "rock'n'roll", "ß", "Über", "İstanbul", "😀", "数据", "é", "42", "we", "the", "team", "don", "t", "Acme", "uns", "is"];
const JOINS = [" ", " ", " ", "  ", ", ", "'", "’", "-", "", ". ", ": ", "\n"];

function sentence(next: () => number): string {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const parts: string[] = [];
  const length = 2 + Math.floor(next() * 14);
  for (let i = 0; i < length; i++) {
    const roll = next();
    parts.push(roll < 0.3 ? pick(PHRASES) : roll < 0.5 ? pick(NEGATIONS) : roll < 0.62 ? pick(BREAKS) : pick(FILLER));
    parts.push(pick(JOINS));
  }
  return parts.join("");
}

/** The text as a segment of a longer description, starting at `start` (the offsets of a hit are the description's). */
const segmentOf = (text: string, start: number): TextSegment => ({ text, start, end: start + text.length, listItem: false });

const fixture = (): CompiledVisaRules => visaRulesFor(shippedPipeline());
const reach = (rules: CompiledVisaRules, before: number, after: number): CompiledVisaRules => ({ ...rules, negationWordsBefore: before, negationWordsAfter: after });
/** The fixture packs with their negation cues and clause breaks replaced. */
function customRules(cues: string[], breaks: string[]): CompiledVisaRules {
  const pipeline = shippedPipeline();
  return compileVisaRules({ ...pipeline, visa: { ...pipeline.visa, negation_cues: cues, clause_breaks: breaks } });
}

const REACHES: Array<[number, number]> = [0, 1, 6, 20].flatMap((before) => [0, 1, 5, 20].map((after): [number, number] => [before, after]));

/** The first index built for a segment is used for all its hits and windows, as `detectVisa` does. */
const sharedIndex = (text: string, rules: CompiledVisaRules): (() => NegationIndex) => {
  let index: NegationIndex | null = null;
  return () => (index ??= negationIndex(text, rules));
};

/** `negated` at `phrase` in `text` (as a segment starting at 40) and the reference's answer. */
function both(text: string, phrase: string, rules: CompiledVisaRules, at = text.indexOf(phrase)): [boolean, boolean] {
  expect(at).toBeGreaterThanOrEqual(0);
  const segment = segmentOf(text, 40);
  const hit = { start: 40 + at, end: 40 + at + phrase.length };
  return [negated(segment, hit, rules, false), referenceNegated(segment, hit, rules, false)];
}

describe("negated (the index) against the reference", () => {
  it("gives the reference's answer for every pack hit in random sentences, for every window size (fixture packs)", () => {
    const base = fixture();
    const next = random(20261013);
    let hits = 0;
    let negatedHits = 0;
    const differences: string[] = [];
    for (let n = 0; n < 3000; n++) {
      const text = sentence(next);
      const segment = segmentOf(text, 1 + Math.floor(next() * 500));
      const index = sharedIndex(text, base);
      for (const pattern of base.offered) {
        for (const match of text.matchAll(pattern.re)) {
          if (match[0].length === 0) continue;
          hits += 1;
          const hit = { start: segment.start + match.index, end: segment.start + match.index + match[0].length };
          for (const [before, after] of REACHES) {
            const rules = reach(base, before, after);
            const expected = referenceNegated(segment, hit, rules, false);
            if (expected) negatedHits += 1;
            if (negated(segment, hit, rules, false, index) !== expected) differences.push(`${JSON.stringify(text)} ${match.index} ${JSON.stringify(match[0])} ${before}/${after}`);
          }
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    // the sentences are a real test: many hits, negated and not
    expect(hits).toBeGreaterThan(1000);
    expect(negatedHits).toBeGreaterThan(hits * 2);
    expect(negatedHits).toBeLessThan(hits * (REACHES.length - 2));
  });

  it("gives the reference's result for random descriptions through detectVisa (fixture packs)", () => {
    const base = fixture();
    const next = random(424242);
    const glue = ["\n", ". ", "\n- ", ":\n- ", "\n## ", "\n\n", " "];
    const counts: Record<string, number> = {};
    const differences: string[] = [];
    try {
      for (let n = 0; n < 1500; n++) {
        const parts = Array.from({ length: 1 + Math.floor(next() * 5) }, () => (next() < 0.15 ? (REFUSALS[Math.floor(next() * REFUSALS.length)] as string) : sentence(next)));
        const text = parts.map((part, i) => (i === 0 ? part : `${glue[Math.floor(next() * glue.length)] as string}${part}`)).join("");
        for (const [before, after] of [REACHES[0], REACHES[10], REACHES[15]] as Array<[number, number]>) {
          const rules = reach(base, before, after);
          hooks.reference = false;
          const actual = detectVisa(text, rules);
          hooks.reference = true;
          hooks.breaks = rules.clauseBreaks;
          const expected = detectVisa(text, rules);
          counts[expected.status] = (counts[expected.status] ?? 0) + 1;
          if (JSON.stringify(actual) !== JSON.stringify(expected)) differences.push(`${JSON.stringify(text)} ${before}/${after}`);
        }
      }
    } finally {
      hooks.reference = false;
    }
    expect(differences.slice(0, 5)).toEqual([]);
    // the descriptions are a real test: every state comes out many times
    for (const status of ["offered", "unclear", "not_offered"]) expect(counts[status] ?? 0, status).toBeGreaterThan(100);
  });

  it("reads the words cut by any range as the slices alone do (apostrophes, words cut at the hit or the clause break)", () => {
    const rules = customRules(["not", "no", "don['’]?t", "t", "c", "b['’]c"], ["[;(]", "'s"]);
    const next = random(7);
    let negatedRanges = 0;
    let ranges = 0;
    const differences: string[] = [];
    // a hit never ends inside a surrogate pair (the patterns read code points); a slice there would read half a character
    const whole = (text: string, at: number): number => (at > 0 && at < text.length && /[\udc00-\udfff]/u.test(text.charAt(at)) && /[\ud800-\udbff]/u.test(text.charAt(at - 1)) ? at - 1 : at);
    for (let n = 0; n < 1500; n++) {
      const text = sentence(next);
      const segment = segmentOf(text, 1 + Math.floor(next() * 500));
      const index = sharedIndex(text, rules);
      for (let k = 0; k < 12; k++) {
        const from = whole(text, Math.floor(next() * (text.length + 1)));
        const to = Math.max(from, whole(text, from + Math.floor(next() * (text.length - from + 1))));
        const hit = { start: segment.start + from, end: segment.start + to };
        for (const [before, after] of REACHES) {
          const windowed = reach(rules, before, after);
          const expected = referenceNegated(segment, hit, windowed, false);
          ranges += 1;
          if (expected) negatedRanges += 1;
          if (negated(segment, hit, windowed, false, index) !== expected) differences.push(`${JSON.stringify(text)} ${from}-${to} ${before}/${after}`);
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    expect(negatedRanges).toBeGreaterThan(ranges / 10);
    expect(negatedRanges).toBeLessThan(ranges - ranges / 10);
  });

  it("follows the heading of the list and an empty cue list", () => {
    const rules = fixture();
    const segment = segmentOf("we offer relocation support", 0);
    const hit = { start: 3, end: 27 };
    expect(negated(segment, hit, rules, true)).toBe(true);
    expect(negated(segment, hit, { ...rules, negationCues: [] }, true)).toBe(false);
    expect(negated(segmentOf("not relocation support", 0), { start: 4, end: 22 }, { ...rules, negationCues: [] }, false)).toBe(false);
  });
});

describe("negated: a word cut by the hit, read on its own (not from the index)", () => {
  it.each([
    // [text, hit, cues, negated]: the hit's start cuts "t'relocation" after "t'"; what is left before it is the cue "t"
    ["t'relocation support", "relocation support", ["t"], true],
    // the hit's end cuts "ab'cd" after "ab'"; the words after it read "cd'ef", one word, which is the cue
    ["relocation ab'cd'ef", "relocation ab'", ["cd['’]ef"], true],
    // …and "ef" alone (a word of the whole segment) is not one of the words after the hit
    ["relocation ab'cd'ef", "relocation ab'", ["ef"], false],
    // the whole word before the hit is not "t" (a cut word must not take the indexed word's answer)
    ["t'xrelocation support", "xrelocation support", ["t['’]x\\p{L}*"], false],
    ["We're not'relocation support", "relocation support", ["not"], true],
    // the clause break "'s" cuts "don's": the word after the hit counts up to the break, "don"
    ["relocation support don's", "relocation support", ["don"], true],
  ] as Array<[string, string, string[], boolean]>)("%j at %j with cues %j → %s", (text, phrase, cues, expected) => {
    const rules = reach(customRules(cues, ["[;(]", "'s"]), 6, 5);
    expect(both(text, phrase, rules)).toEqual([expected, expected]);
  });
});

describe("negated: the window sizes", () => {
  it("reads the hit's own negation with both windows at zero", () => {
    const rules = reach(fixture(), 0, 0);
    expect(detectVisa("Relocation is not offered.", rules).status).toBe("unclear");
    expect(detectVisa("Relocation support is not available.", rules).status).toBe("offered");
    expect(detectVisa("Relocation support is not available.", reach(fixture(), 6, 0)).status).toBe("offered");
    expect(detectVisa("Relocation support is not available.", reach(fixture(), 0, 5)).status).toBe("unclear");
  });

  it("counts six words before the hit, not seven", () => {
    const rules = reach(fixture(), 6, 5);
    expect(both("not one two three four five relocation support", "relocation support", rules)).toEqual([true, true]);
    expect(both("not one two three four five six relocation support", "relocation support", rules)).toEqual([false, false]);
  });

  it("stops after the hit at a clause break; a comma or colon does not end the clause", () => {
    const rules = fixture();
    expect(detectVisa("We offer relocation support; not for interns.", rules).status).toBe("offered");
    expect(detectVisa("Relocation support: No", rules).status).toBe("unclear");
    expect(detectVisa("Wir bieten Relocation-Support, aber keinen Firmenwagen", rules).status).toBe("offered");
    expect(detectVisa("We offer relocation support, not for interns.", rules).status).toBe("unclear");
  });

  it("reads hits next to a 100000-letter word as the reference does", () => {
    const rules = fixture();
    const long = "a".repeat(100_000);
    const text = `nicht ${long} wir bieten Relocation-Support ${long} Relocation-Support ${long}keine`;
    const segment = segmentOf(text, 7);
    const index = sharedIndex(text, rules);
    let hits = 0;
    for (const pattern of rules.offered) {
      for (const match of text.matchAll(pattern.re)) {
        hits += 1;
        const hit = { start: 7 + match.index, end: 7 + match.index + match[0].length };
        for (const [before, after] of REACHES) {
          const windowed = reach(rules, before, after);
          expect(negated(segment, hit, windowed, false, index), `${match.index} ${before}/${after}`).toBe(referenceNegated(segment, hit, windowed, false));
        }
      }
    }
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});

// docs/market-packs.md ("clause_breaks"): the breaks are matched over the whole segment. The answers below are that reading; the
// reference (slices) differs in the first three, which no shipped break can reach.
describe("negated: where the whole segment reads differently from the slice after the hit", () => {
  it.each([
    // [break, text, hit, negated (whole segment), reference (slice)]
    // `^`: holds only at the segment's start, not at the hit's end
    ["^but", "relocation support but not available", "relocation support ", true, false],
    // `\b` right at the hit's end sees the hit's last letter
    ["\\bbut", "relocation supportbut not available", "relocation support", true, false],
    // a match that crosses the hit's end hides the matches it covers
    ["support\\s+is|\\bis\\b", "relocation support is not available", "relocation supp", true, false],
    // a lookahead reads the same in both
    ["\\s(?=relocation)", "relocation support is not available relocation", "relocation support", true, true],
    // empty matches count where they are, also right at the hit's end
    ["(?=x)", "relocation support not x", "relocation support", true, true],
    ["(?=\\s)", "relocation support not", "relocation support", false, false],
  ] as Array<[string, string, string, boolean, boolean]>)("break %j in %j", (breakSource, text, phrase, whole, slice) => {
    const rules = reach(customRules(["not"], [breakSource]), 6, 5);
    expect(both(text, phrase, rules)).toEqual([whole, slice]);
  });

  it("a lookbehind sees the hit: `(?<=support)\\s` ends the clause right after it", () => {
    const rules = customRules(["not"], ["(?<=support)\\s"]);
    expect(detectVisa("Relocation support is not available", rules).status).toBe("offered");
    expect(both("Relocation support is not available", "Relocation support", rules)).toEqual([false, true]);
  });

  it("leaves the shared expressions' state alone", () => {
    const rules = fixture();
    negationIndex("we offer relocation support; but and we however", rules);
    expect(rules.clauseBreaks.map((re) => re.lastIndex)).toEqual(rules.clauseBreaks.map(() => 0));
  });
});

describe("negationIndex", () => {
  it("holds one entry per word and per break start, and nothing that grows with the hits", () => {
    const rules = fixture();
    const text = "we offer relocation support; and we don't (x) ".repeat(50);
    const index = negationIndex(text, rules);
    expect(index.wordStarts).toHaveLength(wordsOf(text).length);
    expect(index.wordEnds).toHaveLength(index.wordStarts.length);
    expect(index.cueFlag).toHaveLength(index.wordStarts.length);
    const breaks = rules.clauseBreaks.reduce((sum, re) => sum + Array.from(text.matchAll(re)).length, 0);
    expect(index.breakStarts).toHaveLength(breaks);
    expect(Object.values(index).some((value) => value instanceof Map || value instanceof Set)).toBe(false);
  });

  it("grows linearly in memory with the segment", () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const rules = fixture();
    const heapFor = (n: number): number => {
      const text = "we offer relocation support; and we don't ".repeat(n);
      gc();
      const before = process.memoryUsage().heapUsed;
      const index = negationIndex(text, rules);
      // every word tested, as the hits of a long segment would
      for (let i = 0; i < index.wordStarts.length; i++) negated(segmentOf(text, 0), { start: index.wordStarts[i] as number, end: index.wordEnds[i] as number }, rules, false, () => index);
      gc();
      const used = process.memoryUsage().heapUsed - before;
      expect(index.wordStarts.length).toBeGreaterThan(0);
      return used;
    };
    heapFor(500);
    const small = heapFor(5000);
    const large = heapFor(20000);
    expect(large / small).toBeLessThan(6);
  });
});
