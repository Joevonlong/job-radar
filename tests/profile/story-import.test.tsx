// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { storyExtractStatusAction } from "@/app/me/actions";
import { StoryImport } from "@/components/profile/story-import";
import type { StoryImportView } from "@/lib/profile/view";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/me/actions", () => ({ adoptStoryDraftAction: vi.fn(), discardStoryDraftAction: vi.fn(), storyExtractStatusAction: vi.fn(async () => null) }));
vi.mock("@/lib/toast", () => ({ toastTone: vi.fn() }));

const view: StoryImportView = { enabled: true, maxFileBytes: 2_000_000, maxChars: 30_000, formats: ["pdf", "md", "txt"], ttlDays: 14, providers: [], drafts: [], open: null, error: null };

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

const preview = { ok: true, text: "Built a reliable service.", chars: 25, removed: 1, truncated: false, candidates: { name: null, address: null }, highlights: [] };

it.each(["profile", "self_description", "resume"] as const)("previews %s before posting confirmed JSON", async (origin) => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/prepare") ? preview : { ok: true, requestId: 7, truncated: false })));
  vi.stubGlobal("fetch", fetch);
  render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><StoryImport view={view} baseHash="h" dirty={false} /></NextIntlClientProvider>);
  if (origin === "profile") fireEvent.click(screen.getByTestId("story-import-profile"));
  if (origin === "self_description") {
    fireEvent.click(screen.getByTestId("story-import-paste"));
    fireEvent.change(screen.getByTestId("story-import-text"), { target: { value: "Private source text" } });
    fireEvent.click(screen.getByTestId("story-import-send-text"));
  }
  if (origin === "resume") {
    fireEvent.click(screen.getByTestId("story-import-upload"));
    fireEvent.change(screen.getByTestId("story-import-file"), { target: { files: [new File(["Private source text"], "resume.txt")] } });
    fireEvent.click(screen.getByTestId("story-import-send-file"));
  }
  await screen.findByTestId("send-preview");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/api/me/story-extract/prepare");
  fireEvent.change(screen.getByTestId("outbound-text"), { target: { value: "  Confirmed source text\n" } });
  fireEvent.click(screen.getByTestId("outbound-send"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch).toHaveBeenLastCalledWith("/api/me/story-extract", expect.objectContaining({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, text: "  Confirmed source text\n" }) }));
});

it("returns changed text to the preview for another confirmation", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/prepare") ? preview : { ok: false, error: "review_again", text: "Email: [email]", highlights: [] })));
  vi.stubGlobal("fetch", fetch);
  render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><StoryImport view={view} baseHash="h" dirty={false} /></NextIntlClientProvider>);
  fireEvent.click(screen.getByTestId("story-import-profile"));
  await screen.findByTestId("send-preview");
  fireEvent.click(screen.getByTestId("outbound-send"));
  await waitFor(() => expect(screen.getByTestId("outbound-text")).toHaveValue("Email: [email]"));
  expect(screen.getByTestId("story-import-error")).toHaveAttribute("data-error", "review_again");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("asks an old queued request to go through the preview again", async () => {
  vi.mocked(storyExtractStatusAction).mockResolvedValueOnce({ ok: false, error: "preview_required", resumeAt: null });
  render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><StoryImport view={{ ...view, open: { requestId: 8, stage: "pending", queue: null } }} baseHash="h" dirty={false} /></NextIntlClientProvider>);
  const error = await screen.findByTestId("story-import-error");
  expect(error).toHaveAttribute("data-error", "preview_required");
  expect(error).toHaveTextContent(en.profile.storyImport.error.preview_required);
});

it.each([["en", en], ["zh", zh]] as const)("shows an upgrade failure on load and dismisses it only in the client (%s)", (locale, messages) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const failedView: StoryImportView = { ...view, error: "preview_required" };
  render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC"><StoryImport view={failedView} baseHash="h" dirty={false} /></NextIntlClientProvider>);
  expect(screen.getByTestId("story-import-error")).toHaveTextContent(messages.profile.storyImport.error.preview_required);
  fireEvent.click(screen.getByRole("button", { name: messages.profile.storyImport.dismissError }));
  expect(screen.queryByTestId("story-import-error")).not.toBeInTheDocument();
  expect(failedView.error).toBe("preview_required");
  expect(fetch).not.toHaveBeenCalled();
});

it("removes the initial upgrade notice when page data has a newer extraction", () => {
  const page = (error: StoryImportView["error"]) => <NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><StoryImport view={{ ...view, error }} baseHash="h" dirty={false} /></NextIntlClientProvider>;
  const { rerender } = render(page("preview_required"));
  expect(screen.getByTestId("story-import-error")).toBeVisible();
  rerender(page(null));
  expect(screen.queryByTestId("story-import-error")).not.toBeInTheDocument();
});

it("clears the selected upload when its preview is cancelled", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(preview)));
  vi.stubGlobal("fetch", fetch);
  render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><StoryImport view={view} baseHash="h" dirty={false} /></NextIntlClientProvider>);
  fireEvent.click(screen.getByTestId("story-import-upload"));
  fireEvent.change(screen.getByTestId("story-import-file"), { target: { files: [new File(["Private source text"], "resume.txt")] } });
  fireEvent.click(screen.getByTestId("story-import-send-file"));
  await screen.findByTestId("send-preview");
  fireEvent.click(screen.getByRole("button", { name: en.outbound.cancel }));
  expect(screen.queryByTestId("send-preview")).not.toBeInTheDocument();
  expect(screen.getByTestId("story-import-file")).toHaveValue("");
  expect(screen.getByTestId("story-import-send-file")).toBeDisabled();
  fireEvent.click(screen.getByTestId("story-import-send-file"));
  expect(fetch).toHaveBeenCalledTimes(1);
});
