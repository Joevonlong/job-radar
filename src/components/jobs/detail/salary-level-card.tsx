import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { useAppLocale } from "@/components/viz/intl";
import { buttonVariants } from "@/components/ui/button";
import type { Locale } from "@/i18n/locale";
import { formatSalary, intlLocale } from "@/lib/format/numbers";
import type { SalaryContext } from "@/lib/salary/view";
import { cn } from "@/lib/utils";

import { PlaceholderBox } from "./panel";

const KNOWN_SENIORITIES = ["entry", "mid", "senior", "lead"] as const;
type KnownSeniority = (typeof KNOWN_SENIORITIES)[number];
const knownSeniority = (value: string | null): KnownSeniority | null => KNOWN_SENIORITIES.find((s) => s === value) ?? null;

/** One amount, the way the salary card writes it ("€85k"). */
export function formatAmount(value: number, currency: string, locale: Locale): string {
  return formatSalary({ min: value, max: value, currency }, { locale }) ?? "";
}

/** "DE" -> "Germany" in the page's language (the code itself when the runtime has no name for it). */
function regionName(code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames([intlLocale(locale)], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Where a value sits on the P10..P90 track, in percent (the job's own figure may lie outside it). */
function trackPosition(value: number, low: number, high: number): number {
  if (high <= low) return 50;
  return Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
}

/**
 * The "Salary level" card: the job's stated salary within the postings of its role family in the database (the
 * narrowest group with enough of them), the company's other stated salaries, and links to search salary sites. Server
 * component; `getSalaryContext` reads everything.
 */
export function SalaryLevelCard({ context }: { context: SalaryContext }) {
  const t = useTranslations("salary.level");
  const tSeniority = useTranslations("salary.seniority");
  const locale = useAppLocale();
  const money = (value: number): string => formatAmount(value, context.currency, locale);

  let comparison;
  if (context.state === "config_error") comparison = <PlaceholderBox testId="salary-level-config-error">{t("configError")}</PlaceholderBox>;
  else if (context.state === "not_ready") comparison = <PlaceholderBox testId="salary-level-not-ready">{t("notReady")}</PlaceholderBox>;
  else if (context.currency === "") comparison = <PlaceholderBox testId="salary-level-no-currency">{t("noCurrency")}</PlaceholderBox>;
  else if (context.familyId === null) comparison = <PlaceholderBox testId="salary-level-no-family">{t("noFamily")}</PlaceholderBox>;
  else if (context.staleAi && !context.benchmarkEnabled) comparison = null;
  else if (context.group === null && !context.benchmarkComputed) comparison = <PlaceholderBox testId="salary-level-not-computed">{t("notComputed")}</PlaceholderBox>;
  else if (context.group === null) comparison = <PlaceholderBox testId="salary-level-no-group">{t("noGroup", { min: context.company?.minSample ?? 0 })}</PlaceholderBox>;
  else {
    const group = context.group;
    const seniority = knownSeniority(group.seniority);
    const place = group.place === null ? "" : group.level === "city" ? group.place : regionName(group.place, locale);
    const groupLine = t(`group.${group.level}`, { family: context.familyLabel ?? context.familyId, seniority: seniority ? tSeniority(seniority) : "", place });
    const sample = t("sample", { n: group.n });
    const p10 = group.quantiles[0] ?? group.median;
    const p90 = group.quantiles[group.quantiles.length - 1] ?? group.median;
    const low = Math.min(p10, context.figure ?? p10);
    const high = Math.max(p90, context.figure ?? p90);
    const position = context.position;
    const p = position ? Math.round(position.value) : null;
    const positionText =
      position && context.figure !== null
        ? position.clamp === "below"
          ? t("positionBelow", { amount: money(context.figure) })
          : position.clamp === "above"
            ? t("positionAbove", { amount: money(context.figure) })
            : t("positionText", { amount: money(context.figure), p: p ?? 0 })
        : null;
    comparison = (
      <div className="flex flex-col gap-3" data-testid="salary-level-group" data-level={group.level}>
        <p className="text-ink-2 text-data font-mono [overflow-wrap:anywhere]" data-testid="salary-level-group-line">
          {groupLine} · {sample}
        </p>
        {positionText ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-display text-h1 leading-none" data-testid="salary-level-percentile" data-clamp={position?.clamp ?? "none"}>
              {position?.clamp === "below" ? "<" : position?.clamp === "above" ? ">" : ""}
              {t("position", { p: p ?? 0 })}
            </span>
            <span className="text-body-sm">{positionText}</span>
          </div>
        ) : (
          <p className="text-muted-foreground text-body-sm" data-testid="salary-level-no-figure">
            {t("noFigure")}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <div className="relative h-5" role="img" aria-label={t("rangeLabel")}>
            <div className="bg-soft border-border rounded-pill absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 border-[1.5px]" aria-hidden />
            <div
              className="bg-ink-3/45 absolute top-1/2 h-2.5 -translate-y-1/2"
              style={{ left: `${trackPosition(p10, low, high)}%`, right: `${100 - trackPosition(p90, low, high)}%` }}
              aria-hidden
            />
            <div className="bg-ink-3 absolute top-0 h-5 w-0.5 border-dashed" style={{ left: `${trackPosition(group.median, low, high)}%` }} aria-hidden />
            {context.figure !== null ? (
              <div className="bg-hi border-border absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: `${trackPosition(context.figure, low, high)}%` }} aria-hidden data-testid="salary-level-marker" />
            ) : null}
          </div>
          <p className="text-ink-2 text-data font-mono" data-testid="salary-level-median">
            {t("median", { amount: money(group.median) })} · {t("range", { low: money(p10), high: money(p90) })}
          </p>
        </div>
      </div>
    );
  }

  const company = context.state === "ok" && context.currency !== "" ? context.company : null;
  return (
    <div className="flex flex-col gap-4" data-testid="salary-level-card" data-state={context.state}>
      {context.state === "ok" && !context.benchmarkEnabled ? (
        <p className="text-ink-3 text-body-sm" data-testid={context.staleAi ? "salary-level-stale-ai" : "salary-level-benchmark-off"}>
          {t(context.staleAi ? "staleAi" : "benchmarkOff")}
        </p>
      ) : null}
      {comparison}
      {company ? (
        <section className="flex flex-col gap-1" aria-labelledby="salary-level-company">
          <h3 id="salary-level-company" className="text-cap text-ink-3 text-cap-style">
            {t("companyHeading")}
          </h3>
          <p className="text-body-sm" data-testid="salary-level-company" data-count={company.count}>
            {company.median !== null ? t("company", { count: company.count, amount: money(company.median) }) : t("companyFew", { count: company.count, min: company.minSample })}
          </p>
        </section>
      ) : null}
      <section className="flex flex-col gap-1.5" aria-labelledby="salary-level-links">
        <h3 id="salary-level-links" className="text-cap text-ink-3 text-cap-style">
          {t("linksHeading")}
        </h3>
        {context.links.length > 0 ? (
          <ul className="flex flex-wrap gap-2" data-testid="salary-level-links">
            {context.links.map((link) => (
              <li key={link.id}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("linkTitle", { site: link.label })}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                  data-testid={`salary-link-${link.id}`}
                >
                  {link.label}
                  <ExternalLink aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-3 text-body-sm">{t("noLinks")}</p>
        )}
      </section>
    </div>
  );
}
