// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evergreenWording, thinDescription } from "@/lib/ghost/signals";

import { leastCpuTime } from "../helpers/cpu-time";
import { fixtureRules, input } from "./helpers";

/**
 * The packs' expressions and the ghost check stay linear on long runs of blank lines or spaces (input the ingestion normally
 * collapses, but nothing guarantees it). The bounds are far above the expected few milliseconds and far below a backtracking blow-up
 * (seconds). Times are this thread's CPU time, the least of three runs: a busy machine stretches wall time several times over.
 */
const elapsed = (work: () => void): number => leastCpuTime(work, { atLeast: 0 });

describe("ghost check timing", () => {
  const rules = fixtureRules();
  const expressions: Array<[string, RegExp]> = [
    ...rules.evergreen.flatMap((pattern, i): Array<[string, RegExp]> => [[`evergreen[${i}]`, pattern.re], ...pattern.requiresContext.map((re, j): [string, RegExp] => [`evergreen[${i}].requires_context[${j}]`, re])]),
    ...rules.excludeContext.map((re, i): [string, RegExp] => [`exclude_context[${i}]`, re]),
    ...rules.excludeClause.map((re, i): [string, RegExp] => [`exclude_clause[${i}]`, re]),
    ...rules.excludeClauseEnds.map((re, i): [string, RegExp] => [`exclude_clause_ends[${i}]`, re]),
    ...rules.clauseBreaks.map((re, i): [string, RegExp] => [`clause_breaks[${i}]`, re]),
    ...rules.questionTag.breaks.map((re, i): [string, RegExp] => [`question_tag.breaks[${i}]`, re]),
  ];

  it("every pack expression on 3000 blank lines", () => {
    const text = `${"\n".repeat(3000)}x`;
    const slow = expressions.filter(([, re]) => elapsed(() => void [...text.matchAll(new RegExp(re.source, "giu"))]) > 100).map(([path]) => path);
    expect(slow).toEqual([]);
  });

  it("a piece with 3000 blank lines in it", () => {
    let found: ReturnType<typeof evergreenWording> = null;
    const ms = elapsed(() => void (found = evergreenWording(`Bewirb dich für unseren KI-Talentpool${"\n".repeat(3000)}x`, rules)));
    expect(ms).toBeLessThan(500);
    expect(found).toMatchObject({ patternId: "talent_pool_join" });
  });

  it("an only_before_duties hit with a long line before the duties heading", () => {
    let found: ReturnType<typeof evergreenWording> = null;
    const ms = elapsed(() => void (found = evergreenWording(`Initiativbewerbung\nÜber uns${" ".repeat(3000)}x\n\nDeine Aufgaben\n- Code Reviews`, rules)));
    expect(ms).toBeLessThan(500);
    expect(found).toMatchObject({ patternId: "open_application_title", offset: 0 });
  });

  // Each bound is ten times the time measured under load and a tenth of the time of a reading with the square of the hits (noted
  // per case); the time from n hits to 4n grows at most 8 times (linear ≈ 4, quadratic ≈ 16).
  it.each([
    // the clause of every hit read in log time (~85 ms; finding the clause marks again for every hit: ~50 s)
    ["hits in comma clauses before a tagged invitation", (n: number) => `${"always hiring, ".repeat(n)}always hiring – interested?`, 900],
    // the end of every qualification's clause searched forward once (~30 ms; searching the rest of the piece again from every
    // qualification: ~11 s)
    ["qualifications before a hit", (n: number) => `${"Experience building teams ".repeat(n)}for future roles.`, 400],
  ])("a piece with 8000 %s (every hit left out)", (_name, description, bound) => {
    // the expressions' first runs (compiling) are not what is measured: the time must not grow with the square of the hits
    evergreenWording(description(500), rules);
    let found: ReturnType<typeof evergreenWording> = null;
    const ms = leastCpuTime(() => void (found = evergreenWording(description(8000), rules)), { atLeast: 0, giveUpAbove: 3 * bound });
    expect(ms).toBeLessThan(bound);
    expect(found).toBeNull();
    const [small, large] = [2000, 8000].map((n) => {
      const text = description(n);
      return leastCpuTime(() => void evergreenWording(text, rules));
    }) as [number, number];
    expect(large / small, `${large.toFixed(1)} ms at 8000 / ${small.toFixed(1)} ms at 2000`).toBeLessThanOrEqual(8);
  });

  // Each bound is about ten times the time measured here and the input is large enough that reading it with the square of its
  // hits took seconds (noted per case), so a busy machine does not fail them and a quadratic reading still does.
  it.each([
    // the clause of every hit opens with the same long run of markers, or of signs, before a tagged invitation (~80 ms; was ~9 s)
    ["3570 hits after 12500 markers before a tagged invitation", `${"and ".repeat(12500)}${"always hiring ".repeat(3570)}– interested?`, 1000],
    // (~130 ms; was ~9 s)
    ["5355 hits after 75000 signs before a tagged invitation", `${"~".repeat(75000)}${" always hiring".repeat(5355)} – interested?`, 1500],
    // every hit negated, in one clause with no break (~15 ms; was ~5 s)
    ["4000 negated hits in one clause", "not always hiring ".repeat(4000), 200],
    // the clause starts inside a long word joined by apostrophes: its rest is read once, not again for every hit (~40 ms;
    // was ~8 s)
    ["5552 negated hits after a clause break cutting a 100000-character word", `but${"'a".repeat(50000)}${" not always hiring".repeat(5552)}`, 500],
    // each list item looks for its list's heading above it: the lines of one list are read once, not once per item below them
    // (~50 ms; was ~5 s)
    ["2000 negated list items after 60000 others", `${"- x\n".repeat(60000)}${"- not always hiring\n".repeat(2000)}`, 600],
    // (~30 ms; was ~4 s)
    ["2000 hits under a question heading after 32000 items and blank lines", `What will you be doing?\n${"- x\n\n".repeat(32000)}${"- no open job\n".repeat(2000)}`, 400],
    // a broad phrase with no recruiting words next to it: the piece is searched for them once, not once per hit (~20 ms;
    // was ~5 s)
    ["8333 broad phrases with no recruiting words", "join our AI talent pool ".repeat(8333), 300],
    ["7692 German broad phrases with no recruiting words", "für unseren KI-Talentpool ".repeat(7692), 300],
  ])("a piece with %s (every hit left out)", (_name, description, bound) => {
    evergreenWording(description.slice(-2000), rules);
    let found: ReturnType<typeof evergreenWording> = null;
    const ms = elapsed(() => void (found = evergreenWording(description, rules)));
    expect(ms).toBeLessThan(bound);
    expect(found).toBeNull();
  });

  it.each([
    // (~15 ms; was ~2 s)
    ["clauses", `${"not always hiring; ".repeat(4000)}we are always hiring.`],
    // (~15 ms; was ~6 s)
    ["one clause joined by 'and'", `${"not always hiring and ".repeat(4000)}we are always hiring.`],
  ])("4000 negated hits before a last one that counts, in %s", (_name, description) => {
    evergreenWording(description.slice(-2000), rules);
    let found: ReturnType<typeof evergreenWording> = null;
    const ms = elapsed(() => void (found = evergreenWording(description, rules)));
    expect(ms).toBeLessThan(200);
    expect(found).toMatchObject({ patternId: "always_hiring", quote: expect.stringContaining("we are always hiring.") });
  });

  it.each([
    ["5000 spaces inside a line", `a${" ".repeat(5000)}b\nc`],
    ["5000 em spaces inside a line", `a${" ".repeat(5000)}b\nc`],
    ["spaces left by dropped emphasis marks", `a${" _".repeat(2000)}b\nc`],
    ["5000 spaces before a final pause, dots or question mark", ["a", "b …", "c ...", "What d ?"].map((line) => line.replace(" ", " ".repeat(5000))).join("\n")],
  ])("reading headings in a description with %s", (_name, description) => {
    const ms = elapsed(() => void thinDescription(input({ description }), rules));
    expect(ms).toBeLessThan(100);
  });
});
