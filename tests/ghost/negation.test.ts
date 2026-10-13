// @vitest-environment node
import { describe, expect, it } from "vitest";

import { negatedInClause, negationIndex, type NegationReach } from "@/lib/ghost/negation";
import type { CompiledGhostRules } from "@/lib/ghost/rules";

import { fixtureRules, rulesWith } from "./helpers";

/**
 * The reference: the negation test as it read the slices before, inside and after each hit on their own (the time grew with the
 * square of the hits in one piece). The index must give the same answer. The reference matches the clause breaks on the slices,
 * the index on the whole piece: the same for the packs' breaks, whose lookarounds read one character or none across a hit's edge.
 * If a pack adds a break that reads across it (`(?<=hiring)\s`, `\s(?=always)`), the fixture fuzz below fails: then the reference
 * should match the breaks on the whole piece too, not the index go back to slices (the whole piece is the documented behaviour).
 */
const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
const wordsOf = (text: string): string[] => Array.from(text.matchAll(WORD), (m) => m[0]);

function firstBreak(text: string, breaks: readonly RegExp[]): number {
  let end = text.length;
  for (const re of breaks) {
    const at = text.search(re);
    if (at !== -1 && at < end) end = at;
  }
  return end;
}

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

function referenceNegated(text: string, from: number, to: number, rules: CompiledGhostRules, reach: NegationReach): boolean {
  if (rules.negationCues.length === 0) return false;
  const head = text.slice(0, from);
  const before = reach.before === 0 ? [] : wordsOf(head.slice(lastBreakEnd(head, rules.clauseBreaks))).slice(-reach.before);
  const inside = wordsOf(text.slice(from, to));
  const tail = text.slice(to);
  const clauseAfter = wordsOf(tail.slice(0, firstBreak(tail, rules.clauseBreaks)));
  const after = reach.after === "clause" ? clauseAfter : clauseAfter.slice(0, reach.after);
  return [...before, ...inside, ...after].some((word) => rules.negationCues.some((cue) => cue.test(word)));
}

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
  "always hiring",
  "constantly recruiting",
  "always accepting applications",
  "join our talent community",
  "for our talent pool",
  "we are building a talent pool",
  "evergreen role",
  "future opportunities",
  "für unseren Talentpool",
  "stellen laufend ein",
  "suchen wir ständig",
  "Initiativbewerbung",
];
const NEGATIONS = ["not", "no", "never", "none", "without", "cannot", "can't", "don't", "isn’t", "nicht", "kein", "keine", "niemals", "Not"];
const BREAKS = [";", "(", ", not", " – ", "—", "but", "however", "and we", "so you", "not only", "aber", "jedoch", ", die", ", weil", "und wir", "nicht nur"];
const FILLER = ["we", "are", "the", "team", "Acme", "it's", "x'y", "a'b'c", "rock'n'roll", "don", "t", "42", "Über", "uns", "and", "so", "only", "is", "a"];
const JOINS = [" ", " ", " ", "  ", ", ", "'", "’", "-", "", ".", ": ", " – "];

function sentence(next: () => number): string {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const parts: string[] = [];
  const length = 2 + Math.floor(next() * 14);
  for (let i = 0; i < length; i++) {
    const roll = next();
    parts.push(roll < 0.25 ? pick(PHRASES) : roll < 0.45 ? pick(NEGATIONS) : roll < 0.6 ? pick(BREAKS) : pick(FILLER));
    parts.push(pick(JOINS));
  }
  return parts.join("");
}

const REACHES: NegationReach[] = [
  { before: 6, after: 5 },
  { before: 0, after: 0 },
  { before: 1, after: 1 },
  { before: 3, after: "clause" },
  { before: 20, after: 20 },
];

describe("negatedInClause", () => {
  it("gives the reference's answer for every pack hit in random sentences (fixture packs)", () => {
    const rules = fixtureRules();
    const next = random(20261013);
    let hits = 0;
    let negatedHits = 0;
    const differences: string[] = [];
    for (let n = 0; n < 3000; n++) {
      const text = sentence(next);
      const index = negationIndex(text, rules);
      for (const pattern of rules.evergreen) {
        for (const match of text.matchAll(pattern.re)) {
          if (match[0].length === 0) continue;
          hits += 1;
          const [from, to] = [match.index, match.index + match[0].length];
          for (const reach of REACHES) {
            const expected = referenceNegated(text, from, to, rules, reach);
            if (expected) negatedHits += 1;
            if (negatedInClause(index, from, to, reach) !== expected) differences.push(`${JSON.stringify(text)} ${from}-${to} ${JSON.stringify(reach)}`);
          }
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    // the sentences are a real test: many hits, negated and not
    expect(hits).toBeGreaterThan(1000);
    expect(negatedHits).toBeGreaterThan(hits);
    expect(negatedHits).toBeLessThan(hits * REACHES.length);
  });

  it("reads the words cut by any range as the slices alone do (apostrophes, words cut at the hit or the clause break)", () => {
    const rules = rulesWith(() => {}, { negation_cues: ["not", "no", "don['’]?t", "t", "c", "b['’]c"], clause_breaks: ["[;(]", "'s"] });
    const next = random(7);
    const differences: string[] = [];
    for (let n = 0; n < 1500; n++) {
      const text = sentence(next);
      const index = negationIndex(text, rules);
      for (let k = 0; k < 12; k++) {
        const from = Math.floor(next() * (text.length + 1));
        const to = from + Math.floor(next() * (text.length - from + 1));
        for (const reach of REACHES) {
          if (negatedInClause(index, from, to, reach) !== referenceNegated(text, from, to, rules, reach)) differences.push(`${JSON.stringify(text)} ${from}-${to} ${JSON.stringify(reach)}`);
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
  });

  it.each([
    // [text, hit, reach, negated]
    ["We're not'always hiring", "always hiring", { before: 6, after: 5 }, true],
    ["but'don't always hiring", "always hiring", { before: 6, after: 5 }, true],
    ["always hiring'not today", "always hiring", { before: 0, after: 5 }, true],
    ["We are always hiring; not today", "always hiring", { before: 6, after: 5 }, false],
    ["Not today; we are always hiring", "always hiring", { before: 6, after: 5 }, false],
    ["Not today we are always hiring", "always hiring", { before: 3, after: 5 }, false],
    ["Not today we are always hiring", "always hiring", { before: 5, after: 5 }, true],
    ["We are always hiring people who never quit", "always hiring", { before: 6, after: 2 }, false],
    ["We are always hiring people who never quit", "always hiring", { before: 6, after: "clause" }, true],
  ] as Array<[string, string, NegationReach, boolean]>)("%j around %j with %j → %s", (text, phrase, reach, expected) => {
    const rules = rulesWith(() => {}, { negation_cues: ["not", "never", "don['’]?t"], clause_breaks: ["[;(]", "(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"] });
    const from = text.indexOf(phrase);
    const to = from + phrase.length;
    expect(negatedInClause(negationIndex(text, rules), from, to, reach)).toBe(expected);
    expect(referenceNegated(text, from, to, rules, reach)).toBe(expected);
  });
});
