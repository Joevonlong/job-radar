"use client";

import { ExternalLink } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { useAppLocale } from "@/components/viz/intl";
import { fitSalaryAxis, salaryState, type SalaryAxisScale } from "@/components/viz/salary-shared";
import type { Locale } from "@/i18n/locale";
import { isApproxAnnual } from "@/lib/dashboard/salary";
import { baseRangeIn } from "@/lib/domain/salary";
import type { JobSalary } from "@/lib/domain/types";
import { formatSalary, intlLocale } from "@/lib/format/numbers";
import type { SalaryBand } from "@/lib/salary/lookup-types";
import type { SalaryContext } from "@/lib/salary/view";
import { cn } from "@/lib/utils";

import { Panel, PanelAside } from "./panel";
import { aiResultOf, groupFigures, groupRowIsCombined, groupStatus, rulerFigures, versusMedian, type AiResult, type GroupStatus } from "./salary-panel-model";
import { SalaryRuler, type LaneMark, type RulerLane } from "./salary-ruler";
import { LookupActions, LookupDetails, useSalaryLookup } from "./salary-lookup";

export interface SalaryPanelProps {
  context: SalaryContext;
  salary: JobSalary | null;
  /** `salary_json` exists (maybe unreadable). */
  salaryDisclosed: boolean;
  /** The posting's salary as text (`describeSalary`), for a salary that has no figure in the base currency to draw. */
  normalizedText: string | null;
  /** `preferences.yaml: salary_floor_year`; null when it cannot be read. */
  floor: number | null;
  /** The configured scale (`ui.yaml: salary_axis`); the ruler narrows it to the figures it draws. */
  axis: SalaryAxisScale;
  jobId: number;
  company: string;
  timeZone: string;
}

const KNOWN_SENIORITIES = ["entry", "mid", "senior", "lead"] as const;
type KnownSeniority = (typeof KNOWN_SENIORITIES)[number];
const knownSeniority = (value: string | null): KnownSeniority | null => KNOWN_SENIORITIES.find((s) => s === value) ?? null;

/** "DE" -> "Germany" in the page's language (the code itself when the runtime has no name for it). */
function regionName(code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames([intlLocale(locale)], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

type JdKind = "figure" | "none" | "unreadable" | "review" | "other";

/** One of the three cells on top: a label, one big figure or reason, a line under it. */
function HeadCell({ testId, label, tone, children }: { testId: string; label: string; tone?: "hi"; children: ReactNode }) {
  return (
    <div className={cn("border-bw border-border rounded-card flex min-w-0 flex-col gap-1 px-3 py-2.5", tone === "hi" ? "bg-hi text-hi-ink" : "bg-card-bg")} data-testid={testId}>
      <p className={cn("text-cap text-cap-style", tone === "hi" ? "text-hi-ink" : "text-ink-3")}>{label}</p>
      {children}
    </div>
  );
}

const Big = ({ children, muted, testId }: { children: ReactNode; muted?: boolean; testId?: string }) => (
  <p className={cn("font-display text-num-m [overflow-wrap:anywhere]", muted && "text-ink-3 !text-title-sm")} data-testid={testId}>
    {children}
  </p>
);

const Sub = ({ children, testId, tone }: { children: ReactNode; testId?: string; tone?: "hi" }) => (
  <p className={cn("text-body-sm [overflow-wrap:anywhere]", tone === "hi" ? "text-hi-ink" : "text-ink-2")} data-testid={testId}>
    {children}
  </p>
);

function Unverified({ label }: { label: string }) {
  return <span className="border-ink-3 text-ink-2 text-data rounded-tag w-fit border border-dashed px-1.5 font-mono">{label}</span>;
}

/**
 * The job page's one salary panel: three figures on top (what the posting states, the median of similar postings, the AI's
 * estimate for this company), every source on one shared scale underneath, the stored AI result in full, and a footer with where
 * the AI figures come from, the lookup button and the links to search elsewhere. The AI's numbers are drawn as unverified
 * estimates and never enter the comparison with the posting. A client component: the lookup is a state machine that follows the
 * queued request; `SalaryContext` and the figures it needs are plain data.
 */
export function SalaryPanel({ context, salary, salaryDisclosed, normalizedText, floor, axis: configuredAxis, jobId, company, timeZone }: SalaryPanelProps) {
  const t = useTranslations("salary.panel");
  const tLevel = useTranslations("salary.level");
  const tLookup = useTranslations("salary.lookup");
  const tSeniority = useTranslations("salary.seniority");
  const format = useFormatter();
  const locale = useAppLocale();
  const currency = context.currency;
  const money = (value: number, cur: string = currency): string => formatSalary({ min: value, max: value, currency: cur }, { locale }) ?? "";
  const { lookup: lookupInfo } = context;
  const latest = lookupInfo.latest;
  const lookup = useSalaryLookup({
    jobId,
    availability: lookupInfo.availability,
    providers: lookupInfo.providers,
    latest,
    initialRequest: lookupInfo.initialRequest,
    usedToday: lookupInfo.usedToday,
    maxPerDay: lookupInfo.maxPerDay,
    timeZone,
  });
  const looking = lookup.busy && latest === null;

  // ---- the posting's own salary (as the year card above: a salary to be reviewed is not drawn)
  const range = salary && salary.qualityStatus !== "review" ? baseRangeIn(salary, currency) : null;
  const jdMin = range?.min ?? null;
  const jdMax = range?.max ?? null;
  const hasFigure = jdMin !== null || jdMax !== null;
  const otherRegion = Boolean(salary?.otherRegion);
  const jdKind: JdKind =
    salary === null ? (salaryDisclosed ? "unreadable" : "none") : salary.qualityStatus === "review" ? "review" : otherRegion ? "other" : hasFigure ? "figure" : normalizedText !== null ? "other" : "unreadable";
  const approx = salary !== null && isApproxAnnual(salary, "base");
  const jdText = jdKind === "figure" ? formatSalary({ min: jdMin, max: jdMax, currency, approx }, { locale }) : null;

  // ---- the benchmark group and the company's other postings
  const status = groupStatus(context);
  const combined = groupRowIsCombined(context);
  const group = status === "group" ? context.group : null;
  const company_ = combined ? null : context.company;
  const companyPoints = groupFigures(company_?.figures ?? []);

  // ---- the AI result: only the role's own band is drawn
  const ai = aiResultOf(latest);

  // ---- one scale for everything that is drawn
  const axis = fitSalaryAxis(
    rulerFigures({ jd: jdKind === "figure" ? { min: jdMin, max: jdMax } : null, group, company: company_?.figures ?? [], ai, floor: currency === "" ? null : floor }),
    configuredAxis,
  );

  // ---------------------------------------------------------------- head cells
  const vs = jdKind === "figure" && group ? versusMedian(context.figure, group.median) : null;
  const jdHead = (() => {
    switch (jdKind) {
      case "figure":
        return (
          <>
            <Big testId="salary-head-jd-figure">
              {jdText}
              <small className="text-data ml-1 font-mono font-normal">{t("head.perYear")}</small>
            </Big>
            {vs !== null ? (
              <Sub tone="hi" testId="salary-head-jd-vs">
                {vs === 0 ? t("head.vsEqual") : vs > 0 ? t("head.vsAbove", { percent: vs }) : t("head.vsBelow", { percent: -vs })}
              </Sub>
            ) : null}
          </>
        );
      case "other":
        return (
          <>
            <Big muted testId="salary-head-jd-text">{normalizedText}</Big>
            <Sub>{t("head.jdOther")}</Sub>
          </>
        );
      case "review":
        return <Big muted>{t("head.jdReview")}</Big>;
      case "unreadable":
        return <Big muted>{t("head.jdUnreadable")}</Big>;
      default:
        return <Big muted>{t("head.jdNone")}</Big>;
    }
  })();

  const groupReason: Record<Exclude<GroupStatus, "group">, { head: string; text: string; testId: string }> = {
    config_error: { head: t("head.groupConfigError"), text: tLevel("configError"), testId: "salary-level-config-error" },
    not_ready: { head: t("head.groupNotReady"), text: tLevel("notReady"), testId: "salary-level-not-ready" },
    no_currency: { head: t("head.groupNoCurrency"), text: tLevel("noCurrency"), testId: "salary-level-no-currency" },
    no_family: { head: t("head.groupNoFamily"), text: tLevel("noFamily"), testId: "salary-level-no-family" },
    stale: { head: t("head.groupStale"), text: tLevel("staleAi"), testId: "salary-level-stale-ai" },
    not_computed: { head: t("head.groupNotComputed"), text: tLevel("notComputed"), testId: "salary-level-not-computed" },
    no_group: { head: t("head.groupNoGroup"), text: tLevel("noGroup", { min: context.company?.minSample ?? 0 }), testId: "salary-level-no-group" },
  };

  const position = context.position;
  const p = position ? Math.round(position.value) : null;
  const positionText =
    group && position && context.figure !== null
      ? position.clamp === "below"
        ? tLevel("positionBelow", { amount: money(context.figure) })
        : position.clamp === "above"
          ? tLevel("positionAbove", { amount: money(context.figure) })
          : tLevel("positionText", { amount: money(context.figure), p: p ?? 0 })
      : null;
  const groupHead =
    group !== null ? (
      <>
        <Big testId="salary-head-group-median">{t("head.groupMedian", { amount: money(group.median) })}</Big>
        {positionText ? (
          <Sub testId="salary-head-group-position">
            <span data-clamp={position?.clamp ?? "none"} data-testid="salary-head-group-clamp">
              {positionText}
            </span>
          </Sub>
        ) : (
          <Sub testId="salary-level-no-figure">{tLevel("noFigure")}</Sub>
        )}
      </>
    ) : (
      <Big muted>{groupReason[status === "group" ? "no_group" : status].head}</Big>
    );

  const bandOriginal = (band: SalaryBand): string | null => formatSalary({ min: band.original.min, max: band.original.max, currency: band.original.currency ?? "" }, { locale });
  const companyLine = (result: NonNullable<typeof latest>["result"]): string => {
    const parts = [t("head.aiCompany", { level: tLookup(`companyLevel.${result.companyLevel.level}`) })];
    if (result.companyLevel.median !== null) parts.push(t("head.aiCompanyMedian", { amount: money(result.companyLevel.median) }));
    return parts.join(" · ");
  };
  const aiHead = (() => {
    if (looking) return <Big muted>{t("head.aiLooking")}</Big>;
    if (latest === null) {
      const key = { enabled: "aiNotLooked", disabled: "aiOff", no_web_provider: "aiNoProvider", config_error: "aiUnavailable", not_ready: "aiUnavailable" } as const;
      return <Big muted>{t(`head.${key[lookupInfo.availability]}`)}</Big>;
    }
    const result = latest.result;
    return (
      <>
        {ai.kind === "band" ? (
          <>
            <Big testId="salary-head-ai-figure">{formatSalary({ min: ai.min, max: ai.max, currency }, { locale }) ?? money(ai.median ?? 0)}</Big>
            {ai.band.basis !== "base" ? (
              <p className="text-ink-2 text-body-sm font-semibold" data-testid="salary-head-ai-basis" data-basis={ai.band.basis}>
                {tLookup(`basis.${ai.band.basis}`)}
              </p>
            ) : null}
            <Sub>{companyLine(result)}</Sub>
          </>
        ) : ai.kind === "text_only" ? (
          <>
            <Big testId="salary-head-ai-figure">{bandOriginal(ai.band) ?? t("head.aiNoBand")}</Big>
            <Sub>{tLookup("notConvertible", { currency: ai.band.original.currency ?? "?" })}</Sub>
          </>
        ) : ai.kind === "no_band" ? (
          <>
            <Big muted>{t("head.aiNoBand")}</Big>
            <Sub>{companyLine(result)}</Sub>
          </>
        ) : (
          <Big muted>{t("head.aiEmpty")}</Big>
        )}
        <Unverified label={t("unverified")} />
      </>
    );
  })();

  // ---------------------------------------------------------------- ruler rows
  const lanes: RulerLane[] = [];

  const jdMarks: LaneMark[] = jdKind === "figure" ? [{ type: "span", min: jdMin, max: jdMax, tone: salaryState({ min: jdMin, max: jdMax, floor: currency === "" ? null : floor }) === "below_floor" ? "jd-muted" : "jd", testId: "salary-lane-jd-block" }] : [];
  lanes.push({
    kind: "jd",
    state: jdKind === "figure" ? "drawn" : jdKind,
    label: t("lane.jd.label"),
    source: t("lane.jd.source"),
    values: jdKind === "figure" ? `${jdText ?? ""}${t("head.perYear")}` : jdKind === "other" ? normalizedText : null,
    reason: jdKind === "figure" ? null : jdKind === "other" ? t("lane.jd.other") : t(`lane.jd.${jdKind}`),
    marks: jdMarks,
  });

  if (combined) {
    const reason = groupReason[status === "group" ? "no_group" : status];
    lanes.push({ kind: "group", state: status, label: t("lane.groupCompany.label"), source: "", values: null, reason: reason.text, reasonTestId: reason.testId, marks: [] });
  } else {
    if (group) {
      const seniority = knownSeniority(group.seniority);
      const place = group.place === null ? "" : group.level === "city" ? group.place : regionName(group.place, locale);
      const groupLine = tLevel(`group.${group.level}`, { family: context.familyLabel ?? context.familyId ?? "", seniority: seniority ? tSeniority(seniority) : "", place });
      const p10 = group.quantiles[0] ?? group.median;
      const p90 = group.quantiles[group.quantiles.length - 1] ?? group.median;
      lanes.push({
        kind: "group",
        state: "drawn",
        label: t("lane.group.label"),
        source: `${groupLine} · ${tLevel("sample", { n: group.n })}`,
        values: t("lane.group.values", { median: money(group.median), low: money(p10), high: money(p90) }),
        reason: null,
        marks: [{ type: "span", min: p10, max: p90, tone: "group" }, { type: "median", value: group.median }],
        data: { level: group.level },
      });
    } else {
      const reason = groupReason[status === "group" ? "no_group" : status];
      lanes.push({ kind: "group", state: status, label: t("lane.group.label"), source: "", values: null, reason: reason.text, reasonTestId: reason.testId, marks: [] });
    }
    const count = company_?.count ?? 0;
    const list = companyPoints.map((point) => `${money(point.value)}${point.count > 1 ? ` ×${point.count}` : ""}`).join(t("sep.list"));
    lanes.push({
      kind: "company",
      state: count === 0 ? "none" : company_?.median != null ? "drawn" : "few",
      label: t("lane.company.label"),
      source: t("lane.company.source", { count }),
      values:
        count === 0
          ? null
          : `${t("lane.company.values", { count, list })}${t("sep.clause")}${company_?.median != null ? t("lane.company.median", { amount: money(company_.median) }) : t("lane.company.few", { min: company_?.minSample ?? 0 })}`,
      reason: count === 0 ? t("lane.company.none") : null,
      reasonTestId: "salary-level-company",
      marks: count === 0 ? [] : [...(company_?.median != null ? ([{ type: "median", value: company_.median }] as LaneMark[]) : []), { type: "points", points: companyPoints }],
      data: { count: String(count) },
    });
  }

  lanes.push(aiLane(ai, { latest, looking, availability: lookupInfo.availability, jobId, currency, money, bandOriginal, t, tLookup, locale }));

  const drawn = lanes.filter((lane) => lane.reason === null && lane.marks.length > 0).length;

  // the benchmark note under the ruler: the comparison may be old (switched off), or is hidden because it held AI figures
  const benchmarkNote = context.state === "ok" && !context.benchmarkEnabled && status !== "stale" ? (context.staleAi ? "salary-level-stale-ai" : "salary-level-benchmark-off") : null;

  // ---------------------------------------------------------------- footer
  const sites = latest ? [...new Set(latest.result.sources.map((source) => source.host))].slice(0, 3).join(t("sep.list")) : "";
  const meta = latest
    ? [latest.provider, latest.model, format.dateTime(new Date(latest.fetchedAt), { dateStyle: "medium", timeStyle: "short", timeZone })].filter((part): part is string => part !== null && part !== "").join(" · ")
    : "";

  return (
    <Panel id="h-pay" title={t("title")} aside={<PanelAside>{t("aside", { count: drawn })}</PanelAside>}>
      <div className="flex min-w-0 flex-col gap-4" data-testid="salary-panel" data-level-state={context.state} data-lookup-state={lookup.state} data-job-id={jobId}>
        <div className="grid gap-3 sm:grid-cols-3">
          <HeadCell testId="salary-head-jd" label={t("head.jd")} tone={jdKind === "figure" ? "hi" : undefined}>
            {jdHead}
          </HeadCell>
          <HeadCell testId="salary-head-group" label={t("head.group")}>
            {groupHead}
          </HeadCell>
          <HeadCell testId="salary-head-ai" label={t("head.ai")}>
            {aiHead}
          </HeadCell>
        </div>

        <SalaryRuler lanes={lanes} axis={axis} label={t("ruler.label")} floor={currency !== "" && floor !== null ? { amount: floor, text: t("ruler.floor", { amount: money(floor) }) } : null}>
          {benchmarkNote ? (
            <p className="text-ink-3 text-body-sm" data-testid={benchmarkNote}>
              {tLevel(context.staleAi ? "staleAi" : "benchmarkOff")}
            </p>
          ) : null}
        </SalaryRuler>

        {latest ? <LookupDetails jobId={jobId} latest={latest} currency={currency} groupQuantiles={group?.quantiles ?? null} timeZone={timeZone} ttlDays={lookupInfo.ttlDays} busy={lookup.busy} /> : null}

        <div className="border-border grid gap-4 border-t-[1.5px] pt-3.5 md:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-1.5" aria-labelledby="salary-foot-sources" data-testid="salary-foot-sources">
            <h3 id="salary-foot-sources" className="text-cap text-ink-3 text-cap-style">
              {t("foot.sourcesHeading")}
            </h3>
            {latest ? (
              <>
                <p className="text-body-sm [overflow-wrap:anywhere]" data-testid="salary-foot-summary">
                  {t("foot.sources", { count: latest.result.sources.length, sites: sites === "" ? "none" : sites, meta })}
                </p>
                <p className="text-ink-3 text-body-sm">{t("foot.sent")}</p>
              </>
            ) : (
              <p className="text-ink-3 text-body-sm">{t("foot.noSources")}</p>
            )}
          </section>
          <div className="flex min-w-0 flex-col gap-3">
            <section className="flex flex-col gap-1.5" aria-labelledby="salary-foot-actions">
              <h3 id="salary-foot-actions" className="text-cap text-ink-3 text-cap-style">
                {t("foot.actionsHeading")}
              </h3>
              <LookupActions lookup={lookup} availability={lookupInfo.availability} hasResult={latest !== null} company={company} unrestricted={lookupInfo.unrestricted} timeZone={timeZone} />
            </section>
            <section className="flex flex-col gap-1.5" aria-labelledby="salary-foot-links">
              <h3 id="salary-foot-links" className="text-cap text-ink-3 text-cap-style">
                {t("foot.linksHeading")}
              </h3>
              {context.links.length > 0 ? (
                <ul className="flex flex-wrap gap-2" data-testid="salary-level-links">
                  {context.links.map((link) => (
                    <li key={link.id}>
                      <a href={link.url} target="_blank" rel="noopener noreferrer" title={tLevel("linkTitle", { site: link.label })} className={cn(buttonVariants({ variant: "outline", size: "sm" }))} data-testid={`salary-link-${link.id}`}>
                        {link.label}
                        <ExternalLink aria-hidden />
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-3 text-body-sm">{tLevel("noLinks")}</p>
              )}
            </section>
          </div>
        </div>
      </div>
    </Panel>
  );
}

type T = ReturnType<typeof useTranslations<"salary.panel">>;
type TLookup = ReturnType<typeof useTranslations<"salary.lookup">>;

/** The fourth row: this role's band from the AI lookup, drawn hatched (dotted for total pay) and marked unverified. */
function aiLane(
  ai: AiResult,
  ctx: {
    latest: NonNullable<SalaryContext["lookup"]["latest"]> | null;
    looking: boolean;
    availability: SalaryContext["lookup"]["availability"];
    jobId: number;
    currency: string;
    money: (value: number, cur?: string) => string;
    bandOriginal: (band: SalaryBand) => string | null;
    t: T;
    tLookup: TLookup;
    locale: Locale;
  },
): RulerLane {
  const { latest, t } = ctx;
  const sourceParts = [t("lane.ai.source")];
  if (ai.kind === "band" || ai.kind === "text_only") {
    if (ai.band.basis === "total") sourceParts.push(t("lane.ai.total"));
    if (ai.band.basis === "unknown") sourceParts.push(t("lane.ai.unknownBasis"));
  }
  if (latest?.expired) sourceParts.push(t("lane.ai.expired"));
  if (latest && latest.origin?.jobId !== ctx.jobId) sourceParts.push(t("lane.ai.otherPosting"));
  const base = { kind: "ai" as const, label: t("lane.ai.label"), source: sourceParts.join(" · ") };

  if (ai.kind === "band") {
    const tone = ai.band.basis === "total" ? "ai-total" : "ai";
    const marks: LaneMark[] = [];
    if (ai.min !== null || ai.max !== null) marks.push({ type: "span", min: ai.min, max: ai.max, tone, testId: "salary-lane-ai-block" });
    if (ai.median !== null) marks.push({ type: "median", value: ai.median });
    const rangeText = formatSalary({ min: ai.min, max: ai.max, currency: ctx.currency }, { locale: ctx.locale });
    const values = [rangeText, ai.median !== null ? t("lane.ai.median", { amount: ctx.money(ai.median) }) : null].filter((part): part is string => part !== null).join(t("sep.clause"));
    return { ...base, state: "drawn", values, reason: null, marks, data: { basis: ai.band.basis } };
  }
  if (ai.kind === "text_only") {
    return { ...base, state: "not_convertible", values: ctx.bandOriginal(ai.band), reason: ctx.tLookup("notConvertible", { currency: ai.band.original.currency ?? "?" }), marks: [] };
  }
  if (ai.kind === "no_band") return { ...base, state: "no_band", values: null, reason: t("lane.ai.noBand"), marks: [] };
  if (ai.kind === "empty") return { ...base, state: "empty", values: null, reason: t("lane.ai.empty"), marks: [] };
  const [state, key] = ctx.looking
    ? (["looking", "looking"] as const)
    : ctx.availability === "enabled"
      ? (["not_looked", "notLooked"] as const)
      : ctx.availability === "disabled"
        ? (["disabled", "off"] as const)
        : ctx.availability === "no_web_provider"
          ? (["no_web_provider", "noProvider"] as const)
          : ([ctx.availability, "unavailable"] as const);
  return { ...base, state, values: null, reason: t(`lane.ai.${key}`), marks: [] };
}
