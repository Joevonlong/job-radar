import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SuggestionActionState } from "@/lib/interests/suggestion-types";
import type { SuggestionItemView, SuggestionsSectionData } from "@/lib/interests/suggestion-view";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const actions = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn(), run: vi.fn() }));
vi.mock("@/app/interests/suggestion-actions", () => ({
  approveSuggestionAction: actions.approve,
  rejectSuggestionAction: actions.reject,
  requestSuggestRunAction: actions.run,
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SuggestionsPanel } from "@/components/interests/suggestions";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

const evidence = [
  { jobId: 11, title: "AI Engineer", company: "Northwind", quote: "We offer a wellness budget." },
  { jobId: 12, title: "ML Engineer", company: "Acme", quote: "A wellness budget for everyone." },
];
const item = (id: number, over: Partial<SuggestionItemView> = {}): SuggestionItemView => ({
  id,
  status: "pending",
  createdAt: "2026-10-05T06:00:00.000Z",
  decidedAt: null,
  payload: { kind: "signal_word", tier: "benefit_tag", term: "wellness budget", reasons: { zh: "两个岗位都提到", en: "Both jobs mention it" }, confidence: 0.82, evidence },
  categoryName: "Benefit",
  ...over,
});
const data = (over: Partial<SuggestionsSectionData> = {}): SuggestionsSectionData => ({ pending: [item(1)], decided: [], lastRun: null, loadError: false, ...over });

beforeEach(() => {
  actions.approve.mockReset();
  actions.reject.mockReset();
  actions.run.mockReset();
});

describe("SuggestionsPanel", () => {
  it("shows a suggestion with its value, kind, confidence, reason and the evidence quotes", async () => {
    const user = userEvent.setup();
    render(wrap(<SuggestionsPanel data={data()} />));
    const card = screen.getByTestId("suggestion-item");
    expect(within(card).getByTestId("suggestion-value")).toHaveTextContent("wellness budget");
    expect(card).toHaveTextContent("Signal word (Benefit)");
    expect(card).toHaveTextContent("82% sure");
    expect(card).toHaveTextContent("Both jobs mention it");
    await user.click(within(card).getByText("Evidence from 2 job(s)"));
    expect(within(card).getByText("“We offer a wellness budget.”")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "AI Engineer · Northwind" })).toHaveAttribute("href", "/jobs/11");
  });

  it("shows the reason in the interface language", () => {
    render(wrap(<SuggestionsPanel data={data()} />, "zh"));
    expect(screen.getByTestId("suggestion-item")).toHaveTextContent("两个岗位都提到");
  });

  it("approve calls the action, removes the suggestion and tells what was recomputed", async () => {
    const user = userEvent.setup();
    const result: SuggestionActionState = { status: "approved", id: 1, nonce: 1, change: "added", recompute: { reconciled: true, checked: 5, updated: 2, rescanPending: true, rescorePending: false } };
    actions.approve.mockResolvedValue(result);
    render(wrap(<SuggestionsPanel data={data({ pending: [item(1), item(2, { payload: { kind: "watched_company", company: "Acme", reasons: { zh: "好", en: "Good" }, confidence: 0.7, evidence } })] })} />));
    expect(screen.getAllByTestId("suggestion-item")).toHaveLength(2);

    await user.click(within(screen.getAllByTestId("suggestion-item")[0] as HTMLElement).getByTestId("suggestion-approve"));
    await waitFor(() => expect(screen.getAllByTestId("suggestion-item")).toHaveLength(1));
    expect(actions.approve).toHaveBeenCalledWith(1);
    const notice = screen.getByTestId("suggestion-approved");
    expect(notice).toHaveTextContent("Added to your lists.");
    expect(notice).toHaveTextContent("5 scores checked, 2 updated");
    expect(notice).toHaveTextContent("scans the job descriptions again");
  });

  it("reject calls the action and removes the suggestion", async () => {
    const user = userEvent.setup();
    actions.reject.mockResolvedValue({ status: "rejected", id: 1, nonce: 1 });
    render(wrap(<SuggestionsPanel data={data()} />));
    await user.click(screen.getByTestId("suggestion-reject"));
    await waitFor(() => expect(screen.queryByTestId("suggestion-item")).toBeNull());
    expect(actions.reject).toHaveBeenCalledWith(1);
    expect(screen.getByTestId("suggestions-empty")).toBeInTheDocument();
  });

  it("keeps the suggestion and shows the reason when the action fails", async () => {
    const user = userEvent.setup();
    actions.approve.mockResolvedValue({ status: "error", id: 1, nonce: 1, error: "writeFailed" });
    render(wrap(<SuggestionsPanel data={data()} />));
    await user.click(screen.getByTestId("suggestion-approve"));
    expect(await screen.findByTestId("suggestion-error")).toHaveTextContent("could not be written");
    expect(screen.getAllByTestId("suggestion-item")).toHaveLength(1);
  });

  it("an unreadable suggestion can only be rejected", () => {
    render(wrap(<SuggestionsPanel data={data({ pending: [item(3, { payload: null })] })} />));
    expect(screen.getByTestId("suggestion-item")).toHaveTextContent("could not be read");
    expect(screen.queryByTestId("suggestion-approve")).toBeNull();
    expect(screen.getByTestId("suggestion-reject")).toBeInTheDocument();
  });

  it("empty state, last run line, history and the run-now request", async () => {
    const user = userEvent.setup();
    actions.run.mockResolvedValue({ status: "queued", request: 4, existing: false, nonce: 1 });
    const decided = [item(8, { status: "approved", decidedAt: "2026-10-06T06:00:00.000Z" }), item(9, { status: "rejected", decidedAt: "2026-10-06T05:00:00.000Z" })];
    render(wrap(<SuggestionsPanel data={data({ pending: [], decided, lastRun: { requestedAt: "2026-10-05T06:00:00.000Z", status: "done", stored: 0, skipped: "too_few_liked_jobs", error: null } })} />));
    expect(screen.getByTestId("suggestions-empty")).toBeInTheDocument();
    expect(screen.getByTestId("suggest-last-run")).toHaveTextContent("too few liked jobs");
    expect(within(screen.getByTestId("suggestion-history")).getAllByRole("listitem")).toHaveLength(2);

    await user.click(screen.getByTestId("suggest-run"));
    expect(await screen.findByTestId("suggest-run-queued")).toHaveTextContent("Requested.");
    expect(actions.run).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("suggest-run")).toBeDisabled();
  });

  it("a database problem is shown and the run button is disabled", () => {
    render(wrap(<SuggestionsPanel data={data({ pending: [], loadError: true })} />));
    expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.getByTestId("suggest-run")).toBeDisabled();
  });
});
