// @vitest-environment node
import { describe, expect, it } from "vitest";

import { detectVisa } from "@/lib/visa/detect";
import { visaRulesFor } from "@/lib/visa/rules";
import type { VisaStatus } from "@/lib/visa/types";

import { leastCpuTime } from "../helpers/cpu-time";
import { shippedPipeline } from "../pipeline/helpers";

/**
 * The visa check stays linear in the length of a segment with many hits: the words around each hit are read from one index of
 * the segment, and the heading of a list is read once for all its items. Reading the text before and after every hit again (and
 * the heading again for every item) took the square of the hits.
 *
 * Each shape is checked in CPU time of this thread (the least of three measurements; wall time grows several times over on a busy
 * machine) in two steps: first a bound at one size (failing there stops the case, so slow code fails in seconds instead of running
 * the larger sizes), then the growth from a quarter of that size to the size, at most 8 times the time (linear ≈ 4, quadratic ≈
 * 16). The bounds are about ten times the time measured here and a tenth of what reading with the square of the hits took.
 */
const rules = visaRulesFor(shippedPipeline());

/** A heading line of about `chars` characters ending in ":", which opens the list below it. */
const heading = (chars: number): string => `${"Things we talk about with every candidate before the first day ".repeat(Math.ceil(chars / 64)).slice(0, chars)}:\n`;

interface Shape {
  name: string;
  /** The text for a size `n`: `n` repeats (the list shape: a heading and items both growing with `n`). */
  make: (n: number) => string;
  status: VisaStatus;
  /** The size checked against `bound` (CPU milliseconds); the growth is checked from a quarter of it to it. */
  n: number;
  bound: number;
}

/** The shapes whose reading grew with the square of their size. CPU ms measured / wall seconds of the reading before the index. */
const SHAPES: Shape[] = [
  { name: "9400 hits joined by 'and'", make: (n) => "we offer relocation support and ".repeat(n), status: "offered", n: 9400, bound: 600 }, // 52 ms / 234 s
  { name: "7000 hits joined by commas", make: (n) => "we offer relocation support, ".repeat(n), status: "offered", n: 7000, bound: 400 }, // 34 ms / 141 s
  { name: "6250 hits after a dot and a lower-case word", make: (n) => "we offer relocation support. we ".repeat(n), status: "offered", n: 6250, bound: 400 }, // 34 ms / 146 s
  { name: "9400 hits joined by 'and', negated at the end", make: (n) => `${"we offer relocation support and ".repeat(n)}not available`, status: "unclear", n: 9400, bound: 600 }, // 52 ms / 215 s
  { name: "9400 German hits joined by commas", make: (n) => "wir bieten Relocation-Support, ".repeat(n), status: "offered", n: 9400, bound: 500 }, // 43 ms / 218 s
  { name: "30000 hits inside one run of words joined by apostrophes", make: (n) => "Umzugszuschuss'".repeat(n), status: "offered", n: 30_000, bound: 800 }, // 70 ms / 272 s
  { name: "12000 list items under a 210000-character heading", make: (n) => `${heading(Math.round(17.5 * n))}${"- Relocation support\n".repeat(n)}`, status: "offered", n: 12_000, bound: 800 }, // 68 ms / 446 s
  // linear before too, and no slower now: a hit after a 100000-character sentence without one (n = its characters)
  { name: "a hit after a 100000-character sentence without one", make: (n) => `${"Our team builds data tools for many customers ".repeat(Math.ceil(n / 46))}and we offer relocation support.`, status: "offered", n: 100_000, bound: 100 }, // 7 ms
];

describe("visa check timing", () => {
  it.each(SHAPES)("$name", ({ make, status, n, bound }) => {
    // the expressions' first runs (compiling) are not what is measured
    detectVisa(make(64).slice(-2000), rules);
    const text = make(n);
    const ms = leastCpuTime(() => void detectVisa(text, rules), { giveUpAbove: 3 * bound });
    expect(ms, `CPU ms at ${n}`).toBeLessThan(bound);
    expect(detectVisa(text, rules).status).toBe(status);
    const [small, large] = [n / 4, n].map((size) => {
      const sized = make(size);
      expect(detectVisa(sized, rules).status).toBe(status);
      return leastCpuTime(() => void detectVisa(sized, rules));
    }) as [number, number];
    expect(large / small, `CPU ms ${large.toFixed(1)} at ${n} / ${small.toFixed(1)} at ${n / 4}`).toBeLessThanOrEqual(8);
  });
});

describe("visa check on a segment with very many hits", () => {
  // 130000 required permits in one segment: passing them as the arguments of one call overflowed the stack
  it.each([
    ["no alternative: a refusal", "work permit required, ".repeat(130_000), "not_offered"],
    ["with an alternative: unclear", `${"work permit required, ".repeat(130_000)}or are eligible for an EU Blue Card`, "unclear"],
  ] as Array<[string, string, VisaStatus]>)("%s", (_name, description, expected) => {
    expect(detectVisa(description, rules).status).toBe(expected);
  });
});
