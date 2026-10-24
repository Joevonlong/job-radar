import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompanyTable } from "@/components/companies/company-table";
import { CompanySortControls } from "@/components/companies/sort-controls";
import { WatchToggle } from "@/components/companies/watch-toggle";
import type { CompanyOverviewItem } from "@/lib/companies/overview";
import { loadCompaniesSearchParams } from "@/lib/companies/search-params";
import { companyJobsHref } from "@/lib/jobs/company-link";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";
import en from "../../messages/en.json";

const mocks = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn(), refresh: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock("@/app/interests/actions", () => ({ addWatchedCompanyAction: mocks.add, removeWatchedCompanyAction: mocks.remove }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }) }));
vi.mock("@/lib/toast", () => ({ toastTone: mocks.toast }));

const now = new Date("2026-01-04T12:00:00Z");
const wrap = (node: ReactNode) => <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">{node}</NextIntlClientProvider>;
const row = (over: Partial<CompanyOverviewItem> = {}): CompanyOverviewItem => ({
  id: 1, name: "Acme & Co", nameNorm: "acme", aliases: [], watched: false, blacklisted: false,
  jobCount: 3, topRank: 106.6, lastFirstSeenAt: new Date("2026-01-01T23:30:00Z"),
  watchedEntry: null, watchedByFlagOnly: false, excluded: false, href: companyJobsHref("Acme & Co"), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue({ status: "saved", section: "watched", nonce: 1 });
  mocks.remove.mockResolvedValue({ status: "saved", section: "watched", nonce: 2 });
});

describe("company overview", () => {
  it("renders table columns and only marks the active header with aria-sort; sort links preserve search and reset the page", () => {
    render(wrap(<CompanyTable rows={[row()]} params={loadCompaniesSearchParams({ q: "Acme & Co", page: "3" })} now={now} timezone="UTC" />));
    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("columnheader").map((head) => head.textContent)).toEqual(["Company", "Open jobs", "Top score", "Latest first seen", "Status", "Actions"]);
    expect(table.getByRole("columnheader", { name: "Open jobs" })).toHaveAttribute("aria-sort", "descending");
    expect(table.getByRole("columnheader", { name: "Top score" })).not.toHaveAttribute("aria-sort");
    const jobs = new URL(table.getByRole("link", { name: "Open jobs" }).getAttribute("href")!, "https://example.test");
    expect(loadCompaniesSearchParams(jobs.searchParams)).toEqual({ q: "Acme & Co", sort: "jobs", dir: "asc", page: 1 });
    const score = new URL(table.getByRole("link", { name: "Top score" }).getAttribute("href")!, "https://example.test");
    expect(loadCompaniesSearchParams(score.searchParams)).toEqual({ q: "Acme & Co", sort: "score", dir: "desc", page: 1 });
  });

  it.each(["jobs", "score", "recent"])("flips an ascending %s header back to descending", (sort) => {
    render(wrap(<CompanyTable rows={[row()]} params={loadCompaniesSearchParams({ sort, dir: "asc" })} now={now} timezone="UTC" />));
    const active = screen.getByRole("table").querySelector('th[aria-sort="ascending"]')!;
    const url = new URL(active.querySelector("a")!.href);
    expect(loadCompaniesSearchParams(url.searchParams)).toMatchObject({ sort, dir: "desc", page: 1 });
  });

  it("links company names and exclusions, formats scores without clipping bonuses, and uses the configured timezone", () => {
    render(wrap(<CompanyTable rows={[row()]} params={loadCompaniesSearchParams({})} now={now} timezone="Asia/Tokyo" />));
    const table = within(screen.getByRole("table"));
    expect(table.getByRole("link", { name: "Acme & Co" })).toHaveAttribute("href", companyJobsHref("Acme & Co"));
    expect(table.getByRole("link", { name: "Exclude…" })).toHaveAttribute("href", "/me#exclude-companies");
    expect(table.getByText("107")).toBeInTheDocument();
    expect(table.getByTitle("2026-01-02 08:30")).toHaveTextContent("Jan 2");
  });

  it("leaves overlong names as text and shows an excluded mark without an exclude action", () => {
    const name = "a".repeat(MAX_FILTER_VALUE_CHARS + 1);
    render(wrap(<CompanyTable rows={[row({ name, href: companyJobsHref(name), topRank: null, excluded: true })]} params={loadCompaniesSearchParams({})} now={now} timezone="UTC" />));
    const table = within(screen.getByRole("table"));
    expect(table.getByText(name).closest("a")).toBeNull();
    expect(table.getByText("Excluded")).toBeInTheDocument();
    expect(table.queryByRole("link", { name: "Exclude…" })).toBeNull();
    expect(table.getAllByText("—")).toHaveLength(1);
  });

  it("renders an empty state without a table or watch buttons", () => {
    render(wrap(<CompanyTable rows={[]} params={loadCompaniesSearchParams({})} now={now} timezone="UTC" />));
    expect(screen.getByText("No companies found. Try another name or wait for new jobs to arrive.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("mobile sorting preserves search and resets paging; changing the sort starts descending", async () => {
    render(wrap(<CompanySortControls params={loadCompaniesSearchParams({ q: "Acme", sort: "jobs", dir: "asc", page: "4" })} />));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "recent" } });
    expect(loadCompaniesSearchParams(new URL(mocks.push.mock.calls[0]![0], "https://example.test").searchParams)).toEqual({ q: "Acme", sort: "recent", dir: "desc", page: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Ascending; switch to descending" }));
    expect(loadCompaniesSearchParams(new URL(mocks.push.mock.calls[1]![0], "https://example.test").searchParams)).toEqual({ q: "Acme", sort: "jobs", dir: "desc", page: 1 });
  });
});

describe("company watch toggle", () => {
  it("watches using the displayed name and refreshes after success", async () => {
    render(wrap(<WatchToggle row={row()} />));
    await userEvent.click(screen.getByRole("button", { name: "Watch" }));
    expect(mocks.add).toHaveBeenCalledWith({ name: "Acme & Co" });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith("success", "Now watching “Acme & Co”");
  });

  it("unwatches the original entry, including its suffix and spelling", async () => {
    render(wrap(<WatchToggle row={row({ name: "Acme", watched: true, watchedEntry: "ACME GmbH" })} />));
    await userEvent.click(screen.getByRole("button", { name: "Unwatch" }));
    expect(mocks.remove).toHaveBeenCalledWith({ name: "ACME GmbH" });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("gives flag-only companies a label and no watch button", () => {
    render(wrap(<WatchToggle row={row({ watched: true, watchedByFlagOnly: true })} />));
    expect(screen.getByText("Watched (database flag)")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports an action error and leaves the row unchanged", async () => {
    mocks.add.mockResolvedValue({ status: "error", formError: "writeFailed" });
    render(wrap(<WatchToggle row={row()} />));
    await userEvent.click(screen.getByRole("button", { name: "Watch" }));
    expect(mocks.toast).toHaveBeenCalledWith("error", en.interests.formErrors.writeFailed);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("disables the toggle while saving and recovers after a rejected request", async () => {
    let rejectRequest!: (reason: Error) => void;
    mocks.add.mockReturnValue(new Promise((_, reject) => { rejectRequest = reject; }));
    render(wrap(<WatchToggle row={row()} />));
    const button = screen.getByRole("button", { name: "Watch" });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    rejectRequest(new Error("offline"));
    await screen.findByRole("button", { name: "Watch" });
    await vi.waitFor(() => expect(button).toBeEnabled());
    expect(mocks.toast).toHaveBeenCalledWith("error", en.companies.watchFailed);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
