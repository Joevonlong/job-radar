// @vitest-environment node
import { describe, expect, it } from "vitest";

import { markedSentencesFor, normalizeMarkers, stripMarkers } from "@/lib/translation/markers";
import { parseTranslation } from "@/lib/translation/render";

describe("markedSentencesFor", () => {
  const chunk = "Intro line.\n\nWe pay a base salary of EUR 90,000 per year.\n\n- 30 days of vacation\n- JobRad";
  it("returns the signal quotes found verbatim in the piece, in order of appearance, once each", () => {
    const marked = markedSentencesFor(chunk, [
      { tier: "T4", quote: "JobRad" },
      { tier: "tag", quote: "30 days of vacation" },
      { tier: "T1", quote: "base salary of EUR 90,000 per year" },
      { tier: "T2", quote: "not in this piece" },
      { tier: "T1", quote: "JobRad" },
    ]);
    expect(marked).toEqual([
      { tier: "T1", text: "base salary of EUR 90,000 per year" },
      { tier: "tag", text: "30 days of vacation" },
      { tier: "T4", text: "JobRad" },
    ]);
  });

  it("skips empty and overlong quotes (a quote that is the whole short piece is fine)", () => {
    expect(markedSentencesFor(chunk, [{ tier: "T1", quote: "  " }, { tier: "T1", quote: `${"x".repeat(301)}` }, { tier: "T1", quote: chunk }])).toEqual([{ tier: "T1", text: chunk }]);
    const long = `${"word ".repeat(80)}end`;
    expect(markedSentencesFor(long, [{ tier: "T1", quote: long }])).toEqual([]);
  });
});

describe("normalizeMarkers", () => {
  const marked = [
    { tier: "T1" as const, text: "a" },
    { tier: "tag" as const, text: "b" },
  ];

  it("turns the model's sentence markers into tier markers", () => {
    expect(normalizeMarkers("基本年薪 [[S1]]9 万欧元[[/S1]]。\n- [[S2]]30 天假期[[/S2]]", marked)).toBe("基本年薪 [[T1]]9 万欧元[[/T1]]。\n- [[tag]]30 天假期[[/tag]]");
  });

  it("drops unknown markers, unclosed pairs, stray closes and nested pairs but keeps the text", () => {
    expect(normalizeMarkers("[[S9]]x[[/S9]]", marked)).toBe("x");
    expect(normalizeMarkers("[[S1]]一行没关\n下一行[[/S1]]", marked)).toBe("一行没关\n下一行");
    expect(normalizeMarkers("a[[/S1]]b", marked)).toBe("ab");
    expect(normalizeMarkers("[[S1]]外[[S2]]内[[/S2]]外[[/S1]]", marked)).toBe("[[T1]]外内外[[/T1]]");
  });

  it("leaves text without markers alone and stripMarkers removes stored markers", () => {
    expect(normalizeMarkers("普通 [括号] 文本", marked)).toBe("普通 [括号] 文本");
    expect(stripMarkers("a[[T1]]b[[/T1]]c")).toBe("abc");
    expect(stripMarkers("a[[remote-budget]]b[[/remote-budget]]c")).toBe("abc");
  });

  it("stores the category id of any category", () => {
    expect(normalizeMarkers("[[S1]]提供签证担保[[/S1]]", [{ tier: "visa_2", text: "Visa sponsorship" }])).toBe("[[visa_2]]提供签证担保[[/visa_2]]");
  });
});

/** The active categories the page passes: ids and colours. */
const ACTIVE = [
  { id: "T1", color: "amber" },
  { id: "T2", color: "teal" },
  { id: "visa", color: "violet" },
] as const;

describe("parseTranslation", () => {
  it("keeps headings, lists and paragraphs and highlights marked sentences", () => {
    const blocks = parseTranslation("## 我们提供\n\n- [[T1]]年薪 9 万欧元[[/T1]]\n- 远程办公\n\n正文 **加粗** 内容。", ACTIVE);
    expect(blocks).toEqual([
      { type: "heading", text: "我们提供" },
      { type: "list", items: [[{ text: "年薪 9 万欧元", tier: "T1", color: "amber" }], [{ text: "远程办公" }]] },
      { type: "paragraph", segments: [{ text: "正文 " }, { text: "加粗", bold: true }, { text: " 内容。" }] },
    ]);
  });

  it("carries a highlight across bold pieces; a marker of a deleted or unknown category leaves plain text", () => {
    const [block] = parseTranslation("[[T2]]奖金 **20%** 以上[[/T2]] 以及 [[T3]]有竞争力[[/T3]]", ACTIVE);
    expect(block).toEqual({
      type: "paragraph",
      segments: [{ text: "奖金 ", tier: "T2", color: "teal" }, { text: "20%", bold: true, tier: "T2", color: "teal" }, { text: " 以上", tier: "T2", color: "teal" }, { text: " 以及 " }, { text: "有竞争力" }],
    });
  });

  it("highlights any category id the page names", () => {
    const [block] = parseTranslation("[[visa]]提供签证担保[[/visa]]。", ACTIVE);
    expect(block).toEqual({ type: "paragraph", segments: [{ text: "提供签证担保", tier: "visa", color: "violet" }, { text: "。" }] });
    expect(parseTranslation("[[visa]]提供签证担保[[/visa]]。")[0]).toEqual({ type: "paragraph", segments: [{ text: "提供签证担保" }, { text: "。" }] });
  });

  it("never produces markup: HTML in the translation stays text", () => {
    const [block] = parseTranslation("<script>alert(1)</script>");
    expect(block).toEqual({ type: "paragraph", segments: [{ text: "<script>alert(1)</script>" }] });
  });
});
