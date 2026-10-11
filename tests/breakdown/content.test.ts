// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { countItems, isEmptyBreakdown, parseStoredBreakdown, type BreakdownContent } from "@/lib/breakdown/content";

const content = (): BreakdownContent => ({
  responsibilities: [{ text: "a", quote: "q", offset: 0 }],
  tech_stack: [{ name: "Python", category: "languages", requirement: "must", quote: "q", offset: 0 }],
  experience: { years_min: 5, years_quote: { quote: "5+ years", offset: 3 }, items: [{ text: "x", requirement: "nice", quote: "q", offset: 0 }] },
  projects: [],
  soft_skills: [],
  languages: [],
  other: [],
});

describe("stored breakdown content", () => {
  it("parses the current version", () => {
    expect(parseStoredBreakdown(BREAKDOWN_PROMPT_VERSION, content())).toEqual(content());
  });

  it("is null for an unknown version, a missing field or an extra field", () => {
    expect(parseStoredBreakdown("breakdown-v0", content())).toBeNull();
    const { other: _other, ...missing } = content();
    void _other;
    expect(parseStoredBreakdown(BREAKDOWN_PROMPT_VERSION, missing)).toBeNull();
    expect(parseStoredBreakdown(BREAKDOWN_PROMPT_VERSION, { ...content(), extra: 1 })).toBeNull();
    expect(parseStoredBreakdown(BREAKDOWN_PROMPT_VERSION, "nope")).toBeNull();
  });

  it("counts every list, the years line included", () => {
    expect(countItems(content())).toBe(4);
    expect(isEmptyBreakdown(content())).toBe(false);
    expect(isEmptyBreakdown({ ...content(), responsibilities: [], tech_stack: [], experience: { years_min: null, years_quote: null, items: [] } })).toBe(true);
  });
});
