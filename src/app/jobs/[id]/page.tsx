import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { companyJobsHref } from "@/lib/jobs/company-link";

import { BackLink } from "@/components/jobs/detail/back-link";
import { BreakdownPanel } from "@/components/jobs/detail/breakdown-panel";
import { ChecksPanel } from "@/components/jobs/detail/checks-panel";
import { EVIDENCE_QUOTE, GHOST_QUOTE, TRAP_QUOTE, VISA_QUOTE } from "@/components/jobs/detail/marks";
import { ReasonSource } from "@/components/jobs/detail/reason-source";
import { CompPanel } from "@/components/jobs/detail/comp-panel";
import { GermanPanel } from "@/components/jobs/detail/german-panel";
import { JdPanel } from "@/components/jobs/detail/jd-panel";
import { HeaderTags } from "@/components/jobs/detail/header-tags";
import { PlaceholderBox, Panel, PanelAside } from "@/components/jobs/detail/panel";
import { SalaryCard } from "@/components/jobs/detail/salary-card";
import { SalaryPanel } from "@/components/jobs/detail/salary-panel";
import { ScoreCard } from "@/components/jobs/detail/score-card";
import { LanguageTag } from "@/components/jobs/detail/language-tag";
import { MarkAppliedButton } from "@/components/jobs/detail/mark-applied";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { MobileActionBar } from "@/components/jobs/detail/mobile-action-bar";
import { StatusJumpLink, StatusPanel, type HistoryEntry } from "@/components/jobs/detail/status-panel";
import { MoreActions } from "@/components/jobs/detail/more-actions";
import { CloseJobButton } from "@/components/jobs/detail/close-job-button";
import { ClosureNotice } from "@/components/jobs/detail/closure-notice";
import { DateStrip } from "@/components/jobs/detail/date-strip";
import { channelStatesPostedAt } from "@/lib/channels/registry";
import { buildPostedView } from "@/lib/jobs/posted-view";
import { PostingLink } from "@/components/jobs/detail/posting-link";
import { SeenTracker } from "@/components/jobs/detail/seen-tracker";
import { FilterNotice, FilterOverrideAction, overrideActionFor } from "@/components/jobs/filter-notice";
import { ResumeChip } from "@/components/resume/resume-chip";
import { ResumePanel } from "@/components/resume/resume-panel";
import { TranslationPanel } from "@/components/jobs/detail/translation-panel";
import { TrapBanner } from "@/components/jobs/detail/trap-banner";
import { TrapsPanel } from "@/components/jobs/detail/traps-panel";
import { ScoreNowButton } from "@/components/jobs/detail/score-now";
import { JobViewTransition } from "@/components/jobs/job-view-transition";
import { SourceIcon } from "@/components/jobs/source-icons";
import { JobStatusChip, StatusChip } from "@/components/jobs/status-chip";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { loadTargetPlaces } from "@/lib/dashboard/target-places";
import { pickApplyTarget, postingLink, safeHttpUrl } from "@/lib/dashboard/apply";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { germanCheck } from "@/lib/dashboard/german-check";
import { userGermanLabelOrNull } from "@/lib/dashboard/german";
import { floorCheck } from "@/lib/dashboard/floor-check";
import { loadDealBreakerNotice } from "@/lib/dashboard/deal-breakers";
import { channelDisplayName, knownContract, knownFamily } from "@/lib/dashboard/labels";
import { buildSkillAliasMap, matchSkills, profileSkillKeys } from "@/lib/dashboard/skills";
import { quotesFoundInJd } from "@/lib/dashboard/jd";
import { reasonSourceViews } from "@/lib/dashboard/reason-evidence";
import { loadModelCatalog } from "@/lib/ai/catalog";
import { buildBreakdownView } from "@/lib/breakdown/view";
import { readBreakdownSettings } from "@/lib/breakdown/settings";
import { getJobBreakdown } from "@/lib/db/repos/breakdowns";
import { annualBaseFigure } from "@/lib/domain/salary";
import { needsLanguageTag, pickSummary, summaryOrder } from "@/lib/dashboard/summary";
import { resolveLocale } from "@/i18n/locale";
import { aiOutputLanguage, languageSettings, translationTarget } from "@/lib/i18n/config";
import { bcp47, displayLanguageName, languageAutonym, sameLanguage } from "@/lib/i18n/languages";
import { describeSalary } from "@/lib/dashboard/salary";
import { effectiveStatus } from "@/lib/dashboard/status";
import { getDb, getJobDetail, getTranslation, listTrapsOfJob, loadMonthSalaryStats, strongestFirst } from "@/lib/db";
import { trapsEnabled } from "@/lib/traps/settings";
import { buildTrapCheckView, buildTrapPanelView } from "@/lib/traps/view";
import { readNeedsVisaSponsorship, visaEnabled } from "@/lib/visa/settings";
import { buildVisaCheckView, visaMarkText } from "@/lib/visa/view";
import { ghostEnabled } from "@/lib/ghost/settings";
import { buildGhostCheckView, GHOST_TOOLTIP_REASONS, ghostMarkText, ghostShortMessage } from "@/lib/ghost/view";
import { readInitialBreakdownRequest } from "@/lib/control/breakdown-request";
import { readInitialTranslateRequest, readPartialTranslation } from "@/lib/control/translate-request";
import { toJobTranslation } from "@/lib/translation/service";
import { loadConfig, reloadConfig, type AiConfig, type MeConfig } from "@/lib/config";
import { createProcessLogger } from "@/lib/logging/process-logger";
import { loadPipeline } from "@/lib/market";
import { salaryAxisScale } from "@/components/viz/salary-shared";
import { readResumeConfig } from "@/lib/resume/config";
import { readProfileReadiness } from "@/lib/scoring/profile";
import { listPdfs } from "@/lib/resume/paths";
import { bonusPolicy, isHighPayAmount, otherRegionOfAmount, signalBonus } from "@/lib/signals/bonus";
import { buildCatalog, toCategoryViews } from "@/lib/signals/catalog";
import { sharedSignalPatternGuard } from "@/lib/signals/pattern-guard";
import { findQuoteTerm } from "@/lib/signals/rules";
import { loadBaseCurrency, loadSalaryFloor } from "@/lib/signals/floor";
import { cn } from "@/lib/utils";
import { VisibilityScope } from "@/components/applications/visibility-scope";
import { localLanguageName } from "@/lib/market/view";
import { readSalarySettings } from "@/lib/salary/settings";
import { getSalaryContext } from "@/lib/salary/view";

type Params = Promise<{ id: string }>;

/** A user pattern of interests.yaml too slow for the probe is left out of the quote marks, with a warning. */
const patternLog = createProcessLogger({ fields: { component: "job-page" } });

function parseJobId(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const id = parseJobId((await params).id);
  if (id === null) return {};
  const job = await getJobDetail(getDb(), id);
  return job ? { title: `${job.title} · ${job.company.name}` } : {};
}

export default async function JobDetailPage({ params }: { params: Params }) {
  const id = parseJobId((await params).id);
  if (id === null) notFound();
  const job = await getJobDetail(getDb(), id);
  if (!job) notFound();

  const [t, tBreakdown, tTraps, tDash, tResume, format, locale] = await Promise.all([
    getTranslations("dashboard.detail"),
    getTranslations("jdBreakdown"),
    getTranslations("aiTraps.panel"),
    getTranslations("dashboard"),
    getTranslations("resume"),
    getFormatter(),
    getLocale(),
  ]);
  const timezone = getDisplayTimeZone();
  const uiLocale = resolveLocale(locale);
  // Translations are made into language.yaml's translation.target; a JD already in that language has no translation tab
  const languages = languageSettings({ fresh: true });
  const target = translationTarget(languages);
  const translatable = !sameLanguage(job.language, target);
  const targetView = { name: displayLanguageName(target, uiLocale), lang: bcp47(target) };
  const storedTranslation = await getTranslation(getDb(), job.id, target);
  const translation = storedTranslation ? toJobTranslation(storedTranslation, job.description) : null;
  // an earlier attempt that stopped half way keeps its pieces; they are shown until the translation is complete
  const translateRequest = await readInitialTranslateRequest(getDb(), job.id);
  const partialTranslation = translation === null ? await readPartialTranslation(getDb(), job.id) : null;
  const interests = loadConfig("interests");
  const policy = bonusPolicy(interests, loadSalaryFloor(), loadBaseCurrency());
  // Only the active categories are shown, in their order; a deleted category's stored signals stay hidden
  const catalog = buildCatalog(interests);
  const categories = toCategoryViews(catalog, locale);
  const markerCategories = categories.map((category) => ({ id: category.id, color: category.color }));
  const activeSignals = job.signals.filter((s) => catalog.isActive(s.tier)).sort((a, b) => catalog.order(a.tier) - catalog.order(b.tier));
  const resumeConfig = readResumeConfig();
  const pdfs = resumeConfig ? await listPdfs(resumeConfig.pdf_dir, resumeConfig.pdf_list_limit) : [];
  const now = new Date();
  const absolute = (date: Date) => format.dateTime(date, { dateStyle: "medium", timeStyle: "short", timeZone: timezone });

  const places = [...new Set(job.locations.map((l) => l.label))];
  const companyHref = companyJobsHref(job.company.name);
  const salary = job.salary
    ? describeSalary(job.salary, uiLocale)
    : null;
  const applyTarget = pickApplyTarget(job.sources, loadTargetPlaces());
  const applyUrl = applyTarget ? safeHttpUrl(postingLink(applyTarget)) : null;
  const status = effectiveStatus(job.application?.status ?? null);
  // when it was marked applied: the newest `→ applied` event (events come newest first), else the status clock; a string, it crosses to client components
  const appliedAt = status === "applied" ? (job.applicationEvents.find((e) => e.toStatus === "applied")?.at ?? job.application?.statusChangedAt ?? null) : null;
  const appliedOn = appliedAt ? format.dateTime(appliedAt, { month: "short", day: "numeric", timeZone: timezone }) : null;
  // AI texts carry their own language; the ones not in the interface language get a tag, never a translation
  const outputLang = job.score?.outputLang ?? null;
  const summary = job.score ? pickSummary(job.score.summaries, summaryOrder(uiLocale, outputLang)) : null;
  const languageTag = (lang: string, className?: string) => (
    <LanguageTag lang={bcp47(lang)} label={languageAutonym(lang)} title={t("reasonsLanguageHint", { language: displayLanguageName(lang, uiLocale) })} {...(className ? { className } : {})} />
  );
  const reasonsTag = outputLang !== null && needsLanguageTag(outputLang, uiLocale) ? languageTag(outputLang) : undefined;
  const reasonsLang = outputLang === null ? undefined : bcp47(outputLang);

  const knownKind = knownContract(job.contract);
  const contractLabel = knownKind ? tDash(`contract.${knownKind}`) : job.contract;
  const knownSeniority = SENIORITY_KEYS.find((k) => k === job.seniority.toLowerCase());

  const history: HistoryEntry[] = job.applicationEvents.map((e) => ({
    id: e.id,
    when: format.dateTime(e.at, { dateStyle: "short", timeStyle: "short", timeZone: timezone }),
    from: e.fromStatus,
    to: e.toStatus,
    note: e.note,
  }));

  // ---- v3: score card, salary card, checks (thresholds and scales come from the config files, C8)
  const ui = loadConfig("ui");
  const pushLine = loadConfig("notify").push_min_score;
  const bonusCap = interests.bonus_cap;
  const salaryFloor = loadSalaryFloor();
  const axis = salaryAxisScale(ui, loadBaseCurrency() ?? "");
  const baseCurrency = loadBaseCurrency() ?? "";
  const languageName = localLanguageName(locale);
  const figure = annualBaseFigure(job.salary, baseCurrency);
  const salaryStats = await loadMonthSalaryStats(getDb(), { now, timeZone: timezone, jobId: job.id, figure, minSample: ui.salary_stats.min_sample, currency: baseCurrency });
  let me: MeConfig | null = null;
  try {
    me = loadConfig("me");
  } catch {
    me = null; // me.yaml cannot be read: the checks say "not set" instead of guessing
  }
  const aliases = buildSkillAliasMap(loadPipeline().skills);
  const patternGuard = sharedSignalPatternGuard(interests.limits, patternLog);
  const mySkills = me?.skills.map((skill) => skill.name) ?? [];
  const skillMatches = matchSkills(job.skills, profileSkillKeys(mySkills, aliases), aliases);
  const german = germanCheck(job.germanLevelRequired, userGermanLabelOrNull());
  const floor = floorCheck(job.salary, salaryFloor, baseCurrency);
  // The salary panel: the level within the benchmark and the on-demand salary lookup (salary.yaml; the lookup is off by default)
  const tGhost = await getTranslations("ghostJobs");
  const tEvidence = await getTranslations("scoreEvidence");
  const salarySettings = readSalarySettings();
  let salaryAi: AiConfig | null = null;
  try {
    salaryAi = reloadConfig("ai");
  } catch {
    salaryAi = null; // ai.yaml cannot be read: the salary panel says so
  }
  const salaryContext = await getSalaryContext(getDb(), { jobId: job.id, figure, currency: baseCurrency, salary: salarySettings.state === "ok" ? salarySettings.config : null, ai: salaryAi, locale: uiLocale, now });

  // every signal quote, in order: the position is the id of its `mark` in the JD, the tag of a quote the JD shows jumps there
  const quoteList = activeSignals.map((s) => ({ text: s.quote, tier: s.tier }));
  // The stored breakdown (off by default); its quotes follow the signal quotes in the JD panel's list
  const breakdownSettings = readBreakdownSettings();
  const breakdownRow = await getJobBreakdown(getDb(), job.id);
  // An unfinished or failed request of this job is the card's starting state (a reload must not forget it)
  const breakdownRequest = await readInitialBreakdownRequest(getDb(), job.id, breakdownRow?.analyzedAt ?? null);
  const { view: breakdownView, extraQuotes } = buildBreakdownView({
    row: breakdownRow,
    description: job.description,
    signalQuotes: quoteList.map((q) => q.text),
    profileSkills: mySkills,
    profileYears: me?.years_experience ?? null,
    aliases,
    catalog: loadModelCatalog(),
    outputLang: aiOutputLanguage(languages),
  });
  // The job's AI traps (nothing at all when traps.yaml is off); their marks follow the signal and breakdown quotes in the JD panel
  const showTraps = trapsEnabled();
  const trapData = showTraps ? await listTrapsOfJob(getDb(), job.id) : { rows: [], scan: null };
  const trapView = buildTrapPanelView({ rows: trapData.rows, scan: trapData.scan, description: job.description, scoredAt: job.score?.scoredAt ?? null });
  const trapCheck = showTraps ? buildTrapCheckView(trapData.scan, trapView) : null;
  const trapItems = trapView ? [...trapView.items, ...trapView.benign].filter((item) => item.markText !== null) : [];
  const baseQuotes = [...quoteList, ...extraQuotes.map((text) => ({ text, tier: "breakdown" as const }))];
  // What the JD says about visa sponsorship (nothing when ui.yaml job_checks.visa is off); its marks follow the trap marks
  const visaView = visaEnabled() ? buildVisaCheckView(job.visa, readNeedsVisaSponsorship()) : null;
  const visaMarks = visaView ? visaView.evidence.map((e) => visaMarkText(e.quote)).filter((text) => text !== "") : [];
  // The ghost job check (nothing when ui.yaml job_checks.ghost is off); its evergreen quote is marked after the visa marks
  const ghostOn = ghostEnabled();
  const ghostView = ghostOn ? buildGhostCheckView(job.ghost) : null;
  // marked only while the result shows (watch / likely): not once it is dismissed
  const ghostMark = ghostView?.quote && (ghostView.state === "watch" || ghostView.state === "likely") ? ghostMarkText(ghostView.quote) : "";
  const ghostChannelNames = Object.fromEntries(job.sources.map((source) => [source.channelId, channelDisplayName(source.channelId, source.family, (family) => tDash(`source.${family}`))]));
  const checkQuotes: Array<{ text: string; tier: string; trapKind?: "hidden" | "instruction" }> = [
    ...baseQuotes,
    ...trapItems.map((item) => ({ text: item.markText as string, tier: TRAP_QUOTE, trapKind: item.markKind })),
    ...visaMarks.map((text) => ({ text, tier: VISA_QUOTE })),
    ...(ghostMark !== "" ? [{ text: ghostMark, tier: GHOST_QUOTE }] : []),
  ];
  // The verified JD quotes of the scoring reasons (reason sources); their marks come last, a quote another mark already has jumps there
  const reasonSources = reasonSourceViews(job.score?.reasonEvidence ?? null, checkQuotes);
  const jdQuotes = [...checkQuotes, ...reasonSources.marks.map((text) => ({ text, tier: EVIDENCE_QUOTE }))];
  const trapMarksFound = quotesFoundInJd(job.description, jdQuotes.map((q) => q.text));
  const trapJdIndex: Record<number, number> = {};
  trapItems.forEach((item, i) => {
    const index = baseQuotes.length + i;
    if (trapMarksFound[index]) trapJdIndex[item.id] = index;
  });
  const visaFirstMark = visaMarks.findIndex((_, i) => trapMarksFound[baseQuotes.length + trapItems.length + i] === true);
  const visaJdIndex = visaFirstMark === -1 ? null : baseQuotes.length + trapItems.length + visaFirstMark;
  const ghostIndex = baseQuotes.length + trapItems.length + visaMarks.length;
  const ghostJdIndex = ghostMark !== "" && trapMarksFound[ghostIndex] === true ? ghostIndex : null;
  // the score card's mark: a watch / likely result that is not dismissed, its strongest reasons in the tooltip
  const ghostScoreMark =
    ghostView && (ghostView.state === "watch" || ghostView.state === "likely")
      ? {
          level: ghostView.state,
          score: ghostView.score,
          reasons: strongestFirst(ghostView.reasons)
            .slice(0, GHOST_TOOLTIP_REASONS)
            .map((reason) => {
              const message = ghostShortMessage(reason);
              return tGhost(message.key, message.values);
            })
            .join(" · "),
        }
      : null;
  const reasonJumpable = (mark: number | null) => mark !== null && trapMarksFound[mark] === true;
  // a score made before reason sources (or while they were off) says so, but only while they are on: then a new score would carry them
  const evidenceOn = salaryAi?.scoring.evidence.enabled === true;
  const reasonsWithoutSources = evidenceOn && job.score !== null && job.score.reasonEvidence === null && job.score.fitReasons.length + job.score.gaps.length > 0;
  const jdLang = job.language === "en" || job.language === "de" ? job.language : undefined;
  const hasDescription = job.description !== null && job.description.trim() !== "";
  const inJd = quotesFoundInJd(job.description, quoteList.map((q) => q.text));
  const signalRows = activeSignals.map((s, index) => ({
    ...s,
    belowFloor: s.tier === policy.amountId && !isHighPayAmount(s.value, policy),
    otherRegion: s.tier === policy.amountId ? otherRegionOfAmount(s.value) : null,
    term: findQuoteTerm(s.quote, s.tier, interests, patternGuard),
    quoteIndex: index,
    inJd: inJd[index] ?? false,
  }));
  const sourceNames = [...new Set(job.sources.map((source) => source.family))].map((family) => {
    const known = knownFamily(family);
    return known ? tDash(`source.${known}`) : family;
  });

  // The date strip: "posted" is always posted_at; a relisting comes from the stored ghost check, so only while that check is on
  const postedView = buildPostedView({ postedAt: job.postedAt, sources: job.sources, ghost: job.ghost, ghostOn, trustedChannels: new Set(job.sources.map((source) => source.channelId).filter(channelStatesPostedAt)) });

  const scoreNowButton =
    job.score?.filterResult === "passed" && job.score.rankValue === null && job.status === "active" ? <ScoreNowButton jobId={job.id} profileMissing={readProfileReadiness()?.missing ?? []} timeZone={timezone} /> : null;
  const actionLink = "h-ctl-md";
  const overrideAction = overrideActionFor(job.score);

  return (
    <VisibilityScope>
    <div data-wide className="mx-auto flex w-full max-w-[75rem] flex-col gap-4 max-lg:pb-36" data-testid="job-detail" data-job-id={job.id}>
      <BackLink href="/jobs" label={t("back")} />
      <SeenTracker jobId={job.id} />

      <FilterNotice rank={job.score} jobId={job.id} withButton={false} floor={{ atFilter: job.score?.filterFloorEur ?? null, current: salaryFloor, currency: baseCurrency }} dealBreakers={loadDealBreakerNotice(job, job.score?.filterReasons ?? [])} />

      <header className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_300px_300px]" data-testid="detail-header">
        <div className="flex min-w-0 flex-col gap-2.5 md:col-span-2 xl:col-span-1">
          {status !== "new" || job.application?.resumeVariantPath || job.status !== "active" ? (
            <div className="text-ink-2 text-data flex flex-wrap items-center gap-2 font-mono">
              {status !== "new" ? <StatusChip status={status} /> : null}
              {job.application?.resumeVariantPath ? <ResumeChip path={job.application.resumeVariantPath} /> : null}
              {job.status !== "active" ? <JobStatusChip status={job.status} reason={job.closure.reason} evidence={job.closure.linkCheck} /> : null}
            </div>
          ) : null}
          <DateStrip
            view={postedView}
            firstSeenAt={job.firstSeenAt}
            now={now}
            timezone={timezone}
            sourceNames={sourceNames}
            channelNames={ghostChannelNames}
            relistedText={job.relistedAt ? tDash("relisted.detail", { date: absolute(job.relistedAt) }) : null}
          />
          <JobViewTransition id={job.id} part="title">
            <h1 className="font-display text-h1-detail [overflow-wrap:anywhere]" data-testid="job-title">
              {job.title}
            </h1>
          </JobViewTransition>
          <div className="text-ink-2 text-body flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {companyHref ? (
              // the company's jobs, and only those
              <Link href={companyHref} className="text-ink font-bold underline-offset-2 hover:underline focus-visible:underline" data-testid="job-company" data-slot="company-link">
                {job.company.name}
              </Link>
            ) : (
              <b className="text-ink font-bold" data-testid="job-company">
                {job.company.name}
              </b>
            )}
            {job.company.watched ? <Badge variant="status-on">{t("watched")}</Badge> : null}
            <span aria-hidden>·</span>
            <span>{places.length > 0 ? places.join(", ") : <Unknown label={t("unknown")} />}</span>
            <span aria-hidden>·</span>
            <span>{tDash(`workplace.${job.workplace}`)}</span>
            {knownSeniority ? (
              <>
                <span aria-hidden>·</span>
                <span>{t(`seniority.${knownSeniority}`)}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>{job.contract === "unknown" ? <Unknown label={t("unknown")} /> : contractLabel}</span>
          </div>
          {summary ? (
            <p className="max-w-[70ch]" lang={bcp47(summary.lang)} data-testid="job-summary" data-lang={summary.lang}>
              {summary.text}
              {summary.fallback ? <LanguageTag lang={bcp47(summary.lang)} label={languageAutonym(summary.lang)} title={t("summaryFallbackHint")} className="ml-2 align-middle" /> : null}
            </p>
          ) : null}
          <dl className="text-ink-2 text-data flex flex-wrap gap-x-4 gap-y-1 font-mono">
            <Meta label={t("meta.lastSeen")}>
              <time dateTime={job.lastSeenAt.toISOString()} title={absolute(job.lastSeenAt)}>{absolute(job.lastSeenAt)}</time>
            </Meta>
            <Meta label={t("meta.status")}>{tDash(`jobStatus.${job.status}`)}</Meta>
          </dl>
          <ClosureNotice jobId={job.id} title={job.title} closure={job.closure} lastListedAt={job.lastListedAt} timezone={timezone} />
          <HeaderTags signals={activeSignals} categories={categories} salaryDisclosed={job.salaryDisclosed} germanLevelRequired={job.germanLevelRequired} isAgency={job.isAgency} contract={job.contract} languageName={languageName} />
        </div>
        {/* the actions have a row of their own under the three columns at xl: the left column is 422px wide there, and the five buttons (four in English with a longer wording) never fit it in one line */}
        <div className="flex flex-wrap items-center gap-1.5 md:col-span-2 xl:order-last xl:col-span-3" data-testid="detail-actions">
          {applyUrl ? (
            <PostingLink jobId={job.id} href={applyUrl} className={cn(buttonVariants({ variant: "primary" }), actionLink)} testId="view-posting-button">
              {t("viewPosting")} <ExternalLink aria-hidden />
            </PostingLink>
          ) : (
            <span aria-disabled="true" className={cn(buttonVariants({ variant: "outline" }), actionLink, "pointer-events-none opacity-50")}>
              {t("noPostingLink")}
            </span>
          )}
          <MarkAppliedButton jobId={job.id} title={job.title} status={status} appliedOn={appliedOn} variant="header" />
          <FavoriteButton jobId={job.id} title={job.title} favorite={job.favorite !== null} variant="labeled" />
          {/* the "Tailor resume" button needs a resume-kit folder; without one the panel below only exports the JD */}
          {resumeConfig?.resume_kit_path ? (
            <a href="#h-resume" className={cn(buttonVariants({ variant: "outline" }), actionLink)} data-testid="action-resume">
              {t("actions.resume")}
            </a>
          ) : null}
          <StatusJumpLink className={cn(buttonVariants({ variant: "outline" }), actionLink)} testId="action-status">
            {t("actions.status")}
          </StatusJumpLink>
          {translatable ? (
            <a
              href="#jd-translation"
              className={cn(buttonVariants({ variant: "outline" }), actionLink)}
              data-testid="action-translate"
            >
              {t("actions.translate", { language: targetView.name })}
            </a>
          ) : null}
          {/* "exclude this job" is the optional one: it lives in the "more" menu so the row stays one line; "keep anyway" / "let the rules decide again" rescue a job the filter removed (or undo a decision), so they stay buttons */}
          {overrideAction === "exclude" ? null : <FilterOverrideAction rank={job.score} jobId={job.id} />}
          {/* the "more" menu: "exclude this job" when that is the decision on offer, and "mark as unseen" */}
          {/* Mark as closed / reopen / still open, with an optional note */}
          <CloseJobButton jobId={job.id} title={job.title} reason={job.closure.reason} note={job.closure.override?.action === "closed" ? job.closure.override.note : null} />
          <MoreActions jobId={job.id} overrideAction={overrideAction === "exclude" ? overrideAction : null} />
        </div>
        <ScoreCard
          jobId={job.id}
          score={job.score}
          pushLine={pushLine}
          bonusCap={bonusCap}
          scoreNow={scoreNowButton}
          scoredWhen={job.score?.scoredAt ? absolute(job.score.scoredAt) : null}
          languageName={languageName}
          ghost={ghostScoreMark}
        />
        <SalaryCard
          salary={job.salary}
          salaryDisclosed={job.salaryDisclosed}
          normalizedText={salary?.normalized ?? null}
          axis={axis}
          floor={salaryFloor}
          median={salaryStats.median}
          percentile={salaryStats.percentile}
          sample={{ count: salaryStats.count, min: ui.salary_stats.min_sample }}
          panelHref={salaryContext ? "#h-pay" : null}
        />
      </header>

      {trapView && trapView.counts.traps > 0 ? <TrapBanner count={trapView.counts.traps} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {trapView ? (
            <Panel id="h-traps" title={tTraps("title")} aside={<PanelAside>{tTraps("aside", { total: trapView.counts.total, rule: trapView.counts.rule, ai: trapView.counts.ai })}</PanelAside>}>
              <TrapsPanel view={trapView} jdIndex={trapJdIndex} />
            </Panel>
          ) : null}
          <Panel id="h-comp" title={t("comp.title")} aside={<PanelAside>{t("comp.jumpHint")}</PanelAside>}>
            <CompPanel
              salary={
                salary
                  ? {
                      normalized: salary.normalized,
                      eurApprox: salary.eurApprox,
                      raw: job.salary?.raw ?? null,
                      periodAssumed: job.salary?.periodAssumed ?? false,
                      includesVariable: job.salary?.includesVariable === true,
                      otherRegion: job.salary?.otherRegion ? { reason: job.salary.otherRegion, currency: job.salary.currency } : null,
                    }
                  : null
              }
              salaryDisclosed={job.salaryDisclosed}
              signals={signalRows}
              categories={categories}
              bonus={{ ...signalBonus(activeSignals, interests, policy), cap: bonusCap }}
              scan={job.signalScan}
              language={job.language}
            />
          </Panel>
          {salaryContext ? (
            <SalaryPanel
              context={salaryContext}
              salary={job.salary}
              salaryDisclosed={job.salaryDisclosed}
              normalizedText={salary?.normalized ?? null}
              floor={salaryFloor}
              axis={axis}
              jobId={job.id}
              company={job.company.name}
              timeZone={timezone}
            />
          ) : null}

          <Panel id="h-fit" title={`${t("fit.title")} / ${t("gaps.title")}`} aside={reasonsTag}>
            <div className="grid gap-x-4 gap-y-3.5 md:grid-cols-2">
              {job.score && job.score.fitReasons.length > 0 ? (
                <ul className="flex flex-col gap-1.5 text-[13px]" lang={reasonsLang} aria-label={t("fit.title")} data-testid="fit-list">
                  {job.score.fitReasons.map((reason, index) => (
                    <li key={index} className={cn(REASON_ROW, "before:bg-good before:text-on-bad before:content-['+']")}>
                      <ReasonSource text={reason} source={reasonSources.fit[index] ?? null} jumpable={reasonJumpable(reasonSources.fit[index]?.mark ?? null)} quoteLang={jdLang} />
                    </li>
                  ))}
                </ul>
              ) : (
                <PlaceholderBox testId="fit-pending">{t("fit.pending")}</PlaceholderBox>
              )}
              {job.score && job.score.gaps.length > 0 ? (
                <ul className="flex flex-col gap-1.5 text-[13px]" lang={reasonsLang} aria-label={t("gaps.title")} data-testid="gaps-list">
                  {job.score.gaps.map((gap, index) => (
                    <li key={index} className={cn(REASON_ROW, "before:bg-warn before:text-on-signal before:content-['–']")}>
                      <ReasonSource text={gap} source={reasonSources.gaps[index] ?? null} jumpable={reasonJumpable(reasonSources.gaps[index]?.mark ?? null)} quoteLang={jdLang} />
                    </li>
                  ))}
                </ul>
              ) : (
                <PlaceholderBox testId="gaps-pending">{t("gaps.pending")}</PlaceholderBox>
              )}
            </div>
            {reasonsWithoutSources ? (
              <p className="text-ink-3 text-data-sm mt-3 font-mono" data-testid="reasons-evidence-legacy">
                {tEvidence("legacy")}
              </p>
            ) : null}
          </Panel>

          <Panel
            id="h-breakdown"
            title={tBreakdown("title")}
            aside={
              breakdownView?.content && breakdownView.content.total > 0 ? (
                <span className="flex min-w-0 items-center gap-2">
                  <PanelAside className="min-w-0 text-right">{tBreakdown("aside", { n: breakdownView.content.total })}</PanelAside>
                  {needsLanguageTag(breakdownView.meta.outputLang, uiLocale) ? languageTag(breakdownView.meta.outputLang, "shrink-0 whitespace-nowrap") : null}
                </span>
              ) : undefined
            }
          >
            <BreakdownPanel
              jobId={job.id}
              availability={breakdownSettings.state === "error" ? "config_error" : breakdownSettings.config.enabled ? "enabled" : "disabled"}
              hasDescription={hasDescription}
              view={breakdownView}
              initialRequest={breakdownRequest}
              timeZone={timezone}
            />
          </Panel>

          <Panel id="h-jd" title={t("jd.title")} aside={job.language === "en" || job.language === "de" ? <PanelAside>{languageAutonym(job.language)}</PanelAside> : undefined}>
            <JdPanel
              description={job.description}
              language={job.language}
              quotes={jdQuotes}
              categories={categories}
              translationLanguage={targetView.name}
              translation={
                translatable ? (
                  <TranslationPanel
                    target={targetView}
                    jobId={job.id}
                    hasDescription={job.description !== null && job.description.trim() !== ""}
                    initialRequest={translateRequest}
                    initial={translation ? { content: translation.content, provider: translation.provider, createdAt: translation.createdAt.toISOString(), stale: translation.stale } : null}
                    initialPartial={
                      partialTranslation && partialTranslation.done > 0
                        ? {
                            content: partialTranslation.content,
                            done: partialTranslation.done,
                            total: partialTranslation.total,
                            errorCode: partialTranslation.lastError?.code ?? null,
                            errorDetail: partialTranslation.lastError?.message ?? null,
                          }
                        : null
                    }
                    timeZone={timezone}
                    categories={markerCategories}
                  />
                ) : null
              }
            />
          </Panel>
        </div>

        <aside aria-label={t("sideLabel")} className="flex min-w-0 flex-col gap-4">
          <Panel id="h-checks" title={t("checks.title")}>
            <ChecksPanel
              german={german}
              languageName={languageName}
              germanPenalty={job.score && job.score.rankValue !== null ? job.score.germanPenalty : null}
              germanDetail={
                job.score && job.score.rankValue !== null && languageName !== null ? (
                  <GermanPanel
                    languageName={languageName}
                    level={job.germanLevelRequired}
                    rule={job.germanLevelRule}
                    ai={job.score.germanLevelAi}
                    source={job.score.germanLevelSource}
                    penalty={job.score.germanPenalty}
                    yours={userGermanLabelOrNull()}
                    compact
                  />
                ) : null
              }
              skills={skillMatches}
              profileHasSkills={mySkills.length > 0}
              floor={floor}
              traps={trapCheck}
              ghost={ghostView ? { jobId: job.id, view: ghostView, jdIndex: ghostJdIndex, channelNames: ghostChannelNames } : null}
              visa={visaView ? { view: visaView, jdIndex: visaJdIndex } : null}
            />
          </Panel>

          <Panel id="h-src" title={t("sources.title")} aside={<PanelAside>{job.sources.length}</PanelAside>}>
            {job.sources.length === 0 ? (
              <PlaceholderBox>{t("sources.none")}</PlaceholderBox>
            ) : (
              <ul data-testid="source-list">
                {job.sources.map((source, index) => {
                  const url = safeHttpUrl(postingLink(source));
                  const isApply = applyTarget !== null && source === applyTarget;
                  const knownSource = knownFamily(source.family);
                  const family = knownSource ? tDash(`source.${knownSource}`) : source.family;
                  return (
                    <li key={`${source.channelId}-${index}`} className="border-grid grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5 not-first:border-t-[1.5px] first:pt-0 last:pb-0">
                      <SourceIcon family={source.family} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                          {family}
                          <span className="text-ink-3 text-data font-mono font-normal">{source.channelId}</span>
                          {isApply ? <Badge variant="status-on">{t("sources.primary")}</Badge> : null}
                        </div>
                        {source.locationLabel ? <div className="text-xs [overflow-wrap:anywhere]">{source.locationLabel}</div> : null}
                        <div className="text-ink-3 text-data font-mono [overflow-wrap:anywhere]">{url ? url.replace(/^https?:\/\//, "") : t("sources.noLink")}</div>
                      </div>
                      {url ? (
                        <PostingLink
                          jobId={job.id}
                          href={url}
                          ariaLabel={`${isApply ? t("viewPosting") : t("sources.open")} · ${family}`}
                          className={buttonVariants({ variant: isApply ? "primary" : "outline", size: "sm" })}
                        >
                          {isApply ? t("viewPosting") : t("sources.open")}
                        </PostingLink>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-muted-foreground mt-3 text-xs">{t("sources.order")}</p>
          </Panel>

          <Panel id="h-act" title={t("status.title")}>
            <StatusPanel jobId={job.id} status={status} notes={job.application?.notesMd ?? ""} history={history} firstSeen={format.dateTime(job.firstSeenAt, { dateStyle: "short", timeStyle: "short", timeZone: timezone })} />
          </Panel>

          <Panel id="h-resume" title={tResume("title")}>
            {resumeConfig ? (
              <ResumePanel jobId={job.id} resumePath={job.application?.resumeVariantPath ?? null} pdfEnabled={resumeConfig.pdf_dir !== null} pdfs={pdfs.map((p) => p.name)} />
            ) : (
              <PlaceholderBox testId="resume-config-error">{tResume("error.config")}</PlaceholderBox>
            )}
          </Panel>
        </aside>
      </div>

      <MobileActionBar jobId={job.id} status={status} notes={job.application?.notesMd ?? ""} postingUrl={applyUrl} title={job.title} appliedOn={appliedOn} favorite={job.favorite !== null} />
    </div>
    </VisibilityScope>
  );
}

const SENIORITY_KEYS = ["entry", "mid", "senior", "lead"] as const;

/** A fit / gap row: a boxed `+` / `–` glyph (design `.fitlist`) and the text. */
const REASON_ROW =
  "grid grid-cols-[22px_minmax(0,1fr)] items-start gap-1.5 [overflow-wrap:anywhere] before:border-border before:rounded-[4px] before:border-[1.5px] before:text-center before:font-mono before:text-data before:font-bold before:leading-4 before:h-[18px]";

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 whitespace-nowrap">{label}</dt>
      <dd className="text-foreground min-w-0">{children}</dd>
    </div>
  );
}

function Unknown({ label }: { label: string }) {
  return <span className="text-muted-foreground border-border rounded-sm border border-dashed px-1.5 text-[13px]">{label}</span>;
}
