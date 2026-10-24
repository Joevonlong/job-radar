import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { CompanyTable } from "@/components/companies/company-table";
import { CompanySortControls } from "@/components/companies/sort-controls";
import { Pagination } from "@/components/jobs/pagination";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadCompanyOverview } from "@/lib/companies/overview";
import { serializeCompaniesParams } from "@/lib/companies/search-params";
import { getSchedule } from "@/lib/dashboard/context";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.companies");
  return { title: t("title") };
}

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [overview, t, tPage] = await Promise.all([loadCompanyOverview(searchParams), getTranslations("companies"), getTranslations("pages.companies")]);
  const { rows, params, total, page, pageCount, excludedCount } = overview;
  const { timezone } = getSchedule();

  return (
    <div data-wide className="flex min-w-0 flex-col gap-sp-4">
      <PageHeader title={tPage("title")} description={tPage("description")} />
      <form action="/companies" method="get" className="flex min-w-0 items-end gap-2" role="search" aria-label={t("searchLabel")}>
        <div className="min-w-0 flex-1">
          <label htmlFor="company-search" className="mb-1 block text-label font-bold">{t("searchLabel")}</label>
          <Input key={params.q} id="company-search" name="q" type="search" defaultValue={params.q} maxLength={MAX_FILTER_VALUE_CHARS} placeholder={t("searchPlaceholder")} />
        </div>
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="dir" value={params.dir} />
        <Button type="submit">{t("search")}</Button>
      </form>
      <CompanySortControls params={params} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span role="status" className="font-mono text-data text-ink-2" data-testid="companies-count">{t("count", { count: total })}</span>
        <Link href="/me#exclude-companies" className="text-body-sm underline underline-offset-4 hover:bg-hi">{t("excludedNote", { count: excludedCount })}</Link>
      </div>
      <CompanyTable rows={rows} params={params} now={new Date()} timezone={timezone} />
      <Pagination page={page} pageCount={pageCount} hrefFor={(next) => serializeCompaniesParams("/companies", { ...params, page: next })} />
    </div>
  );
}
