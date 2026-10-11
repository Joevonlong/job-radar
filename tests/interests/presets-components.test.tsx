/** Signal presets in the browser components: the add dialog's presets, the "AI only" hint / warning and the preview result. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/interests/actions", () => ({}));

import { VocabularyForm } from "@/components/interests/vocabulary-form";
import type { SignalPreset } from "@/lib/config/schemas/signal-presets";
import type { CategoryPreview } from "@/lib/interests/preview";
import { presetOptions } from "@/lib/interests/presets";
import { IDLE_INTERESTS_STATE } from "@/lib/interests/types";
import { configToDraft, type VocabularyDraft } from "@/lib/interests/vocabulary-draft";

import en from "../../messages/en.json";
import { shippedInterests } from "../signals/helpers";

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
);

const preset: SignalPreset = {
  id: "T2",
  label: { en: "Perk", zh: "福利" },
  icon: "🎁",
  color: "violet",
  weight: 3,
  high_value: false,
  ai_confirm_only: false,
  ai_definition: "a perk the employer pays for",
  keywords: { en: ["perk"], de: ["Vorteil"] },
  patterns: {},
  exclude: {},
};

function form(options: { aiReviewWithoutCandidates?: boolean; onPreview?: (draft: VocabularyDraft, id: string) => Promise<CategoryPreview>; initial?: VocabularyDraft } = {}) {
  const onSave = vi.fn();
  render(
    wrap(
      <VocabularyForm
        initial={options.initial ?? configToDraft(shippedInterests())}
        signalCounts={null}
        state={IDLE_INTERESTS_STATE}
        pending={false}
        onSave={onSave}
        presets={presetOptions([preset], "de")}
        aiReviewWithoutCandidates={options.aiReviewWithoutCandidates ?? true}
        {...(options.onPreview ? { onPreview: options.onPreview } : {})}
      />,
    ),
  );
  return { onSave };
}

describe("the add dialog's presets", () => {
  it("fills the form from a preset, makes a taken id unique and says so, and adds the preset's definition and words", async () => {
    const user = userEvent.setup();
    const { onSave } = form();
    await user.click(screen.getByTestId("category-add"));
    const dialog = screen.getByTestId("category-add-dialog");
    await user.selectOptions(within(dialog).getByTestId("category-add-preset"), "T2");
    expect(within(dialog).getByTestId("category-add-id")).toHaveValue("T2_2");
    expect(within(dialog).getByTestId("category-add-id-adjusted")).toHaveTextContent('"T2"');
    expect(within(dialog).getByTestId("category-add-en")).toHaveValue("Perk");
    await user.click(within(dialog).getByTestId("category-add-submit"));
    const body = screen.getByTestId("category-body-T2_2");
    expect(within(body).getByTestId("category-ai-T2_2")).toHaveValue("a perk the employer pays for");
    expect(within(body).getByText("Vorteil")).toBeInTheDocument();
    await user.click(screen.getByTestId("vocabulary-save"));
    const saved = onSave.mock.calls[0]?.[0] as VocabularyDraft;
    expect(saved.categories.at(-1)).toMatchObject({ id: "T2_2", kind: "keyword", weight: "3", icon: "🎁", keywords: ["perk", "Vorteil"] });
  });
});

describe("a keyword category without words", () => {
  const wordless = (): VocabularyDraft => {
    const draft = configToDraft(shippedInterests());
    return { ...draft, categories: draft.categories.map((category) => (category.id === "T2" ? { ...category, keywords: [], patterns: [] } : category)) };
  };

  it("says the AI alone finds it, or warns that it can never match when jobs without rule hits are not reviewed", async () => {
    const user = userEvent.setup();
    form({ initial: wordless() });
    await user.click(screen.getByTestId("category-toggle-T2"));
    expect(screen.getByTestId("category-semantic-T2")).toHaveAttribute("data-tone", "info");
  });

  it("warns when ai_review_without_candidates is off", async () => {
    const user = userEvent.setup();
    form({ initial: wordless(), aiReviewWithoutCandidates: false });
    await user.click(screen.getByTestId("category-toggle-T2"));
    expect(screen.getByTestId("category-semantic-T2")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByTestId("category-semantic-T2")).toHaveAttribute("role", "alert");
  });
});

describe("the hit preview", () => {
  it("sends the whole form with the category id and shows hits, examples and the review estimate", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn(async (): Promise<CategoryPreview> => ({ status: "ok", scanned: 40, truncated: false, hits: 2, samples: [{ jobId: 7, title: "Engineer", quote: "Unlimited tokens for everyone." }], review: { jobs: 120, rounds: 3, perCycleLimit: 40 } }));
    form({ onPreview });
    await user.click(screen.getByTestId("category-toggle-T2"));
    await user.click(screen.getByTestId("category-preview-run-T2"));
    const result = await screen.findByTestId("category-preview-result-T2");
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ categories: expect.any(Array) }), "T2");
    expect(result).toHaveTextContent("Rule hits in 2 jobs of the 40 newest open jobs.");
    expect(within(result).getByRole("link", { name: "Engineer" })).toHaveAttribute("href", "/jobs/7");
    expect(screen.getByTestId("category-preview-review-T2")).toHaveTextContent("about 120 jobs are reviewed again by the AI, over about 3 cycles");
    expect(screen.queryByTestId("category-preview-truncated-T2")).toBeNull();
  });

  it("flags a partial result when the time budget ran out", async () => {
    const user = userEvent.setup();
    form({ onPreview: async () => ({ status: "ok", scanned: 12, truncated: true, hits: 1, samples: [], review: null }) });
    await user.click(screen.getByTestId("category-toggle-T2"));
    await user.click(screen.getByTestId("category-preview-run-T2"));
    const result = await screen.findByTestId("category-preview-result-T2");
    expect(result).toHaveAttribute("data-truncated", "true");
    expect(screen.getByTestId("category-preview-truncated-T2")).toHaveTextContent("Partial result: the time limit ran out after 12 jobs");
  });

  it("names the category's own error when the draft does not pass", async () => {
    const user = userEvent.setup();
    form({ onPreview: async () => ({ status: "invalid", fieldErrors: [{ path: "categories.1.aiDefinition", key: "required" }] }) });
    await user.click(screen.getByTestId("category-toggle-T2"));
    await user.click(screen.getByTestId("category-preview-run-T2"));
    expect(await screen.findByTestId("category-preview-result-T2")).toHaveAttribute("data-status", "invalid");
  });
});
