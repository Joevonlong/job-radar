import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { describe, expect, it } from "vitest";

import { DisclosureSection } from "@/components/settings/ai/disclosure-section";
import { aiDisclosure, type AiDisclosureRow } from "@/lib/ai/disclosure";

import { pinnedAi } from "../ai/helpers";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

function Host({ rows }: { rows: AiDisclosureRow[] | null }) {
  const t = useTranslations("settings");
  return <DisclosureSection ctx={{ t, aiDisclosure: rows }} />;
}

function mount(locale: "en" | "zh", rows: AiDisclosureRow[] | null) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      <Host rows={rows} />
    </NextIntlClientProvider>,
  );
}

describe("DisclosureSection", () => {
  it("lists the providers of each task in the order they are tried", () => {
    mount("en", aiDisclosure(pinnedAi()));
    const row = within(screen.getByTestId("disclosure-row-score"));
    expect(row.getAllByText(/./, { selector: "[data-provider]" }).map((el) => el.getAttribute("data-provider"))).toEqual([
      "codex-cli",
      "claude-cli",
      "anthropic",
      "deepseek",
      "mimo",
    ]);
    expect(screen.getAllByTestId(/^disclosure-row-/)).toHaveLength(9);
  });

  it("says so when a task has no provider switched on", () => {
    mount("en", [{ task: "score", providers: [], web: false }]);
    expect(screen.getByTestId("disclosure-none-score").textContent).toBe(en.settings.ai.disclosure.none);
  });

  it("links the hint to the English or the Chinese provider doc", () => {
    const rows = aiDisclosure(pinnedAi());
    const first = mount("en", rows);
    expect(screen.getByTestId("doc-link-aiProviders").getAttribute("href")).toMatch(/\/docs\/ai-providers\.md#which-providers-receive-job-text$/);
    first.unmount();
    mount("zh", rows);
    expect(screen.getByTestId("doc-link-aiProviders").getAttribute("href")).toMatch(/\/docs\/ai-providers\.zh\.md#/);
  });

  it("renders nothing when the saved config cannot be read", () => {
    mount("en", null);
    expect(screen.queryByTestId("section-disclosure")).toBeNull();
  });
});
