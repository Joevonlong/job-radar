// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evergreenWording } from "@/lib/ghost/signals";

import { fixtureRules } from "./helpers";

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
});
