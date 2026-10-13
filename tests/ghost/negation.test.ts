// @vitest-environment node
import { describe, expect, it } from "vitest";

import { negatedInClause, negationIndex, windowWords, type NegationReach } from "@/lib/ghost/negation";
import type { CompiledGhostRules } from "@/lib/ghost/rules";
import { evergreenWording } from "@/lib/ghost/signals";

import { fixtureRules, rulesWith } from "./helpers";

/**
 * Reference A: the negation test as it read the slices before, inside and after each hit on their own (the time grew with the
 * square of the hits in one piece). The index must give the same answer. Reference A matches the clause breaks on the slices,
 * the index on the whole piece: the same for the packs' breaks, whose lookarounds read one character or none across a hit's edge,
 * but not for a break that is empty, looks around across a hit's edge (`(?<=hiring)\s`, `\s(?=always)`, `(?=x)` with a hit "x")
 * or spans a hit: for those, reference B below is the documented behaviour (the breaks matched on the whole piece).
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

/**
 * Reference B, on its own: every clause break matched on the whole text (empty matches too); the clause of a hit starts at the
 * furthest end of a match at or before the hit and ends at the first start of one at or after its end; the words before, inside
 * and after the hit are those of the slices read alone.
 */
function referenceB(text: string, from: number, to: number, rules: CompiledGhostRules, reach: NegationReach): boolean {
  if (rules.negationCues.length === 0) return false;
  let clauseStart = 0;
  let clauseEnd = text.length;
  for (const re of rules.clauseBreaks) {
    for (const match of text.matchAll(re)) {
      const end = match.index + match[0].length;
      if (end <= from && end > clauseStart) clauseStart = end;
      if (match.index >= to && match.index < clauseEnd) clauseEnd = match.index;
    }
  }
  const before = reach.before === 0 ? [] : wordsOf(text.slice(clauseStart, from)).slice(-reach.before);
  const inside = wordsOf(text.slice(from, to));
  const rest = wordsOf(text.slice(to, clauseEnd));
  const after = reach.after === "clause" ? rest : rest.slice(0, reach.after);
  return [...before, ...inside, ...after].some((word) => rules.negationCues.some((cue) => cue.test(word)));
}

/** The offsets of a text that are not inside a character (the offsets every match of a `u` expression has). */
function boundaries(text: string): number[] {
  const out = [0];
  for (const char of text) out.push((out[out.length - 1] as number) + char.length);
  return out;
}

const ALL_REACHES: NegationReach[] = [...REACHES, { before: 1, after: "clause" }, { before: 20, after: "clause" }];

/** Packs of the test's own: one-letter cues and breaks inside words; empty and lookaround breaks; no breaks at all. */
const CUSTOM_PACKS: Array<[string, CompiledGhostRules]> = [
  ["breaks inside words", rulesWith(() => {}, { negation_cues: ["t", "c", "d", "no", "not", "kein\\p{L}*"], clause_breaks: ["'s", "(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"] })],
  ["empty and lookaround breaks", rulesWith(() => {}, { negation_cues: ["not", "no", "x1", "𝐀", "é", "a'b"], clause_breaks: ["(?=x)", "(?<=not)\\s", "\\s(?=a)", "(?<=no)'", "'(?=d)", "𝐁", ";"] })],
  ["no breaks", rulesWith(() => {}, { negation_cues: ["no", "not", "a", "t", "ß"] })],
];

const ATOMS = ["a", "no", "not", "t", "c", "d", "x", "x1", "7y", "kein", "keine", "é", "ß", "𝐀", "𝐀𝐁", "b", "s", "always", "hiring"];
const LINKS = ["'", "’", "''", "", " ", " ", ";", "(", " but ", "'but'", "1", "-", "\u0301", "😀", "'s"];

function atoms(next: () => number, count: number): string {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  let text = "";
  for (let i = 0; i < count; i++) text += pick(ATOMS) + pick(LINKS);
  return text;
}

describe("negatedInClause against reference B", () => {
  it.each(CUSTOM_PACKS)("gives reference B's answer for random ranges asked in any order (%s)", (_name, rules) => {
    const next = random(20261012);
    const differences: string[] = [];
    let checks = 0;
    let negatedChecks = 0;
    for (let n = 0; n < 1200; n++) {
      const text = atoms(next, 2 + Math.floor(next() * (n % 10 === 0 ? 159 : 30)));
      const cuts = boundaries(text);
      const pickCut = (): number => cuts[Math.floor(next() * cuts.length)] as number;
      const index = negationIndex(text, rules);
      // short hits and long ones (across breaks), in text order and then shuffled, on one index
      const asked: Array<[number, number, NegationReach]> = [];
      for (let k = 0; k < 12; k++) {
        const a = pickCut();
        const span = next() < 0.7 ? 1 + Math.floor(next() * 6) : Math.floor(next() * cuts.length);
        const b = cuts[Math.min(cuts.length - 1, cuts.indexOf(a) + span)] as number;
        asked.push([a, b, ALL_REACHES[Math.floor(next() * ALL_REACHES.length)] as NegationReach]);
      }
      const inOrder = [...asked].sort((x, y) => x[0] - y[0] || y[1] - x[1]);
      const shuffled = [...asked].sort(() => next() - 0.5);
      for (const [from, to, reach] of [...inOrder, ...shuffled]) {
        checks += 1;
        const expected = referenceB(text, from, to, rules, reach);
        if (expected) negatedChecks += 1;
        if (negatedInClause(index, from, to, reach) !== expected) differences.push(`${JSON.stringify(text)} ${from}-${to} ${JSON.stringify(reach)} → ${!expected}`);
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    // the ranges are a real test: many checks, negated and not
    expect(checks).toBeGreaterThan(25_000);
    expect(negatedChecks).toBeGreaterThan(checks / 5);
    expect(negatedChecks).toBeLessThan((checks * 4) / 5);
  });

  it("gives reference B's answer for the pack hits in random sentences (fixture packs)", () => {
    const rules = fixtureRules();
    const next = random(42);
    const differences: string[] = [];
    for (let n = 0; n < 1500; n++) {
      const text = sentence(next);
      const index = negationIndex(text, rules);
      for (const pattern of rules.evergreen) {
        for (const match of text.matchAll(pattern.re)) {
          if (match[0].length === 0) continue;
          const [from, to] = [match.index, match.index + match[0].length];
          for (const reach of ALL_REACHES) {
            if (negatedInClause(index, from, to, reach) !== referenceB(text, from, to, rules, reach)) differences.push(`${JSON.stringify(text)} ${from}-${to} ${JSON.stringify(reach)}`);
          }
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
  });

  it("gives reference B's answer for the hits of two nested patterns, one reading its clause and one its next words", () => {
    // "relocation" with the rest of its clause, "relocation'relocation" with its next five words, asked in text order
    const rules = rulesWith(() => {}, { negation_cues: ["no", "not"], clause_breaks: ["'s", "(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"] });
    const next = random(9);
    const units = ["relocation'", "relocation", "relocation''", " no", "'no", " but'", "'s", " ", "x'"];
    const differences: string[] = [];
    let negatedHits = 0;
    for (let n = 0; n < 400; n++) {
      let text = "";
      for (let i = 0, count = 2 + Math.floor(next() * 60); i < count; i++) text += units[Math.floor(next() * units.length)];
      const hits = [
        ...Array.from(text.matchAll(/relocation/gu), (m) => [m.index, m.index + m[0].length, { before: 6, after: "clause" }] as const),
        ...Array.from(text.matchAll(/relocation'relocation/gu), (m) => [m.index, m.index + m[0].length, { before: 6, after: 5 }] as const),
      ].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const index = negationIndex(text, rules);
      for (const [from, to, reach] of hits) {
        const expected = referenceB(text, from, to, rules, reach);
        if (expected) negatedHits += 1;
        if (negatedInClause(index, from, to, reach) !== expected) differences.push(`${JSON.stringify(text)} ${from}-${to} ${JSON.stringify(reach)}`);
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    expect(negatedHits).toBeGreaterThan(1000);
  });

  // texts where windows start and end at every offset: on and after apostrophes, next to digits, curly apostrophes, a
  // combining mark (it ends a run), a character outside the BMP, breaks inside words and on apostrophes, empty breaks
  it.each([
    ["x'y'z'not'a", 0],
    ["a''b no", 0],
    ["no' ab'", 0],
    ["a'1b'not", 0],
    ["ab'cd1ef'gh'not'x", 0],
    ["x’y’not’z", 0],
    ["x'ýnot'z no", 0],
    ["𝐀'𝐁'not'c'𝐀", 1],
    ["x'not x but'a'b'c'd", 1],
    ["not x;no'ax's'not", 1],
    ["but's'no'd'b", 0],
    ["a'b'c'd 't'c's", 0],
  ] as Array<[string, number]>)("%j: every range and reach (pack %i)", (text, pack) => {
    const rules = (CUSTOM_PACKS[pack] as [string, CompiledGhostRules])[1];
    const cuts = boundaries(text);
    const differences: string[] = [];
    const index = negationIndex(text, rules);
    for (const from of cuts) {
      for (const to of cuts) {
        if (to < from) continue;
        for (const reach of ALL_REACHES) {
          if (negatedInClause(index, from, to, reach) !== referenceB(text, from, to, rules, reach)) differences.push(`${from}-${to} ${JSON.stringify(reach)}`);
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
  });

  it.each([
    // [text, hit, reach, cues, breaks, negated]
    // the clause starts inside "but'a": the slice reads "a'b", "c'd", so the last word is "c'd", not the piece's "d"
    ["but'a'b'c'd always", "always", { before: 1, after: 0 }, ["d"], ["(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"], false],
    ["but'a'b'c'd always", "always", { before: 1, after: 0 }, ["c'd"], ["(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"], true],
    // an empty break before the hit's own text ends the clause before it: "not" is in the clause before
    ["not x", "x", { before: 6, after: 0 }, ["not"], ["(?=x)"], false],
    // the clause's end cuts the word "aaa'but" ("'but" matches the break): its part before the end is "aaa", a cue
    ["hit aaa'but", "hit", { before: 0, after: "clause" }, ["a+"], ["(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"], true],
    ["hit aaa'but", "hit", { before: 0, after: 1 }, ["a+"], ["(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"], true],
    ["hit x aaa'but", "hit", { before: 0, after: 1 }, ["a+"], ["(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"], false],
    // no cues: nothing is negated
    ["not always hiring", "always", { before: 6, after: 5 }, [], [], false],
    // zero words before or after
    ["not always no", "always", { before: 0, after: 0 }, ["not", "no"], [], false],
  ] as Array<[string, string, NegationReach, string[], string[], boolean]>)("%j around %j with %j (cues %j, breaks %j) → %s", (text, phrase, reach, cues, breaks, expected) => {
    const rules = rulesWith(() => {}, { negation_cues: cues, clause_breaks: breaks });
    const from = text.indexOf(phrase);
    const to = from + phrase.length;
    expect(negatedInClause(negationIndex(text, rules), from, to, reach)).toBe(expected);
    expect(referenceB(text, from, to, rules, reach)).toBe(expected);
  });

  it("negates every hit before a long word that the clause end cuts, and finds none in the piece", () => {
    const rules = rulesWith(() => {}, { evergreen_patterns: [{ id: "hit", pattern: "hit", check_negation: true, negation_after: "clause" }], negation_cues: ["a+"], clause_breaks: ["(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])"] });
    expect(evergreenWording(`${"hit ".repeat(50)}${"a".repeat(500)}'but`, rules)).toBeNull();
    expect(evergreenWording(`${"hit ".repeat(50)}${"a".repeat(500)}'xbut`, rules)).toMatchObject({ patternId: "hit" });
  });

  it("answers, and stops, for offsets inside a surrogate pair (outside the contract: the answer may differ from the slices')", () => {
    // astral letters after an apostrophe: a window starting inside one reads after the piece word's apostrophe
    for (const text of ["x'𝐀𝐁'not no", "a'𝐀 b'𝐁𝐀'c not", "no'𝐀'𝐁"]) {
      for (const [, rules] of CUSTOM_PACKS) {
        const index = negationIndex(text, rules);
        for (let from = 0; from <= text.length; from++) {
          for (let to = from; to <= text.length; to++) {
            for (const reach of ALL_REACHES) expect(typeof negatedInClause(index, from, to, reach)).toBe("boolean");
          }
        }
      }
    }
  });
});

describe("windowWords", () => {
  it.each(CUSTOM_PACKS)("reads every range as the slice alone (%s)", (_name, rules) => {
    const next = random(5);
    const differences: string[] = [];
    let words = 0;
    for (let n = 0; n < 1500; n++) {
      const text = atoms(next, 2 + Math.floor(next() * 40));
      const cuts = boundaries(text);
      const index = negationIndex(text, rules);
      for (let k = 0; k < 16; k++) {
        const a = cuts[Math.floor(next() * cuts.length)] as number;
        const b = cuts[Math.floor(next() * cuts.length)] as number;
        const [start, end] = a <= b ? [a, b] : [b, a];
        const expected = wordsOf(text.slice(start, end));
        words += expected.length;
        const got = windowWords(index, start, end);
        if (JSON.stringify(got) !== JSON.stringify(expected)) differences.push(`${JSON.stringify(text)} ${start}-${end}: ${JSON.stringify(got)} ≠ ${JSON.stringify(expected)}`);
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    expect(words).toBeGreaterThan(50_000);
  });
});
