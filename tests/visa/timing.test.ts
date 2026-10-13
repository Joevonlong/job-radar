// @vitest-environment node
import { describe, expect, it } from "vitest";

import { detectVisa } from "@/lib/visa/detect";
import { visaRulesFor } from "@/lib/visa/rules";
import type { VisaStatus } from "@/lib/visa/types";

import { shippedPipeline } from "../pipeline/helpers";

/**
 * The visa check stays linear in the length of a segment with many hits: the words around each hit are read from one index of
 * the segment, and the heading of a list is read once for all its items. Reading the text before and after every hit again (and
 * the heading again for every item) took the square of the hits.
 */
const rules = visaRulesFor(shippedPipeline());

const elapsed = (work: () => void): number => {
  const started = performance.now();
  work();
  return performance.now() - started;
};

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

/** A heading line of about `chars` characters ending in ":", which opens the list below it. */
const heading = (chars: number): string => `${"Things we talk about with every candidate before the first day ".repeat(Math.ceil(chars / 64)).slice(0, chars)}:\n`;

/** The shapes whose reading grew with the square of their size: `n` repeats (P4: a heading and items both growing with `n`). */
const SHAPES: Record<string, { make: (n: number) => string; status: VisaStatus }> = {
  "hits joined by 'and'": { make: (n) => "we offer relocation support and ".repeat(n), status: "offered" },
  "hits joined by commas": { make: (n) => "we offer relocation support, ".repeat(n), status: "offered" },
  "hits after a dot and a lower-case word": { make: (n) => "we offer relocation support. we ".repeat(n), status: "offered" },
  "hits joined by 'and', negated at the end": { make: (n) => `${"we offer relocation support and ".repeat(n)}not available`, status: "unclear" },
  "German hits joined by commas": { make: (n) => "wir bieten Relocation-Support, ".repeat(n), status: "offered" },
  "hits inside one run of words joined by apostrophes": { make: (n) => "Umzugszuschuss'".repeat(n), status: "offered" },
  "list items under one long heading": { make: (n) => `${heading(Math.round(17.5 * n))}${"- Relocation support\n".repeat(n)}`, status: "offered" },
};
const shape = (name: string, n: number): string => (SHAPES[name] as { make: (n: number) => string }).make(n);

describe("visa check timing", () => {
  // Each bound is ten times the slowest of fifteen runs measured while the whole unit suite ran in parallel on the same machine
  // (rounded up to 100 ms), and the reading before the index took more than ten times the bound on the same input under a similar
  // load (a load average near 170 on ten cores). Noted per case: slowest new run / old run.
  it.each([
    ["9400 hits joined by 'and'", shape("hits joined by 'and'", 9400), 4500, "offered"], // 445 ms / 234 s
    ["7000 hits joined by commas", shape("hits joined by commas", 7000), 3800, "offered"], // 378 ms / 141 s
    ["6250 hits after a dot and a lower-case word", shape("hits after a dot and a lower-case word", 6250), 3800, "offered"], // 378 ms / 146 s
    ["9400 hits joined by 'and', negated at the end", shape("hits joined by 'and', negated at the end", 9400), 4500, "unclear"], // 446 ms / 215 s
    ["9400 German hits joined by commas", shape("German hits joined by commas", 9400), 3100, "offered"], // 302 ms / 218 s
    ["30000 hits inside one run of words joined by apostrophes", shape("hits inside one run of words joined by apostrophes", 30000), 7500, "offered"], // 747 ms / 272 s
    ["12000 list items under a 210000-character heading", `${heading(210_000)}${"- Relocation support\n".repeat(12000)}`, 5500, "offered"], // 547 ms / 446 s
  ] as Array<[string, string, number, VisaStatus]>)("%s", (_name, description, bound, expected) => {
    // the expressions' first runs (compiling) are not what is measured
    detectVisa(description.slice(-2000), rules);
    let status: VisaStatus = "not_mentioned";
    const ms = elapsed(() => void (status = detectVisa(description, rules).status));
    expect(ms).toBeLessThan(bound);
    expect(status).toBe(expected);
  });

  // linear before too: the bound is ten times the slowest new run with the unit suite alongside (229 ms); measured side by side
  // under another load, the old reading took up to 83 ms and the new one up to 57 ms
  it("a hit after a 100000-character sentence without one (linear before, and no slower now)", () => {
    const description = `${"Our team builds data tools for many customers ".repeat(Math.ceil(100_000 / 46))}and we offer relocation support.`;
    detectVisa(description.slice(-2000), rules);
    let status: VisaStatus = "not_mentioned";
    const ms = elapsed(() => void (status = detectVisa(description, rules).status));
    expect(ms).toBeLessThan(2300);
    expect(status).toBe("offered");
  });

  // Four times the input takes about four times as long when the reading is linear (sixteen times when it is quadratic). The
  // smaller input is doubled until each of its runs takes 20 ms, so the ratio is not timer noise; medians of three runs, taken in
  // turns with the larger input.
  it.each(Object.keys(SHAPES))("%s: four times the input, at most eight times the time", (name) => {
    const { make, status } = SHAPES[name] as { make: (n: number) => string; status: VisaStatus };
    const run = (text: string): number => {
      let result: VisaStatus = "not_mentioned";
      const ms = elapsed(() => void (result = detectVisa(text, rules).status));
      expect(result).toBe(status);
      return ms;
    };
    detectVisa(make(64).slice(-2000), rules);
    let n = 500;
    let small = make(n);
    let smalls = [run(small), run(small), run(small)];
    while (Math.min(...smalls) < 20 && small.length < 1_000_000) {
      n *= 2;
      small = make(n);
      smalls = [run(small), run(small), run(small)];
    }
    expect(Math.min(...smalls)).toBeGreaterThanOrEqual(20);
    const large = make(4 * n);
    const larges: number[] = [];
    for (let i = 0; i < 3; i++) {
      larges.push(run(large));
      smalls.push(run(small));
    }
    expect(median(larges) / median(smalls)).toBeLessThanOrEqual(8);
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
