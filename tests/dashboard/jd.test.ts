import { describe, expect, it } from "vitest";

import { highlightQuotes, parseJd } from "@/lib/dashboard/jd";

describe("parseJd", () => {
  it("builds headings, bullet lists and paragraphs", () => {
    const blocks = parseJd("Intro line one\nstill the intro\n\n## Offer\n- first\n- second\nOutro");
    expect(blocks).toEqual([
      { type: "paragraph", segments: [{ text: "Intro line one still the intro" }] },
      { type: "heading", text: "Offer" },
      { type: "list", items: [[{ text: "first" }], [{ text: "second" }]] },
      { type: "paragraph", segments: [{ text: "Outro" }] },
    ]);
  });

  it("never produces markup: HTML in the text stays plain text", () => {
    const [block] = parseJd("<script>alert(1)</script>");
    expect(block).toEqual({ type: "paragraph", segments: [{ text: "<script>alert(1)</script>" }] });
  });

  it("handles Windows line endings and empty input", () => {
    expect(parseJd("a\r\n\r\nb")).toHaveLength(2);
    expect(parseJd("")).toEqual([]);
  });

  it("highlights signal quotes inside list items", () => {
    const [list] = parseJd("- Salary: 85k per year, fair.", ["85k per year"]);
    expect(list).toEqual({
      type: "list",
      items: [[{ text: "Salary: " }, { text: "85k per year", quote: 0 }, { text: ", fair." }]],
    });
  });
});

describe("highlightQuotes", () => {
  it("skips quotes that are not in the line and overlapping ones", () => {
    expect(highlightQuotes("hello world", ["nope"])).toEqual([{ text: "hello world" }]);
    const segments = highlightQuotes("hello world", ["hello wor", "world"]);
    expect(segments.filter((s) => s.quote !== undefined)).toHaveLength(1);
  });
});

describe("Markdown from real descriptions", () => {
  it("handles deep headings, bold, links, escapes and numbered / star lists", () => {
    const blocks = parseJd("### 💼 IHRE AUFGABEN\n\nEin **Senior-Job** mit [Link](https://x.example) und Referenz 2026\\_E.\n\n* eins\n1. zwei");
    expect(blocks[0]).toEqual({ type: "heading", text: "💼 IHRE AUFGABEN" });
    expect(blocks[1]).toEqual({
      type: "paragraph",
      segments: [{ text: "Ein " }, { text: "Senior-Job", bold: true }, { text: " mit Link und Referenz 2026_E." }],
    });
    expect(blocks[2]).toEqual({ type: "list", items: [[{ text: "eins" }], [{ text: "zwei" }]] });
  });

  it("keeps highlighting inside bold text and never emits markup", () => {
    const [block] = parseJd("Gehalt **85k pro Jahr** <b>x</b>", ["85k pro Jahr"]);
    expect(block).toEqual({
      type: "paragraph",
      segments: [{ text: "Gehalt " }, { text: "85k pro Jahr", bold: true, quote: 0 }, { text: " <b>x</b>" }],
    });
  });

  it("drops a leftover ** instead of showing it", () => {
    const [block] = parseJd("**Was Sie erwartet: Aufgaben und ** mehr, ** x **");
    const text = block?.type === "paragraph" ? block.segments.map((s) => s.text).join("") : "";
    expect(text).not.toContain("**");
    expect(text).toContain("Was Sie erwartet");
  });
});
