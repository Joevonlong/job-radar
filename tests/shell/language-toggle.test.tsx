import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const setLocale = vi.fn<(locale: string) => Promise<void>>(async () => {});
vi.mock("@/i18n/actions", () => ({ setLocale: (locale: string) => setLocale(locale) }));
// a third interface language, as a messages file alone would add it (the catalog is generated from messages/)
vi.mock("@/i18n/catalog.generated", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/i18n/catalog.generated")>();
  return {
    ...original,
    LOCALES: ["en", "fr", "zh"],
    LOCALE_META: { ...original.LOCALE_META, fr: { name: "Français", intl: "fr-FR", promptName: "French", wide: false } },
    FORMAT_LABELS: { ...original.FORMAT_LABELS, fr: original.FORMAT_LABELS.en },
  };
});

const { LanguageToggle } = await import("@/components/shell/language-toggle");

describe("LanguageToggle", () => {
  it("with two languages, one button switches to the other one, named in its own language", async () => {
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <LanguageToggle locales={["en", "zh"]} />
      </NextIntlClientProvider>,
    );
    const button = screen.getByRole("button", { name: "English · 切换语言" });
    expect(button).toHaveTextContent("English");
    expect(button.querySelector("[lang]")).toHaveAttribute("lang", "en-US");
    await userEvent.click(button);
    expect(setLocale).toHaveBeenCalledWith("en");
  });

  it("with more languages, a menu lists each by its own name", async () => {
    setLocale.mockClear();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <LanguageToggle />
      </NextIntlClientProvider>,
    );
    const trigger = screen.getByRole("button", { name: "English · Language" });
    expect(trigger).toHaveTextContent("English");
    await userEvent.click(trigger);
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["English", "Français", "中文"]);
    expect(items[1]).toHaveAttribute("lang", "fr-FR");
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    await userEvent.click(items[1] as HTMLElement);
    expect(setLocale).toHaveBeenCalledWith("fr");
  });
});
