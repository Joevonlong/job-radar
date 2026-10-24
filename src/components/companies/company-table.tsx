import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { resolveLocale } from "@/i18n/locale";
import type { CompanyOverviewItem } from "@/lib/companies/overview";
import { COMPANY_SORTS, serializeCompaniesParams, type CompaniesSearchParams } from "@/lib/companies/search-params";
import { formatInteger, formatScoreValue, UNKNOWN } from "@/lib/format/numbers";
import { formatFullTime, formatRelativeTime } from "@/lib/format/time";

import { WatchToggle } from "./watch-toggle";

interface CompanyTableProps {
  rows: readonly CompanyOverviewItem[];
  params: CompaniesSearchParams;
  now: Date;
  timezone: string;
}

const linkClass = "font-bold underline decoration-2 underline-offset-4 hover:bg-hi";

function CompanyName({ row }: { row: CompanyOverviewItem }) {
  return row.href ? <Link href={row.href} className={linkClass}>{row.name}</Link> : <span className="font-bold">{row.name}</span>;
}

function CompanyStatus({ row }: { row: CompanyOverviewItem }) {
  const t = useTranslations("companies");
  return (
    <div className="flex flex-wrap gap-2 text-body-sm">
      {row.watched ? <span className="rounded-tag border border-border px-2 py-1">{t("watched")}</span> : null}
      {row.excluded ? <span className="rounded-tag border border-dashed border-border px-2 py-1">{t("excluded")}</span> : null}
      {!row.watched && !row.excluded ? <span className="text-ink-3"><span aria-hidden>{UNKNOWN}</span><span className="sr-only">{t("none")}</span></span> : null}
    </div>
  );
}

function CompanyActions({ row }: { row: CompanyOverviewItem }) {
  const t = useTranslations("companies");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <WatchToggle row={row} />
      {!row.excluded ? <Link href="/me#exclude-companies" className={`${linkClass} inline-flex min-h-8 items-center text-body-sm`}>{t("exclude")}</Link> : null}
    </div>
  );
}

/** Table on wide screens, cards below sm; both use the server's links and watch-list entries. */
export function CompanyTable({ rows, params, now, timezone }: CompanyTableProps) {
  const t = useTranslations("companies");
  const locale = resolveLocale(useLocale());
  const timeOptions = { locale, timeZone: timezone };
  const score = (row: CompanyOverviewItem) => formatScoreValue(row.topRank, Infinity);
  const latest = (row: CompanyOverviewItem) => (
    <time dateTime={row.lastFirstSeenAt.toISOString()} title={formatFullTime(row.lastFirstSeenAt, timeOptions)}>
      {formatRelativeTime(row.lastFirstSeenAt, now, timeOptions)}
    </time>
  );

  if (rows.length === 0) return <p className="rounded-card border border-dashed border-border p-sp-4 text-body text-ink-2" data-testid="companies-empty">{t("empty")}</p>;

  return (
    <>
      <div className="hidden sm:block">
        <table className="w-full table-fixed text-left text-body-sm" aria-label={t("listLabel")}>
          <thead className="border-b-bw border-border text-label">
            <tr>
              <th scope="col" className="w-1/4 px-2 py-3">{t("columns.company")}</th>
              {COMPANY_SORTS.map((sort) => {
                const active = params.sort === sort;
                const Icon = active ? (params.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                return (
                  <th key={sort} scope="col" aria-sort={active ? (params.dir === "asc" ? "ascending" : "descending") : undefined} className="px-2 py-3">
                    <Link href={serializeCompaniesParams("/companies", { ...params, sort, dir: active && params.dir === "desc" ? "asc" : "desc", page: 1 })} className="inline-flex min-h-8 items-center gap-1 hover:underline">
                      {t(`columns.${sort}`)}<Icon className="size-3 shrink-0" aria-hidden />
                    </Link>
                  </th>
                );
              })}
              <th scope="col" className="px-2 py-3">{t("columns.status")}</th>
              <th scope="col" className="w-1/5 px-2 py-3">{t("columns.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id} data-testid="company-row" className="align-top hover:bg-muted/50">
                <th scope="row" className="wrap-anywhere px-2 py-4"><CompanyName row={row} /></th>
                <td className="px-2 py-4 font-mono tabular-nums" data-column="jobs">{formatInteger(row.jobCount, locale)}</td>
                <td className="px-2 py-4 font-mono tabular-nums" data-column="score">{score(row)}</td>
                <td className="px-2 py-4 font-mono text-data-sm">{latest(row)}</td>
                <td className="wrap-anywhere px-2 py-4"><CompanyStatus row={row} /></td>
                <td className="wrap-anywhere px-2 py-4"><CompanyActions row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex min-w-0 flex-col gap-sp-3 sm:hidden" aria-label={t("listLabel")} data-testid="company-cards">
        {rows.map((row) => (
          <li key={row.id} className="min-w-0 rounded-card border border-border bg-card p-sp-3" data-testid="company-card">
            <h2 className="wrap-anywhere text-body"><CompanyName row={row} /></h2>
            <dl className="my-sp-3 grid grid-cols-2 gap-3 text-body-sm">
              <div><dt className="text-ink-2">{t("columns.jobs")}</dt><dd className="font-mono tabular-nums">{formatInteger(row.jobCount, locale)}</dd></div>
              <div><dt className="text-ink-2">{t("columns.score")}</dt><dd className="font-mono tabular-nums">{score(row)}</dd></div>
              <div className="col-span-2"><dt className="text-ink-2">{t("columns.recent")}</dt><dd className="font-mono">{latest(row)}</dd></div>
            </dl>
            {row.watched || row.excluded ? <div className="mb-sp-3"><CompanyStatus row={row} /></div> : null}
            <CompanyActions row={row} />
          </li>
        ))}
      </ul>
    </>
  );
}
