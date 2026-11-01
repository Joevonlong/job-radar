import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { GermanPanel } from "@/components/jobs/detail/german-panel";
import { JobBadges } from "@/components/jobs/job-badges";
import type { JobListItem } from "@/components/jobs/types";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { BaseCurrencyProvider } from "@/components/base-currency";

const wrap = (node: ReactNode, locale: "en" | "zh" = "en") => (
  <BaseCurrencyProvider currency="EUR" language="de">
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
    {node}
  </NextIntlClientProvider>
  </BaseCurrencyProvider>
);

describe("GermanPanel", () => {
  const base = { level: "C1", rule: "C1", ai: "C1", source: "agree", penalty: 20, yours: "B1" } as const;

  it("shows the required level, the user's level and the points taken off", () => {
    render(wrap(<GermanPanel languageName="German" {...base} />));
    expect(screen.getByText("Requires German C1")).toBeInTheDocument();
    expect(screen.getByText("Your German: B1")).toBeInTheDocument();
    expect(screen.getByTestId("german-penalty")).toHaveTextContent("−20 points from the match score");
    expect(screen.getByText("Rule and AI agree.")).toBeInTheDocument();
  });

  it("says so when there is no deduction and the posting names no level", () => {
    render(wrap(<GermanPanel languageName="German" level="unknown" rule="unknown" ai="unknown" source="agree" penalty={0} yours={null} />));
    expect(screen.getByText("The posting states no German level")).toBeInTheDocument();
    expect(screen.getByTestId("german-penalty")).toHaveTextContent("No deduction");
    expect(screen.getByText("Your German: none")).toBeInTheDocument();
  });

  it("says German is only preferred, with no deduction and no 'requires' badge", () => {
    render(wrap(<GermanPanel languageName="German" level="preferred" rule="preferred" ai="unknown" source="rule" penalty={0} yours="B1" />));
    expect(screen.getByText("German is only preferred, not required")).toBeInTheDocument();
    expect(screen.queryByText(/Requires German/)).toBeNull();
    expect(screen.getByTestId("german-penalty")).toHaveTextContent("No deduction");
    expect(screen.getByText(/Pipeline rule: preferred/)).toBeInTheDocument();
  });

  it("shows both readings when they differ", () => {
    render(wrap(<GermanPanel languageName="German" level="C1" rule="B2" ai="C1" source="ai_explicit" penalty={20} yours="B1" />));
    expect(screen.getByText(/Pipeline rule: B2/)).toBeInTheDocument();
    expect(screen.getByText(/AI reading: C1/)).toBeInTheDocument();
    expect(screen.getByText(/the JD names the AI's level explicitly/)).toBeInTheDocument();
  });

  it("renders in Chinese", () => {
    render(wrap(<GermanPanel languageName="德语" {...base} />, "zh"));
    expect(screen.getByText("要求德语 C1")).toBeInTheDocument();
    expect(screen.getByTestId("german-penalty")).toHaveTextContent("匹配分扣 20 分");
  });
});

describe("German badge on rows", () => {
  const item = (german: JobListItem["germanLevelRequired"]): JobListItem => ({
    id: 1,
    title: "t",
    companyName: "c",
    locations: [],
    workplace: "unknown",
    contract: "unknown",
    isAgency: false,
    germanLevelRequired: german,
    jobStatus: "active",
    salaryDisclosed: false,
    salaryText: null,
    families: [],
    applicationStatus: null,
    rank: null,
    signals: [],
    timeLabel: "",
    timeTitle: "",
    posted: { day: "10/27", ago: "4 d", title: "", known: true },
  });

  it("flags a required level and stays quiet for none / unknown", () => {
    const { rerender } = render(wrap(<JobBadges job={item("C1")} />));
    expect(screen.getByText("German C1")).toBeInTheDocument();
    rerender(wrap(<JobBadges job={item("none")} />));
    expect(screen.queryByText(/German/)).toBeNull();
    rerender(wrap(<JobBadges job={item("unknown")} />));
    expect(screen.queryByText(/German/)).toBeNull();
  });
});
