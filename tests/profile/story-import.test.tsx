// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoryImport } from "@/components/profile/story-import";
import type { StoryImportView } from "@/lib/profile/view";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/me/actions", () => ({ adoptStoryDraftAction: vi.fn(), discardStoryDraftAction: vi.fn(), storyExtractStatusAction: vi.fn(async () => null) }));
vi.mock("@/lib/toast", () => ({ toastTone: vi.fn() }));

const view: StoryImportView = { enabled: true, maxFileBytes: 2_000_000, maxChars: 30_000, formats: ["pdf", "md", "txt"], ttlDays: 14, providers: [], drafts: [], open: null };

afterEach(() => vi.unstubAllGlobals());

describe("StoryImport when the server turns an upload away", () => {
  it.each([["en", en], ["zh", zh]] as const)("says that too many files are being read, and lets you try again (%s)", async (locale, messages) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "too_many" }), { status: 429 })));
    render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <StoryImport view={view} baseHash="h" dirty={false} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByTestId("story-import-profile"));
    const error = await screen.findByTestId("story-import-error");
    expect(error).toHaveAttribute("data-error", "too_many");
    expect(error.textContent).toBe(messages.profile.storyImport.error.too_many);
    expect(error.textContent).not.toContain("error.");
    await waitFor(() => expect(screen.getByTestId("story-import-profile")).not.toBeDisabled());
  });
});
