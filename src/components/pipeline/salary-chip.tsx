"use client";

import { useTranslations } from "next-intl";

import { useAppLocale } from "@/components/viz/intl";
import { salaryState } from "@/components/viz";
import { formatSalary } from "@/lib/format/numbers";
import { cn } from "@/lib/utils";

import type { BoardSalary } from "./salary";

interface SalaryChipProps {
  salary: BoardSalary | null;
  /** EUR a year below which a stated amount is shown muted (`amountMinAnnualEur`). */
  floor?: number | null | undefined;
  className?: string;
}

/**
 * Salary of a card or the drawer (design "board card"): a stated range is a yellow mono chip, a range under the floor or
 * probably another region's pay is a grey chip, nothing stated is a dashed box. The text is `formatSalary`, never local.
 */
export function SalaryChip({ salary, floor, className }: SalaryChipProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const state = salary ? salaryState({ min: salary.min, max: salary.max, floor, otherRegion: salary.otherRegion }) : "none";
  const text = salary ? formatSalary({ min: salary.min, max: salary.max, currency: salary.currency, approx: salary.approx || salary.otherRegion }, { locale }) : null;
  if (state === "none" || text === null) {
    return (
      <span className={cn("border-ink text-data-sm rounded-cell border-bw inline-flex items-center border-dashed px-1 font-mono", className)} data-slot="card-salary" data-salary="none">
        {t("undisclosed")}
      </span>
    );
  }
  return (
    <span
      className={cn("rounded-cell border-ink text-data inline-flex items-center border px-1 font-mono", state === "stated" ? "bg-hi text-hi-ink font-bold" : "bg-soft text-ink-3", className)}
      data-slot="card-salary"
      data-salary={state === "stated" ? "stated" : "muted"}
    >
      {text}
    </span>
  );
}
