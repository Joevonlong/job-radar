import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { SalaryLevelCard } from "@/components/jobs/detail/salary-level-card";
import type { SalaryContext } from "@/lib/salary/view";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const context = (over: Partial<SalaryContext> = {}): SalaryContext => ({
  state: "ok", currency: "EUR", familyId: "software", familyLabel: "Software",
  figure: 90000, group: null, position: null,
  company: { count: 3, median: 90000, minSample: 2 }, links: [],
  staleAi: false, benchmarkEnabled: true, benchmarkComputed: false,
  lookup: { availability: "disabled", unrestricted: false, providers: [], latest: null, initialRequest: null, usedToday: 0, maxPerDay: 3, ttlDays: 30 },
  ...over,
});

describe.each(["en", "zh"] as const)("SalaryLevelCard (%s)", (locale) => {
  const messages = locale === "en" ? en : zh;
  const show = (over: Partial<SalaryContext> = {}) => render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <SalaryLevelCard context={context(over)} />
    </NextIntlClientProvider>,
  );

  it("shows the posting sample count without splitting out lookup figures", () => {
    show({ benchmarkComputed: true, group: { level: "family", seniority: null, place: null, n: 3, median: 90000, quantiles: [80000, 90000, 100000] } });
    const line = screen.getByTestId("salary-level-group-line");
    expect(line).toHaveTextContent(locale === "en" ? / · 3 postings$/ : / · 样本 3$/);
    expect(line).not.toHaveTextContent(/JD|AI|查询|lookup/i);
  });

  it("explains stale AI figures when the benchmark is off without promising an automatic rebuild", () => {
    show({ staleAi: true, benchmarkEnabled: false });
    expect(screen.getByTestId("salary-level-stale-ai")).toHaveTextContent(locale === "en"
      ? "The old salary comparison contained AI figures and is hidden. Turn the salary benchmark on and the next cycle rebuilds it."
      : "旧的薪资对比含 AI 数字，已隐藏；打开薪资基准后，下一轮会重新计算。");
    expect(screen.queryByTestId("salary-level-not-computed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("salary-level-benchmark-off")).not.toBeInTheDocument();
    expect(screen.queryByTestId("salary-level-group")).not.toBeInTheDocument();
    expect(screen.getByTestId("salary-level-company")).toBeVisible();
  });

  it("shows not computed for stale AI figures when the benchmark is on", () => {
    show({ staleAi: true });
    expect(screen.getByTestId("salary-level-not-computed")).toHaveTextContent(messages.salary.level.notComputed);
    expect(screen.queryByTestId("salary-level-stale-ai")).not.toBeInTheDocument();
    expect(screen.queryByTestId("salary-level-benchmark-off")).not.toBeInTheDocument();
  });

  it.each([
    { over: { familyId: null }, id: "salary-level-no-family" },
    { over: { currency: "", familyId: null }, id: "salary-level-no-currency" },
  ])("keeps $id ahead of the stale comparison state", ({ over, id }) => {
    show({ ...over, staleAi: true, benchmarkEnabled: false });
    expect(screen.getByTestId("salary-level-stale-ai")).toBeVisible();
    expect(screen.getByTestId(id)).toBeVisible();
    expect(screen.queryByTestId("salary-level-not-computed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("salary-level-benchmark-off")).not.toBeInTheDocument();
  });

  it.each(["config_error", "not_ready"] as const)("keeps %s ahead of missing currency, family and stale figures", (state) => {
    show({ state, currency: "", familyId: null, staleAi: true, benchmarkEnabled: false });
    expect(screen.getByTestId(state === "config_error" ? "salary-level-config-error" : "salary-level-not-ready")).toBeVisible();
    expect(screen.queryByTestId("salary-level-no-currency")).not.toBeInTheDocument();
    expect(screen.queryByTestId("salary-level-no-family")).not.toBeInTheDocument();
    expect(screen.queryByTestId("salary-level-stale-ai")).not.toBeInTheDocument();
  });

  it("keeps the ordinary benchmark-off message when there are no stale AI figures", () => {
    show({ benchmarkEnabled: false });
    expect(screen.getByTestId("salary-level-benchmark-off")).toHaveTextContent(messages.salary.level.benchmarkOff);
    expect(screen.queryByTestId("salary-level-stale-ai")).not.toBeInTheDocument();
    expect(screen.getByTestId("salary-level-not-computed")).toBeVisible();
  });
});
