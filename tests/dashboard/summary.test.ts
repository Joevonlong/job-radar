import { describe, expect, it } from "vitest";

import { needsLanguageTag, pickSummary, summaryOrder } from "@/lib/dashboard/summary";
import { summariesOf } from "@/lib/db/summaries";

const both = { zh: "一个后端岗位。", en: "A backend role." };

describe("pickSummary (any number of languages)", () => {
  it("shows the summary in the language of the UI", () => {
    expect(pickSummary(both, summaryOrder("en", "zh"))).toEqual({ text: "A backend role.", lang: "en", fallback: false });
    expect(pickSummary(both, summaryOrder("zh", "zh"))).toEqual({ text: "一个后端岗位。", lang: "zh", fallback: false });
  });

  it("falls back to the AI output language, then English, then any one, marked as a fallback", () => {
    expect(pickSummary({ zh: "只有中文。" }, summaryOrder("en", "zh"))).toEqual({ text: "只有中文。", lang: "zh", fallback: true });
    expect(pickSummary({ zh: " ", en: "English only." }, summaryOrder("zh", "zh"))).toEqual({ text: "English only.", lang: "en", fallback: true });
    expect(pickSummary({ de: "Nur Deutsch.", en: "English." }, summaryOrder("fr", "de"))).toEqual({ text: "Nur Deutsch.", lang: "de", fallback: true });
    expect(pickSummary({ es: "Solo español." }, summaryOrder("zh", "en"))).toEqual({ text: "Solo español.", lang: "es", fallback: true });
  });

  it("matches a language by its primary subtag", () => {
    expect(pickSummary({ "pt-BR": "Resumo." }, summaryOrder("pt", null))).toEqual({ text: "Resumo.", lang: "pt-BR", fallback: false });
  });

  it("is null without summaries", () => {
    expect(pickSummary(null, ["en"])).toBeNull();
    expect(pickSummary({ en: "" }, ["en"])).toBeNull();
  });
});

describe("summaryOrder and needsLanguageTag", () => {
  it("orders interface language, output language, English without repeats", () => {
    expect(summaryOrder("zh", "zh")).toEqual(["zh", "en"]);
    expect(summaryOrder("en", null)).toEqual(["en"]);
    expect(summaryOrder("fr", "de")).toEqual(["fr", "de", "en"]);
  });

  it("marks AI text that is not in the interface language", () => {
    expect(needsLanguageTag("zh", "en")).toBe(true);
    expect(needsLanguageTag("zh", "zh")).toBe(false);
    expect(needsLanguageTag(null, "en")).toBe(false);
  });
});

describe("summariesOf (rows written before the language settings)", () => {
  it("reads scores.summaries, else the old summary columns", () => {
    expect(summariesOf({ summaries: { de: " Kurz. ", en: "" }, summaryZh: "旧", summaryEn: "old" })).toEqual({ de: "Kurz." });
    expect(summariesOf({ summaries: {}, summaryZh: " 旧摘要 ", summaryEn: null })).toEqual({ zh: "旧摘要" });
    expect(summariesOf({ summaries: "not an object", summaryZh: null, summaryEn: null })).toEqual({});
  });
});
