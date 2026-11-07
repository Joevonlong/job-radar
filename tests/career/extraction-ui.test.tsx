// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";

import { CareerExtraction } from "@/components/career/career-extraction";
import { CareerEditor } from "@/components/career/career-editor";
import { DraftReview } from "@/components/career/draft-review";
import { adoptCareerDraftAction, discardCareerDraftAction } from "@/app/career/actions";
import { emptyProfile } from "@/lib/career/schema/profile";
import { draft, settings } from "./extract-fixtures";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

vi.mock("@/app/career/actions", () => ({ getCareerExtractStatus: vi.fn(), listCareerDrafts: vi.fn(), adoptCareerDraftAction: vi.fn(), discardCareerDraftAction: vi.fn() }));
vi.mock("@/components/control/use-control-request", () => ({ useControlRequest: () => ({ stage: null, queue: null }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("requires a second explicit confirmation when final scrubbing changes the preview", async () => {
  const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  const fetch = vi.fn().mockResolvedValueOnce(reply({ ok: true, text: "Original preview [email]", candidates: { name: null, address: null }, removed: 1, chars: 24, truncated: false, highlights: [{ start: 0, end: 8, kind: "location" }] }))
    .mockResolvedValueOnce(reply({ ok: false, error: "review_again", text: "Corrected preview [email]", highlights: [{ start: 0, end: 9, kind: "location" }] }))
    .mockResolvedValueOnce(reply({ ok: true, requestId: 21 }));
  vi.stubGlobal("fetch", fetch);
  render(<NextIntlClientProvider locale="en" messages={en}><CareerExtraction view={{ limits: settings().import, providers: [], drafts: [], open: null }} profile={emptyProfile()} baseHash={null} dirty={false} onAdopted={vi.fn()} /></NextIntlClientProvider>);
  fireEvent.change(screen.getByTestId("career-extract-source"), { target: { value: "Fictional source containing an email" } });
  fireEvent.click(screen.getByRole("button", { name: en.career.extract.preview }));
  await screen.findByTestId("outbound-send");
  fireEvent.click(screen.getByTestId("outbound-send"));
  await waitFor(() => expect(screen.getByTestId("outbound-text")).toHaveValue("Corrected preview [email]"));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("alert")).toHaveAttribute("data-code", "review_again");
  expect(screen.getByRole("alert")).toHaveTextContent(en.career.extract.errors.review_again);
  await waitFor(() => expect(screen.getByTestId("outbound-text")).toHaveFocus());
  expect(screen.getByText("Corrected", { selector: "mark" })).toBeVisible();
  fireEvent.click(screen.getByTestId("outbound-send"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({ origin: "resume", text: "Corrected preview [email]" });
});

it.each([["en", en], ["zh", zh]] as const)("shows human evidence flags and preserves a draft on stale adoption (%s)", async (locale, messages) => {
  const source = draft();
  source.sections.experience[0]!.fields.role!.flags = ["quote_missing", "quote_too_short", "figure_missing", "year_missing", "date_invalid", "pii"];
  vi.mocked(adoptCareerDraftAction).mockResolvedValue({ ok: false, code: "stale" });
  const removed = vi.fn();
  render(<NextIntlClientProvider locale={locale} messages={messages}><DraftReview draft={source} profile={emptyProfile()} baseHash={"a".repeat(64)} dirty={false} onAdopted={vi.fn()} onRemoved={removed} /></NextIntlClientProvider>);
  for (const text of Object.values(messages.career.extract.flags)) expect(screen.getByText(text)).toBeVisible();
  fireEvent.change(screen.getByLabelText(messages.career.extract.decision), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: messages.career.extract.adopt }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(messages.career.errors.stale));
  expect(adoptCareerDraftAction).toHaveBeenCalledWith(expect.objectContaining({ baseHash: "a".repeat(64) }));
  expect(removed).not.toHaveBeenCalled();
});
it("blocks adoption with unsaved profile changes and allows discarding the draft", async () => {
  vi.mocked(discardCareerDraftAction).mockResolvedValue({ ok: true });
  const removed = vi.fn();
  render(<NextIntlClientProvider locale="en" messages={en}><DraftReview draft={draft()} profile={emptyProfile()} baseHash={null} dirty onAdopted={vi.fn()} onRemoved={removed} /></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.career.extract.decision), { target: { value: "new" } });
  expect(screen.getByRole("button", { name: en.career.extract.adopt })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: en.career.extract.discard }));
  await waitFor(() => expect(removed).toHaveBeenCalledOnce());
});
it("requires a selected parent entry even when a nested item is selected", () => {
  const source = draft();
  const parent = source.sections.experience[0]!;
  parent.items = [{ ...structuredClone(parent), key: "d1.1", items: [] }];
  render(<NextIntlClientProvider locale="en" messages={en}><DraftReview draft={source} profile={emptyProfile()} baseHash={null} dirty={false} onAdopted={vi.fn()} onRemoved={vi.fn()} /></NextIntlClientProvider>);
  expect(screen.getByRole("checkbox", { name: en.career.extract.include })).toBeChecked();
  expect(screen.getByRole("button", { name: en.career.extract.adopt })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(en.career.extract.decision), { target: { value: "new" } });
  expect(screen.getByRole("button", { name: en.career.extract.adopt })).toBeEnabled();
});
it("announces adoption activity until the request settles", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof adoptCareerDraftAction>>>();
  vi.mocked(adoptCareerDraftAction).mockReturnValue(pending.promise);
  const activity = vi.fn();
  render(<NextIntlClientProvider locale="en" messages={en}><DraftReview draft={draft()} profile={emptyProfile()} baseHash={null} dirty={false} onAdopting={activity} onAdopted={vi.fn()} onRemoved={vi.fn()} /></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.career.extract.decision), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: en.career.extract.adopt }));
  expect(activity).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("button", { name: en.career.extract.adopt })).toBeDisabled();
  pending.resolve({ ok: false, code: "stale" });
  await waitFor(() => expect(activity).toHaveBeenLastCalledWith(false));
});
it("locks manual profile editing, saving and restoration during adoption", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof adoptCareerDraftAction>>>();
  vi.mocked(adoptCareerDraftAction).mockReturnValue(pending.promise);
  render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><CareerEditor initial={{ profile: emptyProfile(), baseHash: null, updatedAt: null }} contact={null} initialVersions={[]} errors={[]} limits={settings().profile} timeZone="UTC" extraction={{ limits: settings().import, providers: [], drafts: [draft()], open: null }} /></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.career.extract.decision), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: en.career.extract.adopt }));
  expect(screen.getByRole("button", { name: en.career.save })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add experience" })).toBeDisabled();
  expect(screen.getByRole("button", { name: en.career.deleteProfile })).toBeDisabled();
  pending.resolve({ ok: false, code: "stale" });
  await waitFor(() => expect(screen.getByRole("button", { name: en.career.save })).not.toBeDisabled());
});
