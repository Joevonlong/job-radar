"use client";

import { CircleSlash2, Star, ThumbsUp, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { memo, useMemo } from "react";

import { FavoriteMark } from "@/components/favorites/favorite-mark";
import { FavoriteNote } from "@/components/favorites/favorite-note";
import { Button } from "@/components/ui/button";
import { Freshness, SalaryMini, ScoreMeter, SkillOverlap, type SalaryAxisScale } from "@/components/viz";
import { scoreTone } from "@/lib/dashboard/score";
import { effectiveStatus, statusAfterIgnoreKey, statusAfterInterestKey } from "@/lib/dashboard/status";
import { parseFilterReason } from "@/lib/filter/reasons";
import { UNKNOWN } from "@/lib/format/numbers";
import { isArchivedReason } from "@/lib/jobs/scope";
import { companyJobsHref } from "@/lib/jobs/company-link";

import { CompanyMark } from "./company-mark";
import { GhostMark } from "./ghost-mark";
import { FilterReasonText, useFilterReasonText } from "./filter-reasons";
import { useHiddenStatuses } from "@/components/applications/visibility-context";
import { isStatusOffered } from "@/lib/applications/visibility";

import { JobTags } from "./job-tags";
import { JobViewTransition } from "./job-view-transition";
import { StatusPill } from "./status-pill";
import type { JobListItem } from "./types";

import "./jobs.css";

/** The company of a row: a link to the list of its jobs (it never opens the job), plain text when the name cannot be a filter value. */
function CompanyName({ name, tabIndex }: { name: string; tabIndex: number }) {
  const href = companyJobsHref(name);
  if (href === null) return <b>{name}</b>;
  return (
    <Link href={href} tabIndex={tabIndex} className="jb-company" data-slot="company-link">
      {name}
    </Link>
  );
}

/** What the list needs from the config files to draw its graphics (the page loads it on the server: C8). */
export interface JobListViz {
  /** `notify.yaml: push_min_score`: the red triangle of the score cells. */
  pushLine: number;
  /** `interests.yaml: bonus_cap`: a rank value can reach 100 + this (the meter's maximum). */
  bonusCap: number;
  /** The user's salary floor (`preferences.yaml`), EUR a year; null = none. */
  floor: number | null;
  salaryAxis: SalaryAxisScale;
  /** `ui.yaml: freshness`. */
  freshness: { decayHours: number; warnHours: number };
  /** The server's clock when the page was made (ISO), so hours since first seen read the same on the server and in the browser. */
  nowIso: string;
  timezone: string;
  /** The names of the user's deal-breakers by id (`preferences.yaml`), for the reasons of filtered rows; a rule since deleted shows its id. */
  dealBreakerLabels?: Readonly<Record<string, string>>;
}

export type RowAction = "favorite" | "interested" | "ignore" | "close";

export interface JobRowProps {
  job: JobListItem;
  /** The star as shown now (the server's value with the optimistic change on top); a prop of its own so the memoised row re-renders when it flips. */
  favorite: boolean;
  /** Seen as shown now (the server's value with the optimistic change on top); unseen rows are bold with a dot. */
  seen: boolean;
  /** "favorites": the favorites page, a row also shows its star note. */
  mode?: "default" | "favorites";
  index: number;
  /** The roving-tabindex row: the one a Tab stop lands on. */
  active: boolean;
  /** One of the first rows of the list: it slides in (the others appear at once). */
  stagger: boolean;
  viz: JobListViz;
  onFocusRow: (index: number) => void;
  onAction: (job: JobListItem, action: RowAction, index: number) => void;
}

/** "Berlin · Hamburg · +2 · hybrid" */
function usePlace(job: JobListItem): string {
  const t = useTranslations("dashboard");
  return [...job.locations, ...(job.moreLocations ? [`+${job.moreLocations}`] : []), t(`workplace.${job.workplace}`)].join(" · ");
}

/**
 * The posted date over the freshness bar: `10/27 · 4 d`, or `seen 10/27` when no source gave one. The full sentence is the tooltip and
 * the screen reader text; on a phone only the day shows (the relative part is hidden by `jobs.css`).
 */
function PostedDate({ posted }: { posted: JobListItem["posted"] }) {
  const t = useTranslations("dashboard.rowPosted");
  return (
    <span className="jb-posted" data-slot="row-posted" data-known={posted.known ? "true" : "false"} title={posted.title}>
      <span aria-hidden>
        {posted.known ? posted.day : t("unknown", { date: posted.day })}
        {posted.known ? <span className="jb-posted-ago"> · {posted.ago}</span> : null}
      </span>
      <span className="sr-only">{posted.title}</span>
    </span>
  );
}

function ScoreCell({ job, pushLine }: { job: JobListItem; pushLine: number }) {
  const t = useTranslations("dashboard.rank");
  const rank = job.rank;
  // not ranked at all: the hard filter removed it, so "waiting for AI" would be wrong; a job scored before a rule removed it
  // (a deal-breaker added later keeps the old score) shows that score as it is
  if (rank?.filterResult === "filtered_out" && rank.rankValue === null) {
    return (
      <div data-rank="not-ranked" className="flex flex-col gap-1">
        <span className="font-display text-num-m text-ink-3" aria-hidden>
          {UNKNOWN}
        </span>
        <span className="font-mono text-cap text-ink-2">{t("notRanked")}</span>
      </div>
    );
  }
  // a job that passed but has no AI score yet (no row, or a row waiting for the AI) is waiting, never "outdated"
  const value = rank?.rankValue ?? null;
  return (
    <div data-rank={value === null ? "pending" : scoreTone(value)} data-rank-value={value ?? undefined} className="flex flex-col gap-1">
      <JobViewTransition id={job.id} part="score">
        <span className="w-fit">
          {/* no custom max: like the board and the detail page the meter says /100 (a value past it raises the max to itself, never to a made-up 115) */}
          <ScoreMeter value={value} pushLine={pushLine} size="sm" />
        </span>
      </JobViewTransition>
      {value !== null && rank?.stale ? (
        <span className="font-mono text-data-sm text-ink-3" title={t("staleHint")} data-testid="rank-stale">
          {t("stale")}
        </span>
      ) : null}
      {job.ghost ? <GhostMark ghost={job.ghost} /> : null}
    </div>
  );
}

function SalaryCell({ job, viz }: { job: JobListItem; viz: JobListViz }) {
  const t = useTranslations("dashboard.list");
  const hasRange = (job.salaryMin ?? null) !== null || (job.salaryMax ?? null) !== null;
  if (hasRange) {
    const other = job.salaryOtherRegion === true;
    return (
      <SalaryMini
        min={job.salaryMin ?? null}
        max={job.salaryMax ?? null}
        axis={viz.salaryAxis}
        floor={viz.floor}
        otherRegion={other}
        approx={job.salaryApprox === true}
        figure={other ? (job.salaryFigure ?? null) : null}
        percentile={job.salaryPercentile ?? null}
        className="w-full!"
      />
    );
  }
  // a stated salary the axis cannot draw: in a currency without a rate, or one that is under review
  if (job.salaryText) {
    return (
      <span className="flex flex-col gap-1">
        <span className="font-display text-num-s">{job.salaryText}</span>
        <span className="font-mono text-data-sm text-ink-3">{t("salaryNoAxis")}</span>
      </span>
    );
  }
  if (job.salaryDisclosed) {
    return (
      <span className="flex flex-col gap-1">
        <span className="font-display text-num-s text-ink-3">{UNKNOWN}</span>
        <span className="font-mono text-data-sm text-ink-3">{t("salaryReview")}</span>
      </span>
    );
  }
  // not stated: the component draws the dashed frame and "未披露"
  return <SalaryMini min={null} max={null} axis={viz.salaryAxis} floor={viz.floor} className="w-full!" />;
}

function SkillsCell({ job }: { job: JobListItem }) {
  const t = useTranslations("dashboard.list");
  const skills = job.skills ?? [];
  const hits = useMemo(() => new Set(job.skillHits ?? []), [job.skillHits]);
  // nothing listed is "—", not 0/0
  if (skills.length === 0) {
    return (
      <span className="jb-na" title={t("skillsNone")} data-slot="skills-none">
        <span aria-hidden>{UNKNOWN}</span>
        <span className="sr-only">{t("skillsNone")}</span>
      </span>
    );
  }
  return <SkillOverlap skills={skills.map((name) => ({ name, have: hits.has(name) }))} className="flex-wrap" />;
}

function JobRowImpl({ job, favorite, seen, mode = "default", index, active, stagger, viz, onFocusRow, onAction }: JobRowProps) {
  const t = useTranslations("dashboard");
  const ts = useTranslations("dashboard.seen");
  const tc = useTranslations("dashboard.closed");
  const ta = useTranslations("dashboard.list");
  const tf = useTranslations("favorites.toggle");
  const router = useRouter();
  const showInterested = isStatusOffered("interested", useHiddenStatuses());
  const place = usePlace(job);
  const reasonText = useFilterReasonText({ currency: viz.salaryAxis.currency ?? "", ...(viz.dealBreakerLabels ? { dealBreakerLabels: viz.dealBreakerLabels } : {}) });
  const status = effectiveStatus(job.applicationStatus);
  const filteredOut = job.rank?.filterResult === "filtered_out";
  const reasons = filteredOut ? (job.rank?.filterReasons ?? []) : [];
  // a kept job whose place is only a country or region (or whose remote scope the description decided): say so on the row
  const notes = job.rank?.filterResult === "passed" ? job.rank.filterReasons.filter((r) => ["location_country_level", "remote_scope_description", "watched_company_location"].includes(parseFilterReason(r).code ?? "")) : [];
  const now = useMemo(() => new Date(viz.nowIso), [viz.nowIso]);
  const firstSeenAt = useMemo(() => new Date(now.getTime() - (job.firstSeenHours ?? 0) * 3_600_000), [now, job.firstSeenHours]);
  const canStar = statusAfterInterestKey(job.applicationStatus) !== null;
  const tabIndex = active ? 0 : -1;
  // Closed by the user or taken down at the source: the fourth button reopens it
  const closedNow = job.closedReason === "manual" || job.closedReason === "gone";
  const closedByUser = job.closedReason === "manual";

  return (
    <div
      role="group"
      className="jb-row"
      data-row-index={index}
      data-job-id={job.id}
      data-status={status}
      data-seen={seen ? "true" : "false"}
      data-filtered={filteredOut ? "true" : undefined}
      data-stagger={stagger ? "" : undefined}
      style={stagger ? ({ "--n": index } as React.CSSProperties) : undefined}
      tabIndex={tabIndex}
      onFocus={() => onFocusRow(index)}
      // the whole row opens the job, as it did when the row was one link; the title link, the buttons and text selection keep their own behaviour
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a, button, input, textarea, [data-slot="fav-note"]') || window.getSelection()?.toString()) return;
        router.push(`/jobs/${job.id}`);
      }}
      aria-label={t(seen ? "list.rowLabel" : "list.rowLabelUnseen", { title: job.title, company: job.companyName })}
    >
      <div className="jb-cell jb-cell--job">
        <div className="flex min-w-0 items-start gap-sp-2">
          <CompanyMark name={job.companyName} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="jb-title" data-slot="job-title">
              {seen ? null : <span className="bg-primary size-2 rounded-full" data-slot="unseen-dot" aria-hidden title={ts("dot")} />}
              {favorite ? <FavoriteMark /> : null}
              <JobViewTransition id={job.id} part="title">
                <Link href={`/jobs/${job.id}`} tabIndex={tabIndex} className="inline-block max-w-full focus-visible:underline">
                  {job.title}
                </Link>
              </JobViewTransition>
            </div>
            <div className="jb-sub">
              <CompanyName name={job.companyName} tabIndex={tabIndex} /> · {place}
            </div>
            {isArchivedReason(job.closedReason) ? (
              <div className="font-mono text-data-sm text-ink-2" data-testid="row-last-listed" title={job.timeTitle}>{job.timeLabel}</div>
            ) : null}
            {job.summary ? (
              <div className="jb-sum" data-slot="job-summary" title={job.summary}>
                {job.summary}
              </div>
            ) : null}
            {mode === "favorites" && job.favoritedLabel ? <FavoriteNote jobId={job.id} title={job.title} note={job.favoriteNote ?? null} starredLabel={job.favoritedLabel} starredTitle={job.favoritedTitle ?? ""} /> : null}
            {notes.length > 0 ? (
              <div className="jb-notes" data-slot="filter-notes">
                {notes.map(reasonText).join("; ")}
              </div>
            ) : null}
            {reasons.length > 0 ? (
              <div className="jb-reasons" data-slot="filter-reasons">
                <FilterReasonText reasons={reasons} floor={{ atFilter: job.filterFloorEur ?? null, current: viz.floor, currency: viz.salaryAxis.currency ?? "" }} {...(viz.dealBreakerLabels ? { dealBreakerLabels: viz.dealBreakerLabels } : {})} />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="jb-mid">
        <div className="jb-cell jb-cell--score">
          <ScoreCell job={job} pushLine={viz.pushLine} />
        </div>
        <div className="jb-cell jb-cell--salary">
          <SalaryCell job={job} viz={viz} />
        </div>
      </div>

      <div className="jb-cell jb-cell--tags">
        <JobTags job={job} />
      </div>

      <div className="jb-foot">
        <div className="jb-cell jb-cell--skills">
          <SkillsCell job={job} />
        </div>
        <div className="jb-cell jb-cell--fresh">
          {isArchivedReason(job.closedReason) ? null : <PostedDate posted={job.posted} />}
          <Freshness firstSeenAt={firstSeenAt} now={now} decayHours={viz.freshness.decayHours} warnHours={viz.freshness.warnHours} timeZone={viz.timezone} />
        </div>
      </div>

      <div className="jb-cell jb-cell--status">
        <StatusPill status={status} />
        <div className="jb-act" data-slot="row-actions">
          <Button
            type="button"
            variant="default"
            size="icon-sm"
            className="jb-act-btn"
            tabIndex={tabIndex}
            aria-pressed={favorite}
            aria-label={tf(favorite ? "removeLabel" : "addLabel", { title: job.title })}
            title={tf("title")}
            data-testid="row-favorite"
            onClick={() => onAction(job, "favorite", index)}
          >
            <Star aria-hidden className={favorite ? "fill-current" : undefined} />
          </Button>
          {showInterested ? (
            <Button
              type="button"
              variant="default"
              size="icon-sm"
              className="jb-act-btn aria-pressed:bg-ink aria-pressed:text-paper"
              tabIndex={tabIndex}
              disabled={!canStar}
              aria-pressed={status === "interested"}
              aria-label={ta("interestedLabel", { title: job.title })}
              title={ta("interestedTitle")}
              data-testid="row-interested"
              onClick={() => onAction(job, "interested", index)}
            >
              <ThumbsUp aria-hidden className={status === "interested" ? "fill-current" : undefined} />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
            size="icon-sm"
            className="jb-act-btn"
            tabIndex={tabIndex}
            aria-label={ta(status === "archived" ? "restoreLabel" : "ignoreLabel", { title: job.title })}
            title={ta(status === "archived" ? "restoreTitle" : "ignoreTitle")}
            data-testid="row-ignore"
            data-can-ignore={statusAfterIgnoreKey(job.applicationStatus) !== null ? "true" : "false"}
            onClick={() => onAction(job, "ignore", index)}
          >
            <X aria-hidden />
          </Button>
          <Button
            type="button"
            variant="default"
            size="icon-sm"
            className="jb-act-btn aria-pressed:bg-ink aria-pressed:text-paper"
            tabIndex={tabIndex}
            aria-pressed={closedByUser}
            aria-label={tc(closedNow ? "rowReopenLabel" : "rowCloseLabel", { title: job.title })}
            title={tc(closedNow ? "rowReopenTitle" : "rowCloseTitle")}
            data-testid="row-close"
            data-closed={closedNow ? "true" : "false"}
            onClick={() => onAction(job, "close", index)}
          >
            <CircleSlash2 aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One row of the job list: a table row on a wide list, a card on a narrow one. Memoised: moving the keyboard cursor re-renders two rows, not the list. */
export const JobRow = memo(JobRowImpl);
