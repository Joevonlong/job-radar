import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { FilterReasonText, floorChanged } from "@/components/jobs/filter-reasons";
import { salaryFilteredIds } from "@/lib/jobs/filter-floors";

import en from "../messages/en.json";
import zh from "../messages/zh.json";

const show = (reasons: string[], floor: { atFilter: number | null; current: number | null } | undefined, locale: "zh" | "en" = "zh") =>
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      <FilterReasonText reasons={reasons} {...(floor ? { floor: { ...floor, currency: "EUR" } } : {})} />
    </NextIntlClientProvider>,
  ).container.textContent;

describe("the list's filter reason uses the detail page's wording", () => {
  it("names the floor of the time and says the floor has changed", () => {
    expect(show(["salary_below_floor:70000"], { atFilter: 80_000, current: 70_000 })).toBe("写明的薪资上限 €70k 低于当时的年薪底线 €80k 底线已改为 €70k，下一轮重新过滤。");
    expect(show(["salary_below_floor:70000"], { atFilter: 80_000, current: 70_000 }, "en")).toMatch(/floor/i);
  });

  it("when the floor did not change the reason stands alone", () => {
    expect(show(["salary_below_floor:70000"], { atFilter: 80_000, current: 80_000 })).toBe("写明的薪资上限 €70k 低于当时的年薪底线 €80k");
    expect(floorChanged(["salary_below_floor:70000"], { atFilter: 80_000, current: 80_000 })).toBe(false);
  });

  it("other reasons never get the floor sentence", () => {
    expect(show(["contract_excluded:internship"], { atFilter: 80_000, current: 70_000 })).not.toContain("底线已改为");
  });

  it("only jobs removed for their salary need the floor of the time", () => {
    const rank = (filterResult: "passed" | "filtered_out", filterReasons: string[]) => ({ rankValue: null, score: null, signalBonus: 0, filterResult, filterReasons, stale: false });
    expect(
      salaryFilteredIds([
        { id: 1, rank: rank("filtered_out", ["salary_below_floor:70000"]) },
        { id: 2, rank: rank("filtered_out", ["contract_excluded:internship"]) },
        { id: 3, rank: rank("passed", ["salary_below_floor:70000"]) },
        { id: 4, rank: null },
      ]),
    ).toEqual([1]);
  });
});
