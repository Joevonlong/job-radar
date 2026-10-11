// @vitest-environment node
import { describe, expect, it } from "vitest";

import { countItems } from "@/lib/breakdown/content";
import { verifyBreakdown } from "@/lib/breakdown/verify";

import { emptyOutput, JD } from "./helpers";

const STACK = "Our stack: Python, Kubernetes and AWS. Nice to have: Terraform.";

describe("verifyBreakdown (C7)", () => {
  it("keeps a verbatim quote with its offset", () => {
    const output = { ...emptyOutput(), responsibilities: [{ text: "构建检索管线", quote: "Build and operate retrieval pipelines in production." }] };
    const { content, dropped } = verifyBreakdown(output, JD);
    expect(dropped).toBe(0);
    expect(content.responsibilities[0]).toEqual({ text: "构建检索管线", quote: "Build and operate retrieval pipelines in production.", offset: JD.indexOf("Build and operate") });
  });

  it("stores the JD's own text when the model turned a line break into a space", () => {
    const output = { ...emptyOutput(), other: [{ text: "x", requirement: "must" as const, quote: "Write clear documentation. ## What you bring" }] };
    const { content, dropped } = verifyBreakdown(output, "Write clear documentation.\n## What you bring");
    expect(dropped).toBe(0);
    expect(content.other[0]?.quote).toBe("Write clear documentation.\n## What you bring");
  });

  it("drops a rewritten quote and counts it", () => {
    const output = {
      ...emptyOutput(),
      responsibilities: [
        { text: "a", quote: "Build retrieval pipelines" },
        { text: "b", quote: "Write clear documentation." },
      ],
    };
    const result = verifyBreakdown(output, JD);
    expect(result.dropped).toBe(1);
    expect(result.returned).toBe(2);
    expect(result.content.responsibilities.map((r) => r.text)).toEqual(["b"]);
  });

  it("clears the years when their quote is not in the JD, and counts it", () => {
    const output = { ...emptyOutput(), experience: { years_min: 8, years_quote: "eight years of experience", items: [] } };
    const result = verifyBreakdown(output, JD);
    expect(result.content.experience).toEqual({ years_min: null, years_quote: null, items: [] });
    expect(result.dropped).toBe(1);
    const ok = verifyBreakdown({ ...emptyOutput(), experience: { years_min: 5, years_quote: "You have 5+ years of experience in software engineering.", items: [] } }, JD);
    expect(ok.content.experience.years_min).toBe(5);
    expect(ok.content.experience.years_quote?.offset).toBe(JD.indexOf("You have 5+"));
    expect(countItems(ok.content)).toBe(1);
  });

  it("merges the same technology by skill key; must wins; merging is not a drop", () => {
    const output = {
      ...emptyOutput(),
      tech_stack: [
        { name: "Kubernetes", category: "cloud_infra" as const, requirement: "nice" as const, quote: STACK },
        { name: "kubernetes", category: "cloud_infra" as const, requirement: "must" as const, quote: STACK },
        { name: "LLMs", category: "ml_ai" as const, requirement: "must" as const, quote: STACK },
        { name: "LLM", category: "ml_ai" as const, requirement: "nice" as const, quote: STACK },
      ],
    };
    const { content, dropped } = verifyBreakdown(output, `${JD}\nLLMs`);
    expect(dropped).toBe(0);
    expect(content.tech_stack.map((t) => [t.name, t.requirement])).toEqual([["Kubernetes", "must"], ["LLMs", "must"]]);
  });

  it("an answer whose every quote is wrong has no items left", () => {
    const output = { ...emptyOutput(), responsibilities: [{ text: "a", quote: "made up" }], tech_stack: [{ name: "Go", category: "languages" as const, requirement: "must" as const, quote: "Go and Rust" }] };
    const result = verifyBreakdown(output, JD);
    expect(result.returned).toBe(2);
    expect(countItems(result.content)).toBe(0);
  });
});
