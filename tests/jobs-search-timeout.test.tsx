import { render, screen } from "@testing-library/react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

const state = vi.hoisted(() => ({
  locale: "en" as "en" | "zh",
  listJobs: vi.fn(),
  countJobList: vi.fn(),
  countJobListSeen: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getLocale: async () => state.locale,
  getTranslations: async (namespace: string) => createTranslator({
    locale: state.locale, messages: state.locale === "en" ? en : zh, namespace: namespace as never,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db")>(),
  getDb: () => ({}),
  listJobs: state.listJobs,
  countJobList: state.countJobList,
  countJobListSeen: state.countJobListSeen,
  getJobFilterOptions: async () => ({ families: [], contracts: [] }),
  getVisitState: async () => null,
  getFilterFloors: async () => new Map(),
  listMonthSalaryFigures: async () => [],
  listCompanyFilterOptions: async () => [],
}));
vi.mock("@/lib/jobs/list-filters", () => ({
  jobsListFilters: async () => ({ searchIn: "all" }),
  relistFilterVisibility: () => ({}),
}));
vi.mock("@/lib/jobs/cities", () => ({ loadCityGroups: async () => [] }));
vi.mock("@/lib/db/repos/listing", () => ({ listingReady: async () => false }));
vi.mock("@/lib/ghost/filter", () => ({ ghostFilterAvailable: async () => false }));
vi.mock("@/lib/visa/filter", () => ({ visaFilterAvailable: async () => false }));
vi.mock("@/lib/dashboard/context", () => ({ getSchedule: () => ({ timezone: "UTC" }) }));
vi.mock("@/lib/dashboard/list-viz", () => ({ loadListViz: () => ({}) }));
vi.mock("@/components/jobs/filter-bar", () => ({ FilterBar: () => null }));
vi.mock("@/components/jobs/save-view-button", () => ({ SaveViewButton: () => null }));
vi.mock("@/components/jobs/visit-tracker", () => ({ VisitTracker: () => null }));
vi.mock("@/components/jobs/pagination", () => ({ Pagination: () => null }));
vi.mock("@/components/jobs/to-list-items", () => ({ toListItems: async (jobs: unknown[]) => jobs }));
vi.mock("@/components/jobs/job-list", () => ({
  JobList: ({ jobs, empty }: { jobs: { id: number; title: string }[]; empty: ReactNode }) => (
    <div data-testid="job-list">{jobs.length ? jobs.map((job) => <div key={job.id}>{job.title}</div>) : empty}</div>
  ),
}));

import JobsPage from "@/app/jobs/page";
import { SearchTimeoutError } from "@/lib/db";

async function show() {
  render(
    <NextIntlClientProvider locale={state.locale} messages={state.locale === "en" ? en : zh}>
      {await JobsPage({ searchParams: Promise.resolve({ q: "engineer", searchIn: "all" }) })}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.locale = "en";
  state.listJobs.mockReset().mockResolvedValue({
    jobs: [{ id: 1, title: "Matching engineer", rank: null }], total: 1, page: 1, pageCount: 1, pageSize: 50,
  });
  state.countJobList.mockReset().mockResolvedValue(7);
  state.countJobListSeen.mockReset().mockResolvedValue({ unseen: 3, newSince: 2 });
});

describe.each(["en", "zh"] as const)("jobs search timeout feedback (%s)", (locale) => {
  it.each(["archive", "unread"] as const)("keeps results and marks the timed-out %s count unknown", async (failed) => {
    state.locale = locale;
    (failed === "archive" ? state.countJobList : state.countJobListSeen).mockRejectedValue(new SearchTimeoutError());
    await show();

    expect(screen.getByTestId("result-count")).toHaveTextContent(locale === "en" ? "Results: 1" : "共 1 条");
    expect(screen.getByText("Matching engineer")).toBeInTheDocument();
    const notice = screen.getByTestId("jobs-search-timeout");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent((locale === "en" ? en : zh).dashboard.jobs.searchTimeout);
    expect(screen.getByTestId("job-list")).not.toContainElement(notice);
    expect(notice.compareDocumentPosition(screen.getByTestId("job-list")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("scope-archive")).toHaveTextContent(
      locale === "en" ? `Archive (${failed === "archive" ? "—" : "7"})` : `历史库（${failed === "archive" ? "—" : "7"}）`,
    );
    if (failed === "unread") {
      expect(screen.getByTestId("unseen-count")).toHaveTextContent(locale === "en" ? "— unseen" : "— 条未看");
      expect(screen.queryByTestId("mark-all-seen")).not.toBeInTheDocument();
      expect(screen.queryByTestId("new-since-visit")).not.toBeInTheDocument();
    } else {
      expect(screen.getByTestId("unseen-count")).toHaveTextContent(locale === "en" ? "3 unseen" : "3 条未看");
    }
  });

  it("shows one notice and an unknown result count when the list times out", async () => {
    state.locale = locale;
    state.listJobs.mockRejectedValue(new SearchTimeoutError());
    await show();
    expect(screen.getAllByTestId("jobs-search-timeout")).toHaveLength(1);
    expect(screen.getByTestId("result-count")).toHaveTextContent(locale === "en" ? "Results: —" : "共 — 条");
    expect(screen.queryByTestId("job-list")).not.toBeInTheDocument();
  });
});

it("keeps real counts and omits the notice when every query succeeds", async () => {
  await show();
  expect(screen.queryByTestId("jobs-search-timeout")).not.toBeInTheDocument();
  expect(screen.getByTestId("scope-archive")).toHaveTextContent("Archive (7)");
  expect(screen.getByTestId("unseen-count")).toHaveTextContent("3 unseen");
});

it("propagates non-timeout failures", async () => {
  state.countJobList.mockRejectedValue(new Error("unavailable"));
  await expect(JobsPage({ searchParams: Promise.resolve({ q: "engineer", searchIn: "all" }) })).rejects.toThrow("unavailable");
});
