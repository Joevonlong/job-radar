// @vitest-environment node
import { describe, expect, it } from "vitest";

import { languageSchema } from "@/lib/config";
import { cliLocaleFrom, notifyLocale, cliLocale, defaultUiLocale } from "@/lib/i18n/config";
import { bcp47, displayLanguageName, isLanguageCode, isWideLanguage, languageAutonym, promptLanguageName, sameLanguage, targetScript } from "@/lib/i18n/languages";
import { messagesFor, translatorFor } from "@/lib/i18n/node";

describe("language codes", () => {
  it("accepts BCP 47 language codes and nothing else", () => {
    for (const code of ["en", "zh", "de", "pt-BR", "zh-Hant", "fil"]) expect(isLanguageCode(code), code).toBe(true);
    for (const code of ["EN", "english", "zh_CN", "", "x", "en-us", "<script>", 3]) expect(isLanguageCode(code), String(code)).toBe(false);
  });

  it("names languages for prompts, people and lang attributes", () => {
    expect(promptLanguageName("zh")).toBe("Simplified Chinese");
    expect(promptLanguageName("en")).toBe("English");
    expect(promptLanguageName("fr")).toBe("French");
    expect(displayLanguageName("de", "zh")).toBe("德语");
    expect(displayLanguageName("zh", "en")).toBe("Chinese");
    expect(languageAutonym("zh")).toBe("中文");
    expect(languageAutonym("de")).toBe("Deutsch");
    expect(bcp47("zh")).toBe("zh-CN");
    expect(bcp47("en")).toBe("en-US");
    expect(bcp47("fr")).toBe("fr");
  });

  it("compares primary languages and knows scripts and width", () => {
    expect(sameLanguage("zh", "zh-CN")).toBe(true);
    expect(sameLanguage("en", "de")).toBe(false);
    expect(sameLanguage(null, "en")).toBe(false);
    expect(targetScript("zh")).toBe("Hans");
    expect(targetScript("en")).toBe("Latn");
    expect(targetScript("ru")).toBe("Cyrl");
    expect(isWideLanguage("zh")).toBe(true);
    expect(isWideLanguage("ja")).toBe(true);
    expect(isWideLanguage("de")).toBe(false);
  });
});

describe("language.yaml schema", () => {
  const base = { ui: { default_locale: "en" }, ai: { output: "en", summary_also: [] }, translation: { target: "en" }, notify: { locale: null }, cli: { locale: null } };

  it("accepts the shipped shape and fills the optional parts", () => {
    expect(languageSchema.parse({ ...base, ai: { output: "de" }, notify: {}, cli: {} })).toEqual({ ...base, ai: { output: "de", summary_also: [] } });
  });

  it("limits interface languages to the messages files, AI and translation to language codes", () => {
    expect(languageSchema.safeParse({ ...base, ui: { default_locale: "fr" } }).success).toBe(false);
    expect(languageSchema.safeParse({ ...base, notify: { locale: "de" } }).success).toBe(false);
    expect(languageSchema.safeParse({ ...base, ai: { output: "fr", summary_also: ["de"] }, translation: { target: "pt-BR" } }).success).toBe(true);
    expect(languageSchema.safeParse({ ...base, ai: { output: "French", summary_also: [] } }).success).toBe(false);
    expect(languageSchema.safeParse({ ...base, translation: { target: "zh_CN" } }).success).toBe(false);
  });

  it("refuses a summary language twice or equal to the output language", () => {
    expect(languageSchema.safeParse({ ...base, ai: { output: "zh", summary_also: ["zh"] } }).success).toBe(false);
    expect(languageSchema.safeParse({ ...base, ai: { output: "zh", summary_also: ["en", "en"] } }).success).toBe(false);
  });
});

describe("configured languages", () => {
  const config = languageSchema.parse({ ui: { default_locale: "zh" }, ai: { output: "zh" }, translation: { target: "zh" }, notify: { locale: "en" }, cli: { locale: null } });

  it("falls back to the interface default and to English", () => {
    expect(defaultUiLocale(config)).toBe("zh");
    expect(notifyLocale(config)).toBe("en");
    expect(cliLocale(config)).toBe("zh");
    expect(defaultUiLocale(null)).toBe("en");
    expect(cliLocaleFrom(config, "en")).toBe("en");
    expect(cliLocaleFrom(config, "fr")).toBe("zh");
  });

  it("translates outside React in any interface language", () => {
    expect(translatorFor("en", "shell")("languageMenu")).toBe("Language");
    expect(translatorFor("zh", "shell")("languageMenu")).toBe("语言");
    expect(messagesFor("zh").meta.name).toBe("中文");
  });
});
