"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { COMPANY_SORTS, serializeCompaniesParams, type CompaniesSearchParams } from "@/lib/companies/search-params";

export function CompanySortControls({ params }: { params: CompaniesSearchParams }) {
  const t = useTranslations("companies");
  const router = useRouter();
  const id = useId();
  const directionLabel = t(params.dir === "asc" ? "dirAscLabel" : "dirDescLabel");

  return (
    <div className="flex min-w-0 items-end gap-1.5 sm:hidden">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="mb-1 block text-label font-bold">{t("sort")}</label>
        <Select
          id={id}
          size="lg"
          value={params.sort}
          onChange={(event) => router.push(serializeCompaniesParams("/companies", { ...params, sort: COMPANY_SORTS.find((sort) => sort === event.target.value) ?? "jobs", dir: "desc", page: 1 }))}
        >
          {COMPANY_SORTS.map((sort) => <option key={sort} value={sort}>{t(`sorts.${sort}`)}</option>)}
        </Select>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        className="shrink-0"
        aria-label={directionLabel}
        title={directionLabel}
        onClick={() => router.push(serializeCompaniesParams("/companies", { ...params, dir: params.dir === "asc" ? "desc" : "asc", page: 1 }))}
      >
        {params.dir === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
      </Button>
    </div>
  );
}
