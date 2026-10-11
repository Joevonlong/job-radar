import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ClampedQuote } from "@/components/jobs/detail/clamped-quote";
import { CompPanel } from "@/components/jobs/detail/comp-panel";
import { HeaderTags } from "@/components/jobs/detail/header-tags";
import { ScoreCard } from "@/components/jobs/detail/score-card";
import { StatusJumpLink, STATUS_SELECT_ID } from "@/components/jobs/detail/status-panel";
import { FilterNotice, FilterOverrideAction } from "@/components/jobs/filter-notice";
import { FloorPreview } from "@/components/profile/floor-preview";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { defaultCategoryViews } from "../signals/helpers";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/jobs/[id]/filter-actions", () => ({ setFilterOverrideAction: vi.fn() }));
vi.mock("@/app/jobs/[id]/actions", () => ({ setApplicationStatusAction: vi.fn(), saveApplicationNotesAction: vi.fn() }));

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
);

describe("HeaderTags", () => {
  const base = { salaryDisclosed: true, germanLevelRequired: "none" as const, isAgency: false, contract: "permanent", categories: defaultCategoryViews() };

  it("has no T1 tag: the amount category is the salary axis; keyword categories and the tags stay (retired ones not)", () => {
    render(
      wrap(
        <HeaderTags
          {...base}
          signals={[
            { tier: "T1", kind: "salary_range" },
            { tier: "T2", kind: "equity" },
            { tier: "T4", kind: "bonus" },
            { tier: "tag", kind: "30 days" },
            { tier: "visa", kind: "visa" },
          ]}
        />,
      ),
    );
    const tiers = screen.getAllByTestId("header-tag").map((tag) => tag.getAttribute("data-tier"));
    expect(tiers).toEqual(["T2", "T4", "tag"]);
    expect(screen.queryByText(/T1/)).toBeNull();
  });

  it("writes the German hard gate with a '!' on the red tag", () => {
    render(wrap(<HeaderTags {...base} signals={[]} germanLevelRequired="B2" languageName="German" />));
    const gate = screen.getByTestId("header-tag-german");
    expect(gate).toHaveTextContent("! German B2");
    expect(gate.querySelector("b")).toHaveAttribute("aria-hidden", "true");
  });

  it("does not call a salary 'not disclosed' when the JD states an amount", () => {
    render(wrap(<HeaderTags {...base} salaryDisclosed={false} signals={[{ tier: "T1", kind: "salary_range" }]} />));
    expect(screen.queryByTestId("header-tag-salary-unknown")).toBeNull();
  });
});

describe("ScoreCard unscored state", () => {
  const props = { jobId: 1, pushLine: 70, bonusCap: 15, scoreNow: null, scoredWhen: null };

  it("is one dashed box with a small —/100, not an empty meter and an empty bar", () => {
    const { container } = render(wrap(<ScoreCard {...props} score={null} />));
    const box = container.querySelector('[data-rank="pending"]') as HTMLElement;
    expect(box).toHaveTextContent("—/100");
    expect(box).toHaveTextContent("Not scored");
    expect(box).toHaveTextContent("waiting for AI scoring");
    expect(box.className).toContain("border-dashed");
    expect(screen.queryByRole("meter")).toBeNull();
    expect(container.querySelector(".jr-segm")).toBeNull();
    expect(container.querySelector(".jr-comp")).toBeNull();
  });

  it("keeps the 'score now' button below the box", () => {
    render(wrap(<ScoreCard {...props} score={null} scoreNow={<button type="button">Score now</button>} />));
    expect(screen.getByRole("button", { name: "Score now" })).toBeInTheDocument();
  });
});

describe("ClampedQuote toggle", () => {
  it("is ink text with an underline, never the yellow as text colour", () => {
    render(wrap(<ClampedQuote text={"word ".repeat(80)} term={null} color="teal" expandLabel="Expand" collapseLabel="Collapse" />));
    const toggle = screen.getByRole("button", { name: "Expand" });
    expect(toggle.className).toContain("text-ink");
    expect(toggle.className).toContain("underline");
    expect(toggle.className).not.toMatch(/(^|\s)text-primary(\s|$)/);
  });
});

describe("CompPanel salary format", () => {
  const bonus = { categories: [{ id: "T1", points: 10 }], sum: 10, bonus: 10, cap: 15, capped: false };
  const panel = { signals: [], categories: defaultCategoryViews(), bonus, scan: { aiReviewed: true }, language: "en" as const, salaryDisclosed: true };

  it("writes the converted EUR figure on its own line, in whole k behind ≈", () => {
    render(wrap(<CompPanel {...panel} salary={{ normalized: "$150–180k /yr", eurApprox: "≈ €139–163k /yr", raw: "USD 150,000 - 180,000", periodAssumed: false }} />));
    expect(screen.getByTestId("salary-normalized")).toHaveTextContent("$150–180k /yr");
    expect(screen.getByTestId("salary-eur-approx")).toHaveTextContent("≈ €139–163k /yr");
    // the raw quote stays verbatim
    expect(screen.getByTestId("salary-raw")).toHaveTextContent("USD 150,000 - 180,000");
  });

  it("says the bonus total once: the cap bar is the line, no second text line repeats it", () => {
    const signals = [{ id: 1, tier: "T1" as const, kind: "salary_range", value: { min: 90000, max: 110000, currency: "EUR" }, quote: "EUR 90,000 to 110,000", extractor: "rule" as const }];
    render(wrap(<CompPanel {...panel} signals={signals} salary={null} />));
    expect(screen.getAllByTestId("bonus-line")).toHaveLength(1);
    expect(screen.getByTestId("cap-bar")).toContainElement(screen.getByTestId("bonus-line"));
    expect(screen.queryByText(/= 10 →/)).toBeNull();
  });
});

describe("FilterNotice floor context", () => {
  const rank = { filterResult: "filtered_out" as const, filterReasons: ["salary_below_floor:70000"] };

  it("names the floor used at filter time", () => {
    render(wrap(<FilterNotice rank={rank} floor={{ atFilter: 80000, current: 80000, currency: "EUR" }} />));
    expect(screen.getByTestId("filter-banner")).toHaveTextContent("Stated salary cap €70k was below your floor of €80k at the time");
    expect(screen.queryByTestId("filter-floor-changed")).toBeNull();
  });

  it("says the floor changed since and that the next cycle filters again", () => {
    render(wrap(<FilterNotice rank={rank} floor={{ atFilter: 80000, current: 70000, currency: "EUR" }} />, "zh"));
    expect(screen.getByTestId("filter-banner")).toHaveTextContent("当时的年薪底线 €80k");
    expect(screen.getByTestId("filter-floor-changed")).toHaveTextContent("底线已改为 €70k，下一轮重新过滤");
  });

  it("without the snapshot, infers the change from a cap that now clears the floor", () => {
    render(wrap(<FilterNotice rank={rank} floor={{ atFilter: null, current: 60000, currency: "EUR" }} />));
    expect(screen.getByTestId("filter-floor-changed")).toHaveTextContent("The floor is now €60k");
    expect(screen.getByTestId("filter-banner")).toHaveTextContent("Stated salary cap €70k is below your floor");
  });

  it("stays quiet when the floor is unknown or the cap is still below it", () => {
    const { rerender } = render(wrap(<FilterNotice rank={rank} floor={{ atFilter: null, current: 80000, currency: "EUR" }} />));
    expect(screen.queryByTestId("filter-floor-changed")).toBeNull();
    rerender(wrap(<FilterNotice rank={rank} floor={{ atFilter: null, current: null, currency: "EUR" }} />));
    expect(screen.queryByTestId("filter-floor-changed")).toBeNull();
  });

  it("can leave the button to the header actions", () => {
    render(
      wrap(
        <>
          <FilterNotice rank={rank} jobId={8} withButton={false} />
          <div data-testid="actions">
            <FilterOverrideAction rank={rank} jobId={8} />
          </div>
        </>,
      ),
    );
    expect(screen.getByTestId("filter-banner").querySelector("button")).toBeNull();
    expect(screen.getByTestId("actions")).toContainElement(screen.getByTestId("filter-override-keep"));
  });
});

describe("StatusJumpLink", () => {
  it("moves the focus to the status select", () => {
    render(
      <>
        <StatusJumpLink testId="jump">Status</StatusJumpLink>
        <select id={STATUS_SELECT_ID} data-testid="sel" />
      </>,
    );
    // jsdom has no layout: say the select is shown
    vi.spyOn(screen.getByTestId("sel"), "getClientRects").mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
    // the click is not left to the anchor jump (it would reset the focus)
    expect(fireEvent.click(screen.getByTestId("jump"))).toBe(false);
    expect(screen.getByTestId("sel")).toHaveFocus();
    expect(screen.getByTestId("jump")).toHaveAttribute("href", "#h-act");
  });

  it("leaves the anchor jump to the browser when the select is not shown", () => {
    render(
      <>
        <StatusJumpLink testId="jump">Status</StatusJumpLink>
        <select id={STATUS_SELECT_ID} data-testid="sel" />
      </>,
    );
    expect(fireEvent.click(screen.getByTestId("jump"))).toBe(true);
  });
});

describe("FloorPreview median and other-region salaries", () => {
  const axis = { minK: 40, maxK: 200, tickStepK: 20, currency: "EUR" };
  const salaries = [
    { min: 60_000, max: 80_000 },
    { min: 90_000, max: 110_000 },
    { min: 150_000, max: 180_000, otherRegion: true },
  ];

  it("labels the median with its scope and count, from the shared definition", () => {
    render(wrap(<FloorPreview salaries={salaries} axis={axis} median={{ value: 95_000, count: 8, minSample: 5 }} floorText="85000" inputId="f" onFloorChange={() => {}} />, "zh"));
    expect(screen.getByTestId("floor-median")).toHaveTextContent("中位 · 本月 8 个：€95k");
    expect(screen.getByTestId("floor-median")).toHaveAttribute("data-count", "8");
  });

  it("shows no median below the minimum sample, and says so", () => {
    render(wrap(<FloorPreview salaries={salaries} axis={axis} median={{ value: null, count: 3, minSample: 5 }} floorText="85000" inputId="f" onFloorChange={() => {}} />, "zh"));
    expect(screen.getByTestId("floor-median")).toHaveTextContent("中位 · 本月 3 个：不足 5 个，不显示");
  });

  it("still counts an other-region salary in the drop figure (the filter does), marks its cell and keeps it out of the block", () => {
    const { container } = render(wrap(<FloorPreview salaries={salaries} axis={axis} median={{ value: 95_000, count: 2, minSample: 2 }} floorText="85000" inputId="f" onFloorChange={() => {}} />, "zh"));
    // 60-80k and (90-110k stays); the 150-180k one is not below 85k: one dropped of three
    expect(screen.getByTestId("floor-drop")).toHaveAttribute("data-total", "3");
    expect(screen.getByTestId("floor-drop")).toHaveAttribute("data-filtered", "1");
    expect(container.querySelectorAll('[data-other-region="true"]')).toHaveLength(1);
    expect(screen.getByTestId("floor-other-region")).toHaveTextContent("其中 1 个可能是其他地区的薪资");
    // the axis block spans the local salaries only (up to 110k), not the 180k of the other region
    expect(container.querySelector(".jr-sax")?.getAttribute("aria-label")).toContain("110");
    expect(container.querySelector(".jr-sax")?.getAttribute("aria-label")).not.toContain("180");
  });
});
