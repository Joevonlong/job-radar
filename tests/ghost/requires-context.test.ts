// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evergreenWording } from "@/lib/ghost/signals";
import type { CompiledGhostRules } from "@/lib/ghost/rules";

import { rulesWith } from "./helpers";

/** A context expression that records the text of every search made with it. */
class Counted extends RegExp {
  readonly searched: string[] = [];
  override [Symbol.search](text: string): number {
    this.searched.push(text);
    return super[Symbol.search](text);
  }
}

const pool = { id: "pool", pattern: "talent pool", check_negation: true };
const pack = { evergreen_patterns: [{ ...pool, requires_context: ["apply"] }], negation_cues: ["not"] };

/** The rules with each `requires_context` expression replaced by a counted copy of it. */
function counted(rules: CompiledGhostRules): { rules: CompiledGhostRules; searched: () => string[] } {
  const all: Counted[] = [];
  const evergreen = rules.evergreen.map((pattern) => ({
    ...pattern,
    requiresContext: pattern.requiresContext.map((re) => {
      const copy = new Counted(re.source, re.flags);
      all.push(copy);
      return copy;
    }),
  }));
  return { rules: { ...rules, evergreen }, searched: () => all.flatMap((re) => re.searched) };
}

describe("evergreen requires_context", () => {
  it("a piece is searched for a pattern's context once, however many hits it has", () => {
    const { rules, searched } = counted(rulesWith(() => {}, pack));
    const description = "talent pool ".repeat(1000);
    expect(evergreenWording(description, rules)).toBeNull();
    expect(searched()).toEqual([description.trim()]);
  });

  it("each piece is searched once for each pattern", () => {
    const two = { ...pack, evergreen_patterns: [...pack.evergreen_patterns, { ...pool, id: "pools", pattern: "talent pools?", requires_context: ["apply"] }] };
    const { rules, searched } = counted(rulesWith(() => {}, two));
    const first = "A talent pool, a talent pool and a talent pool.";
    const second = "Our talent pools are talent pools.";
    expect(evergreenWording(`${first} ${second}`, rules)).toBeNull();
    expect(searched().sort()).toEqual([first, first, second, second]);
  });

  it("the context of one piece does not count for another", () => {
    const rules = rulesWith(() => {}, pack);
    // the recruiting word is in the next sentence only
    expect(evergreenWording("Join our talent pool. Apply now.", rules)).toBeNull();
    // the first piece has no context, the second has: the second counts
    const description = "Join our talent pool. Our talent pool is where you apply.";
    expect(evergreenWording(description, rules)).toMatchObject({ patternId: "pool", quote: "Our talent pool is where you apply.", offset: description.indexOf("Our") });
    // the first piece has context but its hit is hidden: the second piece, without context, does not count
    const hidden = "Apply to our talent pool. Our talent pool grows.";
    expect(evergreenWording(hidden, rules, { skip: (start) => start < hidden.indexOf(".") })).toBeNull();
    expect(evergreenWording(hidden, rules)).toMatchObject({ quote: "Apply to our talent pool.", offset: 0 });
  });

  it("two patterns with the same id and different context are each read with their own", () => {
    const rules = rulesWith(() => {}, pack);
    const apply = rules.evergreen[0];
    if (apply === undefined) throw new Error("no pattern");
    const candidates = { ...apply, requiresContext: [/candidates/iu] };
    const description = "Our talent pool takes candidates.";
    expect(evergreenWording(description, { ...rules, evergreen: [apply] })).toBeNull();
    expect(evergreenWording(description, { ...rules, evergreen: [apply, candidates] })).toMatchObject({ patternId: "pool", quote: description, offset: 0 });
  });

  it("any one of the context expressions is enough, and an empty list needs none", () => {
    const either = rulesWith(() => {}, { ...pack, evergreen_patterns: [{ ...pool, requires_context: ["apply", "candidates"] }] });
    expect(evergreenWording("Our talent pool takes candidates.", either)).toMatchObject({ patternId: "pool" });
    expect(evergreenWording("Our talent pool takes apply forms.", either)).toMatchObject({ patternId: "pool" });
    expect(evergreenWording("Our talent pool grows.", either)).toBeNull();
    for (const requires_context of [[], undefined]) {
      const none = rulesWith(() => {}, { ...pack, evergreen_patterns: [{ ...pool, ...(requires_context ? { requires_context } : {}) }] });
      expect(none.evergreen[0]?.requiresContext).toEqual([]);
      expect(evergreenWording("Our talent pool grows.", none)).toMatchObject({ patternId: "pool", quote: "Our talent pool grows.", offset: 0 });
    }
  });

  it("hidden hits are passed over and the quote is the piece at its offset", () => {
    const rules = rulesWith(() => {}, pack);
    const description = "About us\nWe ship software.\n\nApply to our talent pool. Then apply again to our talent pool. Or apply to our talent pool.";
    const second = "Then apply again to our talent pool.";
    const third = "Or apply to our talent pool.";
    const points = rules.settings.evergreen_wording.points;
    expect(evergreenWording(description, rules, { skip: (start) => start < description.indexOf(second) })).toEqual({ code: "evergreen_wording", points, patternId: "pool", quote: second, offset: description.indexOf(second) });
    expect(evergreenWording(description, rules, { skip: (start) => start < description.indexOf(third) })).toEqual({ code: "evergreen_wording", points, patternId: "pool", quote: third, offset: description.indexOf(third) });
    expect(evergreenWording(description, rules, { skip: () => true })).toBeNull();
  });
});
