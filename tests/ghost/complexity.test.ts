// @vitest-environment node
import v8 from "node:v8";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { negatedInClause, negationIndex, type NegationReach } from "@/lib/ghost/negation";
import type { CompiledGhostRules } from "@/lib/ghost/rules";
import { evergreenWording } from "@/lib/ghost/signals";
import type { GhostPack } from "@/lib/market/schema";

import { leastCpuTime } from "../helpers/cpu-time";
import { fixtureRules, rulesWith } from "./helpers";

/**
 * The ghost check stays linear in the length of a JD on shapes that a pattern without word boundaries, a long run of words joined
 * by apostrophes or a very long list heading make possible. Each shape is checked in two steps, in CPU time (least of three
 * measurements): first a bound at one size (failing there stops the case, so slow code fails in seconds instead of running the
 * larger sizes), then the growth from a size to four times it, at most 8 (linear ≈ 4, quadratic ≈ 16). Every size grows each
 * dimension the cost depends on (hits, run length, heading length, …). The bounds are ten times the time measured under load
 * and a tenth of what reading with the square of the size took.
 */

interface Shape<Size> {
  name: string;
  /** The input for a size, built outside the measurement: the work and its expected result. */
  at: (size: Size) => () => unknown;
  /** The result at a size. */
  expected: (size: Size) => unknown;
  /** The size checked against `bound` (CPU milliseconds). */
  size: Size;
  bound: number;
  /** A size and four times it. */
  growth: [Size, Size];
}

function expectLinear<Size>(shape: Shape<Size>): void {
  // compile the expressions before measuring
  shape.at(shape.growth[0])();
  const work = shape.at(shape.size);
  const ms = leastCpuTime(() => void work(), { giveUpAbove: 3 * shape.bound });
  expect(ms, `${shape.name}: CPU ms at ${JSON.stringify(shape.size)}`).toBeLessThan(shape.bound);
  expect(work()).toEqual(shape.expected(shape.size));
  const [small, large] = shape.growth.map((size) => {
    const run = shape.at(size);
    return leastCpuTime(() => void run());
  }) as [number, number];
  expect(large / small, `${shape.name}: CPU ms ${large.toFixed(1)} at ${JSON.stringify(shape.growth[1])} / ${small.toFixed(1)} at ${JSON.stringify(shape.growth[0])}`).toBeLessThanOrEqual(8);
}

const BUT = "(?<![\\p{L}\\p{N}])but(?![\\p{L}\\p{N}])";

/** A pack of one evergreen pattern (no word boundaries), with `no` and `not` as negation cues and "but" ending a clause. */
const onePattern = (pattern: string, negationAfter: "words" | "clause", pack: Partial<GhostPack> = {}, before = 6): CompiledGhostRules =>
  rulesWith(
    (settings) => {
      settings.negation_words_before = before;
    },
    { evergreen_patterns: [{ id: "custom", pattern, check_negation: true, negation_after: negationAfter }], negation_cues: ["no", "not"], clause_breaks: [BUT], ...pack },
  );

const ghost = (description: string, rules: CompiledGhostRules) => () => evergreenWording(description, rules);

describe("ghost negation complexity", () => {
  const relocation = onePattern("relocation", "clause");

  it.each<Shape<number>>([
    // every second hit ends inside a word joined to the next one: the rest of the run reads differently from there, to the "no"
    // at the end of the clause
    { name: "hits in a run of apostrophes, a cue after it", at: (n) => ghost(`${"relocation'".repeat(n)} no`, relocation), expected: () => null, size: 10_000, bound: 250, growth: [2000, 8000] },
    // the same, with the clause ending inside the run ("'no''but'x" joined to it)
    { name: "hits in a run of apostrophes that a clause break cuts", at: (n) => ghost(`${"relocation'".repeat(n)}'no''but'x`, relocation), expected: () => null, size: 16_000, bound: 300, growth: [2000, 8000] },
    // a window of words after each hit, every hit cutting a word of the run
    { name: "hits cutting the words of a run, words after them", at: (n) => ghost("evergreen'not''".repeat(n), onePattern("evergreen", "words")), expected: () => null, size: 4000, bound: 120, growth: [1000, 4000] },
    // the clause starts inside the run ("but'"), every hit inside it: 20 words before each hit
    { name: "hits in a run that the clause start cuts, 20 words before them", at: (n) => ghost(`but'${"no'".repeat(n)}`, onePattern("no", "clause", {}, 20)), expected: () => null, size: 8000, bound: 120, growth: [2000, 8000] },
  ])("$name", (shape) => expectLinear(shape));

  it("hits before a long word that the clause end cuts (the word read once, not once per hit)", () => {
    // the break's lookbehind does not exclude apostrophes: the clause ends inside the word "aaa…'but", whose cut part is a cue
    const rules = onePattern("hit", "clause", { negation_cues: ["a+"] });
    expectLinear<[number, number]>({
      name: "hits before a cut long word",
      at: ([hits, length]) => ghost(`${"hit ".repeat(hits)}${"a".repeat(length)}'but`, rules),
      expected: () => null,
      size: [4000, 200_000],
      bound: 60,
      growth: [
        [500, 50_000],
        [2000, 200_000],
      ],
    });
  });

  it("hits of two nested patterns, one reading its clause and one its next words, asked in text order", () => {
    const rules = relocation;
    const reaches: NegationReach[] = [
      { before: 6, after: "clause" },
      { before: 6, after: 5 },
    ];
    expectLinear<number>({
      name: "nested clause and words hits",
      at: (n) => {
        const text = `${"relocation'".repeat(n)} no`;
        const hits = [/relocation/gu, /relocation'relocation/gu]
          .flatMap((re, pattern) => Array.from(text.matchAll(re), (m) => ({ from: m.index, to: m.index + m[0].length, pattern })))
          .sort((a, b) => a.from - b.from || b.to - a.to);
        return () => {
          const index = negationIndex(text, rules);
          return hits.filter((hit) => negatedInClause(index, hit.from, hit.to, reaches[hit.pattern] as NegationReach)).length;
        };
      },
      // every hit of the first pattern; of the second (one per two words of the run), the five before the "no"
      expected: (n) => n + 5,
      size: 10_000,
      bound: 250,
      growth: [2000, 8000],
    });
  });
});

describe("ghost negation memory", () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;

  /** The heap the negation tests of all hits of `re` in `text` leave behind while their index is still held. */
  function heapGrowth(text: string, re: RegExp, rules: CompiledGhostRules, reach: NegationReach): number {
    const index = negationIndex(text, rules);
    const hits = Array.from(text.matchAll(re), (m) => [m.index, m.index + m[0].length] as const);
    gc();
    const before = process.memoryUsage().heapUsed;
    let negated = 0;
    for (const [from, to] of hits) if (negatedInClause(index, from, to, reach)) negated += 1;
    gc();
    const grown = process.memoryUsage().heapUsed - before;
    expect(negated).toBe(hits.length);
    expect(index.text).toBe(text);
    return grown / 2 ** 20;
  }

  it.each([
    // [name, text at a size, pattern, reach, size, growth sizes]
    ["the rest of the clause after hits cutting a run", (n: number) => `${"relocation'".repeat(n)} no`, /relocation/gu, { before: 6, after: "clause" }, 4000, [1000, 4000]],
    ["the words after hits cutting a run", (n: number) => "evergreen'not''".repeat(n), /evergreen/gu, { before: 6, after: 5 }, 2000, [500, 2000]],
  ] as Array<[string, (n: number) => string, RegExp, NegationReach, number, [number, number]]>)("%s keeps nothing per hit", (name, text, re, reach, size, [small, large]) => {
    const rules = onePattern("x", reach.after === "clause" ? "clause" : "words");
    const megabytes = heapGrowth(text(size), re, rules, reach);
    expect(megabytes, `${name}: MB at ${size}`).toBeLessThanOrEqual(8);
    const grown = [small, large].map((n) => heapGrowth(text(n), re, rules, reach)) as [number, number];
    expect(grown[1], `${name}: MB ${grown[1].toFixed(1)} at ${large}, ${grown[0].toFixed(1)} at ${small}`).toBeLessThanOrEqual(6 * Math.max(grown[0], 4));
  });
});

describe("list heading complexity", () => {
  const rules = fixtureRules();
  // the duties check runs whether or not a pattern checks negation
  const unchecked: CompiledGhostRules = { ...rules, evergreen: rules.evergreen.map((pattern) => ({ ...pattern, checkNegation: false })) };
  const filler = (length: number): string => "lorem ipsum dolor sit amet ".repeat(Math.ceil(length / 27)).slice(0, length);
  const list = (heading: string, item: string, items: number): string => `${heading}\n${`- ${item}\n`.repeat(items)}`;

  it.each<Shape<[number, number]>>([
    // a long heading without a cue above negated items: each item checks its heading for a cue, and whether it is a duties heading
    { name: "a long heading above negated items", at: ([length, items]) => ghost(list(`${filler(length)}:`, "not always hiring", items), rules), expected: () => null, size: [70_000, 1000], bound: 300, growth: [[6000, 350], [24_000, 1400]] },
    // a long heading ending in a cue negates every item below it
    { name: "a long negated heading above items", at: ([length, items]) => ghost(list(`${filler(length)} not:`, "We are always hiring", items), rules), expected: () => null, size: [70_000, 1000], bound: 300, growth: [[6000, 350], [24_000, 1400]] },
    // the items under a long duties heading do not count
    { name: "a long duties heading above items", at: ([length, items]) => ghost(list(`${filler(length)} your responsibilities:`, "We are always hiring", items), unchecked), expected: () => null, size: [200_000, 2000], bound: 300, growth: [[8000, 500], [32_000, 2000]] },
  ])("$name", (shape) => expectLinear(shape));
});
