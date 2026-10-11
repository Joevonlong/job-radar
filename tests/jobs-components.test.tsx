import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { JobBadges } from "@/components/jobs/job-badges";
import type { JobListItem } from "@/components/jobs/types";
import { RankValue } from "@/components/jobs/rank-value";
import { SignalBadge } from "@/components/jobs/signal-badge";
import { SourceIcon } from "@/components/jobs/source-icons";
import { VisaBadge } from "@/components/jobs/visa-badge";
import en from "../messages/en.json";
import { listSignal } from "./signals/helpers";
import { BaseCurrencyProvider } from "@/components/base-currency";

const wrap = (node: ReactNode) => (
  <BaseCurrencyProvider currency="EUR" language="de">
    <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
  </BaseCurrencyProvider>
);

describe("SignalBadge", () => {
  it.each(["T1", "T2", "T3", "T4", "tag", "visa"])("renders category %s", (tier) => {
    render(
      <SignalBadge tier={tier} color="violet">
        label
      </SignalBadge>,
    );
    expect(screen.getByText("label").closest("[data-slot=signal-badge]")).toHaveAttribute("data-tier", tier);
  });

  it("uses the light-theme-safe text token of the category colour", () => {
    render(
      <SignalBadge tier="T3" color="coral">
        x
      </SignalBadge>,
    );
    expect(screen.getByText("x").closest("[data-slot=signal-badge]")?.className).toContain("text-signal-t3-text");
  });
});

describe("VisaBadge", () => {
  it("says support in green and a refusal in a dashed red outline, by kind", () => {
    const { rerender } = render(wrap(<VisaBadge visa={{ status: "offered", kind: null }} />));
    expect(screen.getByTestId("visa-badge")).toHaveTextContent(en.visa.badge.offered);
    expect(screen.getByTestId("visa-badge").className).toContain("text-good");
    rerender(wrap(<VisaBadge visa={{ status: "not_offered", kind: "permit_required" }} />));
    expect(screen.getByTestId("visa-badge")).toHaveTextContent(en.visa.badge.permit_required);
    expect(screen.getByTestId("visa-badge")).toHaveAttribute("data-kind", "permit_required");
    expect(screen.getByTestId("visa-badge").className).toContain("border-dashed");
    rerender(wrap(<VisaBadge visa={{ status: "not_offered", kind: "no_sponsorship" }} />));
    expect(screen.getByTestId("visa-badge")).toHaveTextContent(en.visa.badge.no_sponsorship);
    expect(screen.getByTestId("visa-badge")).toHaveAttribute("title", en.visa.badgeTitle.no_sponsorship);
  });
});

describe("RankValue", () => {
  it("says it is waiting for AI when there is no score", () => {
    render(wrap(<RankValue rank={null} />));
    expect(screen.getByText(/waiting for AI/)).toBeInTheDocument();
  });

  it("colours by band and shows the breakdown", () => {
    const rank = { rankValue: 97, score: 82, signalBonus: 15, filterResult: "passed" as const, filterReasons: [], stale: false };
    const { container } = render(wrap(<RankValue rank={rank} />));
    expect(container.querySelector("[data-rank=top]")).not.toBeNull();
    expect(screen.getByText("97")).toHaveClass("text-score-top-text");
    expect(screen.getByText("= 82 + 15")).toBeInTheDocument();
  });

  it("says waiting for AI, not outdated, for a passed job whose row has no score yet", () => {
    const rank = { rankValue: null, score: null, signalBonus: 0, filterResult: "passed" as const, filterReasons: [], stale: true };
    const { container } = render(wrap(<RankValue rank={rank} />));
    expect(screen.getByText(/waiting for AI/)).toBeInTheDocument();
    expect(container.querySelector("[data-rank=pending]")).not.toBeNull();
    expect(screen.queryByTestId("rank-stale")).toBeNull();
  });

  it("marks an old score as outdated", () => {
    const rank = { rankValue: 70, score: 70, signalBonus: 0, filterResult: "passed" as const, filterReasons: [], stale: true };
    render(wrap(<RankValue rank={rank} />));
    expect(screen.getByTestId("rank-stale")).toHaveTextContent("outdated");
  });

  it("shows hard-filtered jobs as not ranked", () => {
    const rank = { rankValue: null, score: null, signalBonus: 0, filterResult: "filtered_out" as const, filterReasons: ["x"], stale: false };
    render(wrap(<RankValue rank={rank} />));
    expect(screen.getByText("not ranked")).toBeInTheDocument();
  });
});

describe("SourceIcon", () => {
  it("names the family for assistive tech and falls back for unknown families", () => {
    render(wrap(<SourceIcon family="ats" />));
    expect(screen.getByText("Company ATS")).toBeInTheDocument();
    render(wrap(<SourceIcon family="newboard" />));
    expect(screen.getByText("newboard")).toBeInTheDocument();
  });
});

const item = (over: Partial<JobListItem> = {}): JobListItem => ({
  id: 1,
  title: "t",
  companyName: "c",
  locations: [],
  workplace: "unknown",
  contract: "unknown",
  isAgency: false,
  germanLevelRequired: "unknown",
  jobStatus: "active",
  salaryDisclosed: false,
  salaryText: null,
  families: [],
  applicationStatus: null,
  rank: null,
  signals: [],
  timeLabel: "",
  timeTitle: "",
  ...over,
});

describe("JobBadges", () => {
  it("shows the dashed unknown badge when no salary is stated, never a salary (C3)", () => {
    render(wrap(<JobBadges job={item()} />));
    expect(screen.getByText(/Salary not disclosed/)).toBeInTheDocument();
  });

  it("shows agency, freelance and the German requirement from the pipeline flags", () => {
    render(wrap(<JobBadges job={item({ isAgency: true, contract: "freelance", germanLevelRequired: "B2" })} />));
    expect(screen.getByText("Agency")).toBeInTheDocument();
    expect(screen.getByText("Freelance")).toBeInTheDocument();
    expect(screen.getByText("German B2")).toBeInTheDocument();
  });

  it("does not flag German when the posting says it is not needed or says nothing", () => {
    const { rerender } = render(wrap(<JobBadges job={item({ germanLevelRequired: "none" })} />));
    expect(screen.queryByText(/German/)).toBeNull();
    rerender(wrap(<JobBadges job={item({ germanLevelRequired: "unknown" })} />));
    expect(screen.queryByText(/German/)).toBeNull();
  });

  it("does not flag German as required when it is only preferred", () => {
    render(wrap(<JobBadges job={item({ germanLevelRequired: "preferred" })} />));
    expect(screen.queryByText(/German/)).toBeNull();
  });

  it("shows the stated salary as one 💰 annual range when there is no amount signal", () => {
    const { container } = render(wrap(<JobBadges job={item({ salaryDisclosed: true, salaryText: "€85–105k" })} />));
    const badge = container.querySelector("[data-slot=fact-badge]");
    expect(badge).toHaveTextContent("💰€85–105k");
    expect(screen.queryByText(/Salary not disclosed/)).toBeNull();
  });

  it("writes the same normalized range on the pay-signal badge, not the amount found in the text", () => {
    const signal = listSignal("T1", "salary_range", { min: 60000, max: 80000, currency: "EUR" });
    const { container } = render(wrap(<JobBadges job={item({ salaryDisclosed: true, salaryText: "€85–105k", signals: [signal] })} />));
    const badges = container.querySelectorAll("[data-slot=signal-badge]");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("💰€85–105k");
    expect(container.querySelector("[data-slot=fact-badge]")).toBeNull();
  });

  it("shows no salary at all, and not 'not disclosed', when the posting states one that is under review", () => {
    const { container } = render(wrap(<JobBadges job={item({ salaryDisclosed: true, salaryText: null })} />));
    expect(container.textContent).not.toMatch(/💰|Salary/);
  });
});

describe("AI trap badge", () => {
  it("comes first, says ×N for several, and explains itself", () => {
    render(wrap(<JobBadges job={item({ trapCount: 3, isAgency: true })} />));
    const badges = screen.getByTestId("trap-badge").parentElement?.children;
    expect(badges?.[0]).toBe(screen.getByTestId("trap-badge"));
    expect(screen.getByTestId("trap-badge")).toHaveTextContent("AI trap ×3");
    expect(screen.getByTestId("trap-badge")).toHaveAttribute("title", "The JD holds 3 traps aimed at AI; open the job to see");
  });

  it("is absent without traps", () => {
    render(wrap(<JobBadges job={item({ trapCount: 0 })} />));
    expect(screen.queryByTestId("trap-badge")).toBeNull();
    render(wrap(<JobBadges job={item({ trapCount: 1 })} />));
    expect(screen.getByTestId("trap-badge")).toHaveTextContent(/^AI trap$/);
  });
});
