import { describe, expect, it } from "vitest";

import { FALLBACK, LOCALE_COOKIE, LOCALE_META, LOCALES, intlTag, isLocale, resolveLocale } from "@/i18n/locale";

describe("locale resolution", () => {
  it("uses the NEXT_LOCALE cookie name", () => {
    expect(LOCALE_COOKIE).toBe("NEXT_LOCALE");
  });

  it("lists one language per messages file, with English as the fallback", () => {
    expect(LOCALES).toContain("en");
    expect(LOCALES).toContain("zh");
    expect(FALLBACK).toBe("en");
  });

  it("falls back to the given default when there is no cookie", () => {
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale(null, "zh")).toBe("zh");
    expect(resolveLocale("", "zh")).toBe("zh");
  });

  it("accepts supported locales over the default", () => {
    expect(resolveLocale("zh", "en")).toBe("zh");
    expect(resolveLocale("en", "zh")).toBe("en");
  });

  it("falls back to the default for unsupported or malformed values", () => {
    expect(resolveLocale("fr", "zh")).toBe("zh");
    expect(resolveLocale("EN", "zh")).toBe("zh");
    expect(resolveLocale("en-US", "zh")).toBe("zh");
    expect(resolveLocale("<script>", "en")).toBe("en");
  });

  it("isLocale narrows only supported values", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(1)).toBe(false);
  });

  it("maps each language to its Intl tag and own name", () => {
    expect(intlTag("en")).toBe("en-US");
    expect(intlTag("zh")).toBe("zh-CN");
    for (const locale of LOCALES) expect(LOCALE_META[locale].name.length).toBeGreaterThan(0);
  });
});
