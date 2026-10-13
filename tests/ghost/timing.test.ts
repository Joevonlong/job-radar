// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evergreenWording, thinDescription } from "@/lib/ghost/signals";

import { fixtureRules, input } from "./helpers";

/**
 * The packs' expressions and the ghost check stay linear on long runs of blank lines or spaces (input the ingestion normally
 * collapses, but nothing guarantees it). The bounds are far above the expected few milliseconds and far below a backtracking blow-up
 * (seconds).
 */
const elapsed = (work: () => void): number => {
  const started = performance.now();
  work();
  return performance.now() - started;
};

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

  it.each([
    ["4000 hits in comma clauses before a tagged invitation", `${"always hiring, ".repeat(4000)}always hiring – interested?`],
    ["4000 qualifications before a hit", `${"Experience building teams ".repeat(4000)}for future roles.`],
    // the clause of every hit opens with the same long run of markers, or of signs, before a tagged invitation
    ["1785 hits after 6250 markers before a tagged invitation", `${"and ".repeat(6250)}${"always hiring ".repeat(1785)}– interested?`],
    ["1785 hits after 25000 signs before a tagged invitation", `${"~".repeat(25000)}${" always hiring".repeat(1785)} – interested?`],
    // every hit negated, in one clause with no break
    ["4000 negated hits in one clause", "not always hiring ".repeat(4000)],
  ])("a piece with %s (every hit left out)", (_name, description) => {
    // the expressions' first runs (compiling) are not what is measured: the time must not grow with the square of the hits
    evergreenWording(description.slice(-2000), rules);
    let found: ReturnType<typeof evergreenWording> = null;
    const ms = elapsed(() => void (found = evergreenWording(description, rules)));
    expect(ms).toBeLessThan(100);
    expect(found).toBeNull();
  });

  it.each([
    ["clauses", `${"not always hiring; ".repeat(4000)}we are always hiring.`],
    ["one clause joined by 'and'", `${"not always hiring and ".repeat(4000)}we are always hiring.`],
  ])("4000 negated hits before a last one that counts, in %s", (_name, description) => {
    evergreenWording(description.slice(-2000), rules);
    let found: ReturnType<typeof evergreenWording> = null;
    const ms = elapsed(() => void (found = evergreenWording(description, rules)));
    expect(ms).toBeLessThan(100);
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
