// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildTranslatePrompt, TRANSLATE_PROMPT_VERSION } from "@/lib/ai/prompts/translate";
import { createAiRouter } from "@/lib/ai/router";
import { targetScriptPattern, translateText, translationReplySchema } from "@/lib/translation/translate";

import { scriptedProvider } from "../ai/helpers";
import { pinnedAi } from "../ai/helpers";

const reply = (translation: string): string => JSON.stringify({ translation });

describe("translate prompt", () => {
  it("names the source language, lists marked sentences and fences the text", () => {
    const prompt = buildTranslatePrompt({ text: "Wir bieten 80k.", language: "de", target: "zh", marked: ["Wir bieten 80k."] });
    expect(TRANSLATE_PROMPT_VERSION).toMatch(/^translate-v\d+$/);
    expect(prompt.system).toContain("Simplified Chinese");
    expect(prompt.user).toContain("Source language: German");
    expect(prompt.user).toContain('S1: "Wir bieten 80k."');
    expect(prompt.user).toContain("<<<TEXT\nWir bieten 80k.\nTEXT>>>");
    expect(buildTranslatePrompt({ text: "x", language: "other", target: "zh", marked: [] }).user).toContain("not known");
    expect(buildTranslatePrompt({ text: "x", language: "en", target: "zh", marked: [] }).user).not.toContain("Marked sentences");
  });

  it("sends only the glossary terms that occur in the text", () => {
    const glossary = { "Forward Deployed Engineer": "Forward Deployed Engineer", "Solutions Engineer": "解决方案工程师" };
    const prompt = buildTranslatePrompt({ text: "We hire a forward deployed engineer.", language: "en", target: "zh", marked: [], glossary });
    expect(prompt.user).toContain('"Forward Deployed Engineer" -> "Forward Deployed Engineer"');
    expect(prompt.user).not.toContain("Solutions Engineer");
    expect(buildTranslatePrompt({ text: "Hello", language: "en", target: "zh", marked: [], glossary }).user).not.toContain("Glossary");
  });
});

describe("translationReplySchema", () => {
  const source = "We are looking for an engineer who builds retrieval systems and ships them to production.";
  it("accepts a Chinese translation and rejects stubs and untranslated echoes", () => {
    const schema = translationReplySchema(source, "zh");
    expect(schema.safeParse({ translation: "我们正在寻找一位构建检索系统并将其上线的工程师。" }).success).toBe(true);
    expect(schema.safeParse({ translation: "" }).success).toBe(false);
    expect(schema.safeParse({ translation: "好" }).success).toBe(false);
    expect(schema.safeParse({ translation: source }).success).toBe(false);
  });

  it("does not demand Chinese characters for text without words (numbers, URLs)", () => {
    expect(translationReplySchema("12345 67890", "zh").safeParse({ translation: "12345 67890" }).success).toBe(true);
  });
});

function router(replies: string[]) {
  const { provider, transport } = scriptedProvider("codex-cli", replies);
  return { router: createAiRouter({ config: pinnedAi(), providers: [provider], usage: null }), transport };
}

describe("translateText", () => {
  const text = "## What we offer\n\n- Base salary of EUR 90,000 per year\n- 30 days of vacation\n\nJoin our platform team and build retrieval systems for clinical data.";

  it("sends the signal quotes as marked sentences and stores tier markers", async () => {
    const { router: r, transport } = router([reply("## 我们提供\n\n- [[S1]]年薪 90,000 欧元[[/S1]]\n- [[S2]]30 天假期[[/S2]]\n\n加入我们的平台团队，为临床数据构建检索系统。")]);
    const out = await translateText(r, { text, language: "en", target: "zh", signals: [{ tier: "T1", quote: "Base salary of EUR 90,000 per year" }, { tier: "tag", quote: "30 days of vacation" }] });
    expect(out.content).toBe("## 我们提供\n\n- [[T1]]年薪 90,000 欧元[[/T1]]\n- [[tag]]30 天假期[[/tag]]\n\n加入我们的平台团队，为临床数据构建检索系统。");
    expect(out.provider).toBe("codex-cli");
    expect(out.chunks).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.task).toBe("translate");
    expect(transport.calls[0]?.user).toContain('S1: "Base salary of EUR 90,000 per year"');
  });

  it("retries once with the validation error when the model answers with the original text", async () => {
    const { router: r, transport } = router([reply(text), reply("## 我们提供\n\n- 年薪 90,000 欧元\n- 30 天假期\n\n加入我们的平台团队，为临床数据构建检索系统。")]);
    const out = await translateText(r, { text, language: "en", target: "zh" });
    expect(out.content).toContain("我们提供");
    expect(transport.calls).toHaveLength(2);
  });

  it("translates a long JD piece by piece and joins the pieces with blank lines", async () => {
    const paragraph = `${"Retrieval systems for clinical data. ".repeat(40)}`.trim();
    const long = [paragraph, paragraph, paragraph].join("\n\n");
    const { router: r, transport } = router([reply("第一段译文。".repeat(120)), reply("第二段译文。".repeat(120))]);
    const out = await translateText(r, { text: long, language: "en", target: "zh" });
    expect(out.chunks).toBe(2);
    expect(transport.calls).toHaveLength(2);
    expect(out.content).toBe(`${"第一段译文。".repeat(120)}\n\n${"第二段译文。".repeat(120)}`);
  });

  it("rejects an empty text", async () => {
    const { router: r } = router([reply("x")]);
    await expect(translateText(r, { text: "  ", language: "en", target: "zh" })).rejects.toThrow("nothing to translate");
  });
});

describe("configurable target language", () => {
  const english = "We are looking for an engineer who builds retrieval systems and ships them to production.";
  const german = "Wir suchen eine Ingenieurin, die Retrieval-Systeme baut und in Produktion bringt.";

  it("names the target language in the prompt", () => {
    expect(buildTranslatePrompt({ text: "x", language: "de", target: "zh", marked: [] }).system).toContain("into Simplified Chinese");
    const en = buildTranslatePrompt({ text: "x", language: "de", target: "en", marked: [] });
    expect(en.system).toContain("into English for a job seeker");
    expect(en.system).toContain('{"translation": "<the English text>"}');
    expect(en.system).not.toMatch(/Chinese/);
    expect(buildTranslatePrompt({ text: "x", language: "en", target: "ja", marked: [] }).system).toContain("into Japanese");
  });

  it("checks the script of a non-Latin target", () => {
    expect(targetScriptPattern("zh")?.test("中文")).toBe(true);
    expect(targetScriptPattern("ja")?.test("ひらがな")).toBe(true);
    expect(targetScriptPattern("ru")?.test("Привет")).toBe(true);
    expect(targetScriptPattern("ru")?.test("Hello")).toBe(false);
    expect(targetScriptPattern("en")).toBeNull();
    expect(translationReplySchema(english, "ru").safeParse({ translation: "Мы ищем инженера, который строит поисковые системы." }).success).toBe(true);
    expect(translationReplySchema(english, "ru").safeParse({ translation: english }).success).toBe(false);
  });

  it("refuses an echo of the source for a Latin-script target, and says which language it wants", () => {
    const schema = translationReplySchema(german, "en");
    expect(schema.safeParse({ translation: "We are looking for an engineer who builds retrieval systems and brings them to production." }).success).toBe(true);
    const echo = schema.safeParse({ translation: `  ${german.toUpperCase()} ` });
    expect(echo.success).toBe(false);
    expect(echo.error?.issues[0]?.message).toBe("the reply is the source text: translate it into English");
    expect(translationReplySchema(english, "zh").safeParse({ translation: english }).error?.issues.map((i) => i.message)).toContain("the translation must be written in Simplified Chinese");
  });
});
