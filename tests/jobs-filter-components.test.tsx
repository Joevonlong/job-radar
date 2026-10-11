import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilterNotice } from "@/components/jobs/filter-notice";
import { FilterReasonText } from "@/components/jobs/filter-reasons";
import { JobRow, type JobListViz } from "@/components/jobs/job-row";
import type { JobListItem } from "@/components/jobs/types";
import { FilteredToggle } from "@/components/jobs/filtered-toggle";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { EXCLUDE_REASON_CODES, NOTE_CODES } from "@/lib/filter/reasons";

const { setFilterOverrideAction } = vi.hoisted(() => ({ setFilterOverrideAction: vi.fn() }));
vi.mock("@/app/jobs/[id]/filter-actions", () => ({ setFilterOverrideAction }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

describe("FilterReasonText", () => {
  it("localizes codes and their details", () => {
    const { container } = render(
      wrap(<FilterReasonText reasons={["salary_below_floor:58000", "contract_excluded:temp_agency", "blacklist_keyword:Rust", "workplace_not_wanted:onsite"]} floor={{ atFilter: null, current: null, currency: "EUR" }} />),
    );
    expect(container.textContent).toBe(
      "Stated salary cap €58k is below your floor; Contract type excluded: Temp agency; Blacklisted keyword: Rust; Work mode not wanted: onsite",
    );
  });

  it("speaks Chinese", () => {
    const { container } = render(wrap(<FilterReasonText reasons={["student_role", "location_not_allowed:Hamburg"]} />, "zh"));
    expect(container.textContent).toBe("学生 / 实习岗位; 地点不在目标范围内：Hamburg");
  });

  it("shows a text that is not a code as it is, and the fallback when there is none", () => {
    const { container } = render(wrap(<FilterReasonText reasons={["Student position"]} />));
    expect(container.textContent).toBe("Student position");
    const empty = render(wrap(<FilterReasonText reasons={[]} fallback="none" />));
    expect(empty.container.textContent).toBe("none");
  });

  it("has a message for every code in both languages", () => {
    for (const code of [...EXCLUDE_REASON_CODES, ...NOTE_CODES]) {
      expect(Object.keys(en.filter.reasons)).toContain(code);
      expect(Object.keys(zh.filter.reasons)).toContain(code);
    }
  });
});

describe("FilterNotice", () => {
  it("explains a filtered job", () => {
    render(wrap(<FilterNotice rank={{ filterResult: "filtered_out", filterReasons: ["student_role"] }} />));
    expect(screen.getByTestId("filter-banner")).toHaveTextContent("Hard-filtered: Student or internship role.");
  });

  it("says when no reason was recorded", () => {
    render(wrap(<FilterNotice rank={{ filterResult: "filtered_out", filterReasons: [] }} />));
    expect(screen.getByTestId("filter-banner")).toHaveTextContent("no reason recorded");
  });

  it("notes what a kept job leaves open, and is silent otherwise", () => {
    const { container, rerender } = render(wrap(<FilterNotice rank={{ filterResult: "passed", filterReasons: ["remote_scope_unknown"] }} />));
    expect(screen.getByTestId("filter-note")).toHaveTextContent("Kept, but note: Remote, but the posting does not say where it can hire.");
    rerender(wrap(<FilterNotice rank={{ filterResult: "passed", filterReasons: [] }} />));
    expect(container.textContent).toBe("");
    rerender(wrap(<FilterNotice rank={null} />));
    expect(container.textContent).toBe("");
  });
});

const viz: JobListViz = { pushLine: 70,
  bonusCap: 15, floor: null, salaryAxis: { minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" }, freshness: { decayHours: 72, warnHours: 24 }, nowIso: "2026-10-08T12:00:00.000Z", timezone: "Europe/Berlin" };
const MainCell = ({ job }: { job: JobListItem }) => <JobRow job={job} favorite={false} seen index={0} active stagger={false} viz={viz} onFocusRow={() => undefined} onAction={() => undefined} />;

describe("row filter notes", () => {
  const item = (reasons: string[], filterResult: "passed" | "filtered_out" = "passed"): JobListItem => ({
    id: 1,
    title: "Forward Deployed Engineer",
    companyName: "Primer.ai",
    locations: ["Germany"],
    workplace: "unknown",
    contract: "permanent",
    isAgency: false,
    germanLevelRequired: "unknown",
    jobStatus: "active",
    salaryDisclosed: false,
    salaryText: null,
    families: [],
    applicationStatus: null,
    rank: { rankValue: null, score: null, signalBonus: 0, filterResult, filterReasons: reasons, stale: false },
    signals: [],
    timeLabel: "",
    timeTitle: "",
  });

  it("says on the row that a kept job has only a country as its place", () => {
    render(wrap(<MainCell job={item(["location_country_level:Germany"])} />));
    expect(screen.getByText(/only a country or region \(Germany\)/)).toBeInTheDocument();
  });

  it("shows no note for a clean job and the rule reasons for a filtered one", () => {
    const { container, rerender } = render(wrap(<MainCell job={item([])} />));
    expect(container.querySelector("[data-slot=filter-notes]")).toBeNull();
    rerender(wrap(<MainCell job={item(["override_exclude"], "filtered_out")} />));
    expect(container.querySelector("[data-slot=filter-reasons]")).toHaveTextContent("You excluded this job");
  });
});

describe("FilterNotice override buttons", () => {
  beforeEach(() => setFilterOverrideAction.mockReset().mockResolvedValue({ ok: true, filterResult: "passed" }));

  it("offers to keep a filtered job and sends the decision", async () => {
    render(wrap(<FilterNotice jobId={361} rank={{ filterResult: "filtered_out", filterReasons: ["location_not_allowed:Garching"] }} />));
    expect(screen.getByTestId("filter-banner")).toHaveTextContent("Hard-filtered: Location not on your list: Garching.");
    fireEvent.click(screen.getByTestId("filter-override-keep"));
    await waitFor(() => expect(setFilterOverrideAction).toHaveBeenCalledWith({ jobId: 361, action: "keep" }));
  });

  it("says what the rules would have done for a job the user kept, and lets the user take it back", async () => {
    render(wrap(<FilterNotice jobId={361} rank={{ filterResult: "passed", filterReasons: ["override_keep", "location_not_allowed:Garching"] }} />));
    expect(screen.getByTestId("filter-note")).toHaveTextContent("You chose to keep this job. The rules would have said: Location not on your list: Garching.");
    fireEvent.click(screen.getByTestId("filter-override-clear"));
    await waitFor(() => expect(setFilterOverrideAction).toHaveBeenCalledWith({ jobId: 361, action: "clear" }));
  });

  it("offers to exclude a clean job, and to take back an exclusion", async () => {
    const { rerender } = render(wrap(<FilterNotice jobId={7} rank={{ filterResult: "passed", filterReasons: [] }} />));
    fireEvent.click(screen.getByTestId("filter-override-exclude"));
    await waitFor(() => expect(setFilterOverrideAction).toHaveBeenCalledWith({ jobId: 7, action: "exclude" }));
    rerender(wrap(<FilterNotice jobId={7} rank={{ filterResult: "filtered_out", filterReasons: ["override_exclude"] }} />));
    expect(screen.getByTestId("filter-banner")).toHaveTextContent("You excluded this job.");
    expect(screen.getByTestId("filter-override-clear")).toBeInTheDocument();
  });

  it("shows the country-level note of a kept job next to the button", () => {
    render(wrap(<FilterNotice jobId={410} rank={{ filterResult: "passed", filterReasons: ["location_country_level:Germany"] }} />));
    expect(screen.getByTestId("filter-note")).toHaveTextContent("The location is only a country or region (Germany); the job may be anywhere in it");
    expect(screen.getByTestId("filter-override-exclude")).toBeInTheDocument();
  });
});

describe("FilteredToggle", () => {
  it("offers to show or hide, linking to the flipped URL", () => {
    const { rerender } = render(wrap(<FilteredToggle active={false} href="/jobs?filtered=true" />));
    expect(screen.getByTestId("toggle-filtered")).toHaveTextContent("Show filtered");
    expect(screen.getByTestId("toggle-filtered")).toHaveAttribute("href", "/jobs?filtered=true");
    rerender(wrap(<FilteredToggle active href="/jobs" />));
    // on: a yellow chip that says what is applied; its link and its × both lift the filter
    expect(screen.getByTestId("toggle-filtered")).toHaveTextContent("Showing filtered");
    expect(screen.getByTestId("toggle-filtered")).toHaveAttribute("href", "/jobs");
    expect(screen.getByRole("button", { name: "Hide filtered" })).toBeInTheDocument();
  });
});
