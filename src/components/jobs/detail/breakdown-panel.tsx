"use client";

import { Loader2, Quote, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";

import { breakdownJobAction, breakdownStatusAction, type BreakdownErrorKey, type BreakdownStatusResult } from "@/app/jobs/[id]/breakdown-actions";
import { QueueHint } from "@/components/control/queue-hint";
import { useControlRequest, type ControlRequestRead } from "@/components/control/use-control-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INK_LINK } from "@/components/ui/ink-link";
import { SkillOverlap } from "@/components/viz/skill-overlap";
import { REQUIREMENT_LEVELS, type RequirementLevel } from "@/lib/breakdown/constants";
import type { InitialBreakdownRequest } from "@/lib/control/breakdown-request";
import { controlQueueViewSchema, type ControlQueueView } from "@/lib/control/request-view-schema";
import type { BreakdownQuote, BreakdownView, BreakdownViewItem, BreakdownViewTech } from "@/lib/breakdown/view";
import { formatClock } from "@/lib/format/clock";
import { toastTone } from "@/lib/toast";
import { bcp47 } from "@/lib/i18n/languages";
import { cn } from "@/lib/utils";

import { JumpTag } from "./jump-tag";
import { PlaceholderBox } from "./panel";

export type BreakdownAvailability = "enabled" | "disabled" | "config_error";

export interface BreakdownPanelProps {
  jobId: number;
  /** breakdown.yaml: on, off, or unreadable. */
  availability: BreakdownAvailability;
  /** The job has JD text at all (nothing to break down otherwise). */
  hasDescription: boolean;
  view: BreakdownView | null;
  /** The server's memory of this job's newest request: an unfinished one resumes the waiting state, a failed one shows the failure. */
  initialRequest?: InitialBreakdownRequest | null;
  /** Time zone for the "broken down at" time (schedule.yaml). */
  timeZone: string;
}

type PanelState = "disabled" | "config_error" | "no_description" | "ready" | "waiting" | "failed" | "done" | "outdated" | "empty";

/** A breakdown left for the ai-worker: the card asks for its state until it is done. `queue`: where it stood when the page was rendered. */
interface WaitingRequest {
  requestId: number;
  stage: "pending" | "running";
  queue?: ControlQueueView | null;
}

type StatusFailure = Extract<BreakdownStatusResult, { ok: false }>;

/** The status action's answer in the shape `useControlRequest` reads. */
async function readBreakdown(jobId: number, requestId: number): Promise<ControlRequestRead<null, null, StatusFailure>> {
  const result = await breakdownStatusAction({ jobId, requestId });
  if (result === null) return null;
  if (!result.ok) return result.error === "not_found" ? { state: "missing" } : { state: "failed", failed: result };
  if (result.state === "waiting") {
    const queue = controlQueueViewSchema.nullable().safeParse(result.queue);
    return queue.success ? { state: "waiting", stage: result.stage, queue: queue.data, waiting: null } : null;
  }
  return { state: "done", done: null };
}

function Cap({ children }: { children: ReactNode }) {
  return <span className="text-cap text-ink-3 text-cap-style">{children}</span>;
}

/**
 * The "Job breakdown" card: a button that asks for an AI breakdown of the JD (the AI runs on the host, so the
 * button queues a request and the card polls it), and the structured result with its JD quotes. Off by default; every
 * state of the spec has its own `data-state`.
 */
export function BreakdownPanel({ jobId, availability, hasDescription, view, initialRequest = null, timeZone }: BreakdownPanelProps) {
  const t = useTranslations("jdBreakdown");
  const format = useFormatter();
  const router = useRouter();
  const [error, setError] = useState<{ key: BreakdownErrorKey; detail: string | null; resumeAt?: string | null } | null>(
    initialRequest?.state === "failed" ? { key: initialRequest.error, detail: initialRequest.detail, resumeAt: initialRequest.resumeAt } : null,
  );
  // the time Job Radar's AI usage cap is expected to let the AI work again (a `quota_guard` failure); "none" = not known
  const resumeTime = (resumeAt: string | null | undefined): string => (resumeAt ? formatClock(format, resumeAt, timeZone) : "none");
  const [pending, startTransition] = useTransition();
  const [waiting, setWaiting] = useState<WaitingRequest | null>(initialRequest?.state === "waiting" ? { requestId: initialRequest.requestId, stage: initialRequest.stage, queue: initialRequest.queue } : null);
  const requestId = waiting?.requestId ?? null;

  // A fresh result from the server (the request finished, or a cycle made one): stop waiting.
  const marker = view ? `${view.meta.analyzedAt}|${view.stale.jd}|${view.stale.prompt}|${view.stale.lang}` : null;
  const [seen, setSeen] = useState(marker);
  if (seen !== marker) {
    setSeen(marker);
    setWaiting(null);
    setError(null);
  }

  const fail = (key: BreakdownErrorKey, detail: string | null = null, resumeAt: string | null = null): void => {
    setError({ key, detail, resumeAt });
    toastTone("error", t(`error.${key}`, { time: resumeTime(resumeAt) }));
  };

  // Follow the queued request until the ai-worker has finished it: no wait limit, the queue hint says when the worker is offline.
  const wait = useControlRequest({
    requestId,
    initialStage: waiting?.stage,
    initialQueue: waiting?.queue ?? null,
    read: (id) => readBreakdown(jobId, id),
    onDone: () => {
      setWaiting(null);
      toastTone("success", t("done"));
      router.refresh();
    },
    onFailed: (failed) => {
      setWaiting(null);
      fail(failed?.error ?? "not_found", failed?.detail ?? null, failed?.resumeAt ?? null);
    },
  });
  const stage = waiting ? wait.stage : null;

  const busy = pending || waiting !== null;

  const run = (force: boolean): void => {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof breakdownJobAction>>;
      try {
        result = await breakdownJobAction({ jobId, force });
      } catch {
        result = { ok: false, error: "failed" };
      }
      if (!result.ok) fail(result.error);
      else if (result.queued) setWaiting({ requestId: result.requestId, stage: "pending" });
      else router.refresh();
    });
  };

  const enabled = availability === "enabled";
  const state: PanelState = (() => {
    if (busy) return "waiting";
    if (error) return "failed";
    if (view) return view.content === null ? "outdated" : view.content.total === 0 ? "empty" : "done";
    if (availability === "disabled") return "disabled";
    if (availability === "config_error") return "config_error";
    if (!hasDescription) return "no_description";
    return "ready";
  })();

  const button = (label: string, kind: "primary" | "outline", force: boolean, testId: string, icon: "spark" | "refresh") => (
    <Button type="button" variant={kind === "primary" ? "primary" : "outline"} size={kind === "primary" ? "md" : "sm"} onClick={() => run(force)} disabled={busy} aria-busy={busy} data-testid={testId}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : icon === "refresh" ? <RefreshCw aria-hidden /> : <Sparkles aria-hidden />}
      {busy ? (stage === "running" ? t("running") : t("requesting")) : label}
    </Button>
  );
  /** Re-run control of a shown result: a button, or a grey line when the feature is off. */
  const rerun = enabled && hasDescription ? button(t("rerun"), "outline", true, "jd-breakdown-rerun", "refresh") : <span className="text-ink-3 text-data font-mono" data-testid="jd-breakdown-readonly">{availability === "disabled" ? t("readOnly") : null}</span>;

  const errorBlock = error && !busy ? (
    <div role="alert" className="text-bad text-body-sm [overflow-wrap:anywhere]" data-testid="jd-breakdown-error">
      <p className="font-semibold">
        {t(`error.${error.key}`, { time: resumeTime(error.resumeAt) })}
      </p>
      {error.detail ? (
        <p className="text-ink-3 text-data mt-0.5 font-mono" data-testid="jd-breakdown-error-detail">
          {error.detail}
        </p>
      ) : null}
    </div>
  ) : null;

  const waitingBlock = busy ? (
    <div role="status" className="flex flex-col gap-2.5" data-testid="jd-breakdown-loading" data-stage={stage ?? "requesting"}>
      <div className="flex flex-wrap items-center gap-2">
        {button(t("button"), "primary", false, "jd-breakdown-button", "spark")}
      </div>
      <div className="flex flex-col gap-2" aria-hidden>
        {[72, 88, 56].map((width) => (
          <div key={width} className="bg-soft rounded-cell h-3.5 animate-pulse motion-reduce:animate-none" style={{ width: `${width}%` }} />
        ))}
      </div>
      <p className="text-ink-2 text-body-sm">{t("waitingHint")}</p>
    </div>
  ) : null;
  const queueHint = busy ? <QueueHint queue={wait.queue} stage={stage} timeZone={timeZone} /> : null;

  let body: ReactNode;
  switch (state) {
    case "disabled":
      body = (
        <PlaceholderBox testId="jd-breakdown-disabled">
          <p className="max-w-[64ch]">{t("disabled")}</p>
          <p className="mt-1.5">
            <Link href="/settings?tab=breakdown" className={INK_LINK} data-testid="jd-breakdown-settings-link">
              {t("settingsLink")}
            </Link>
          </p>
        </PlaceholderBox>
      );
      break;
    case "config_error":
      body = <PlaceholderBox testId="jd-breakdown-config-error">{t("configError")}</PlaceholderBox>;
      break;
    case "no_description":
      body = <PlaceholderBox testId="jd-breakdown-no-description">{t("noDescription")}</PlaceholderBox>;
      break;
    case "ready":
    case "failed":
      body = view && view.content ? null : (
        <div className="border-border rounded-card flex flex-col items-start gap-3 border-dashed border-[1.5px] px-4 py-3.5" data-testid="jd-breakdown-ready">
          <p className="text-muted-foreground max-w-[64ch]">{t("readyHint")}</p>
          {errorBlock}
          {button(error ? t("retry") : t("button"), "primary", false, "jd-breakdown-button", error ? "refresh" : "spark")}
        </div>
      );
      break;
    default:
      body = null;
  }

  const hasResult = view !== null && view.content !== null && view.content.total > 0;
  const showResult = hasResult && (state === "done" || state === "waiting" || state === "failed");

  return (
    <div className="flex flex-col gap-3.5" data-testid="jd-breakdown-panel" data-state={state} data-job-id={jobId}>
      {state === "waiting" && !hasResult ? waitingBlock : null}
      {state === "waiting" && hasResult ? <p role="status" className="text-ink-2 text-body-sm flex items-center gap-2" data-testid="jd-breakdown-loading" data-stage={stage ?? "requesting"}><Loader2 className="size-4 animate-spin" aria-hidden /> {stage === "running" ? t("running") : t("requesting")} · {t("waitingHint")}</p> : null}
      {state === "waiting" ? queueHint : null}
      {body}
      {state === "failed" && hasResult ? errorBlock : null}

      {state === "outdated" && view ? (
        <div className="border-border rounded-card flex flex-col items-start gap-3 border-dashed border-[1.5px] px-4 py-3.5" data-testid="jd-breakdown-outdated">
          <p className="text-muted-foreground max-w-[64ch]">{t("outdated")}</p>
          {enabled && hasDescription ? button(t("rerun"), "outline", true, "jd-breakdown-rerun", "refresh") : null}
        </div>
      ) : null}

      {state === "empty" && view ? (
        <div className="border-border rounded-card flex flex-col items-start gap-3 border-dashed border-[1.5px] px-4 py-3.5" data-testid="jd-breakdown-empty">
          <p className="text-muted-foreground max-w-[64ch]">{t("empty")}</p>
          {enabled && hasDescription ? button(t("rerun"), "outline", true, "jd-breakdown-rerun", "refresh") : null}
        </div>
      ) : null}

      {showResult && view && view.content ? <BreakdownResult view={view} content={view.content} rerun={busy ? null : rerun} timeZone={timeZone} dim={busy} /> : null}
    </div>
  );
}

type ViewContent = NonNullable<BreakdownView["content"]>;

function BreakdownResult({ view, content, rerun, timeZone, dim }: { view: BreakdownView; content: ViewContent; rerun: ReactNode; timeZone: string; dim: boolean }) {
  const t = useTranslations("jdBreakdown");
  const format = useFormatter();
  const when = format.dateTime(new Date(view.meta.analyzedAt), { dateStyle: "medium", timeStyle: "short", timeZone });
  const modelText = view.meta.model !== null && view.meta.modelByCliDefault ? `${view.meta.model} (${t("meta.cliDefault")})` : view.meta.model;
  const metaParts = [view.meta.provider, modelText, view.meta.promptVersion, when].filter((part): part is string => part !== null && part !== "");
  const hasTech = content.techGroups.length > 0;
  const lists: Array<{ key: "projects" | "softSkills" | "other"; items: BreakdownViewItem[] }> = [
    { key: "projects", items: content.projects },
    { key: "softSkills", items: content.softSkills },
    { key: "other", items: content.other },
  ];
  const experienceShown = content.experience.yearsMin !== null || content.experience.items.length > 0;
  const gridSections = [experienceShown, content.languages.length > 0, ...lists.map((l) => l.items.length > 0)];
  const anyGrid = gridSections.some(Boolean);

  return (
    <div className={cn("flex flex-col gap-4", dim && "opacity-60")} data-testid="jd-breakdown-result" aria-busy={dim}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-data text-ink-3 font-mono [overflow-wrap:anywhere]" data-testid="jd-breakdown-meta">
            {metaParts.join(" · ")}
            {view.meta.dropped > 0 ? ` · ${t("meta.dropped", { n: view.meta.dropped })}` : ""}
          </p>
          {view.stale.jd || view.stale.prompt || view.stale.lang ? (
            <div className="flex flex-wrap gap-1.5" data-testid="jd-breakdown-stale">
              {view.stale.jd ? (
                <Badge variant="gate-note" data-testid="jd-breakdown-stale-jd">
                  {t("stale.jd")}
                </Badge>
              ) : null}
              {view.stale.prompt ? (
                <Badge variant="gate-note" data-testid="jd-breakdown-stale-prompt">
                  {t("stale.prompt")}
                </Badge>
              ) : null}
              {view.stale.lang ? (
                <Badge variant="gate-note" data-testid="jd-breakdown-stale-lang">
                  {t("stale.lang")}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="shrink-0">{rerun}</div>
      </div>

      {hasTech ? <MatchBlock view={view} content={content} /> : null}

      {content.responsibilities.length > 0 ? (
        <section className="flex flex-col gap-1.5" aria-label={t("sections.responsibilities")} data-testid="jd-breakdown-responsibilities">
          <Cap>{t("sections.responsibilities")}</Cap>
          <ol className="flex flex-col gap-1.5">
            {content.responsibilities.map((item, index) => (
              <li key={index} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-1.5 [overflow-wrap:anywhere]">
                <span className="text-ink-3 text-data pt-px font-mono">{index + 1}.</span>
                <span lang={bcp47(view.meta.outputLang)}>{item.text}</span>
                <SourceButton quote={item} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {hasTech ? (
        <section className="flex flex-col gap-2" aria-label={t("sections.techStack")} data-testid="jd-breakdown-tech">
          <Cap>{t("sections.techStack")}</Cap>
          <div className="flex flex-col gap-2">
            {content.techGroups.map((group) => (
              <div key={group.category} className="grid gap-x-3 gap-y-1 sm:grid-cols-[10rem_minmax(0,1fr)]" data-testid="jd-breakdown-tech-group" data-category={group.category}>
                <span className="text-cap text-ink-3 text-cap-style pt-1">{t(`categories.${group.category}`)}</span>
                <ul className="flex flex-wrap gap-1.5" aria-label={t(`categories.${group.category}`)}>
                  {group.items.map((item) => (
                    <li key={item.name}>
                      <TechChip item={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {anyGrid ? (
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          {experienceShown ? (
            <ItemList lang={bcp47(view.meta.outputLang)} title={t("sections.experience")} testId="jd-breakdown-experience" items={content.experience.items}>
              {content.experience.yearsMin !== null ? (
                <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-1.5 [overflow-wrap:anywhere]" data-testid="jd-breakdown-years">
                  <span className="font-semibold">{t("yearsMin", { n: content.experience.yearsMin })}</span>
                  {content.experience.years ? <SourceButton quote={content.experience.years} /> : <span />}
                </li>
              ) : null}
            </ItemList>
          ) : null}
          {content.languages.length > 0 ? (
            <section className="flex flex-col gap-1.5" aria-label={t("sections.languages")} data-testid="jd-breakdown-languages">
              <Cap>{t("sections.languages")}</Cap>
              <ul className="flex flex-col gap-1.5">
                {content.languages.map((item, index) => (
                  <li key={index} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-1.5 [overflow-wrap:anywhere]">
                    <RequirementTag level={item.requirement} />
                    <span>
                      {item.language} · {item.level === "unspecified" ? t("level.unspecified") : item.level === "native" ? t("level.native") : item.level}
                    </span>
                    <SourceButton quote={item} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {lists.map((list) =>
            list.items.length > 0 ? <ItemList lang={bcp47(view.meta.outputLang)} key={list.key} title={t(`sections.${list.key}`)} testId={`jd-breakdown-${list.key}`} items={list.items} /> : null,
          )}
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs">{t("footnote")}</p>
    </div>
  );
}

function ItemList({ title, testId, items, lang, children }: { title: string; testId: string; items: BreakdownViewItem[]; /** BCP 47 tag of the items' language. */ lang: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={title} data-testid={testId}>
      <Cap>{title}</Cap>
      <ul className="flex flex-col gap-1.5">
        {children}
        {items.map((item, index) => (
          <li key={index} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-1.5 [overflow-wrap:anywhere]">
            <RequirementTag level={item.requirement} />
            <span lang={lang}>{item.text}</span>
            <SourceButton quote={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** `[必须]` / `[加分]`: solid border for must, dashed for nice (colour-independent). */
function RequirementTag({ level }: { level: RequirementLevel | null }) {
  const t = useTranslations("jdBreakdown.requirement");
  if (level === null || !REQUIREMENT_LEVELS.includes(level)) return <span aria-hidden />;
  return (
    <span className={cn("border-border text-data rounded-cell border-[1.5px] px-1 font-mono", level === "nice" ? "text-ink-2 border-dashed" : "text-ink font-semibold")} data-requirement={level}>
      {t(level)}
    </span>
  );
}

/** "Source" button: jumps to the JD sentence; without a highlight to jump to the quote is only a tooltip (text). */
function SourceButton({ quote }: { quote: BreakdownQuote }) {
  const t = useTranslations("jdBreakdown");
  if (quote.quoteIndex === null) {
    return <span className="text-ink-3 text-data-sm cursor-help font-mono" title={quote.quote} data-testid="jd-breakdown-quote-text">{t("quoteButton")}</span>;
  }
  return (
    <JumpTag index={quote.quoteIndex} label={t("jumpTo", { quote: quote.quote })} className="border-border bg-card text-ink-2 text-data-sm hover:bg-soft h-sp-6 gap-1 border-[1.5px] px-1.5 font-mono">
      <Quote aria-hidden className="size-3" />
      <span>{t("quoteButton")}</span>
    </JumpTag>
  );
}

function TechChip({ item }: { item: BreakdownViewTech }) {
  const t = useTranslations("jdBreakdown");
  const variant = item.have === null ? "skill" : item.have ? "skill-hit" : "skill-miss";
  const chip = (
    <Badge variant={variant} data-requirement={item.requirement} data-have={item.have === null ? undefined : item.have} title={item.quoteIndex === null ? item.quote : undefined}>
      {item.name}
      {item.requirement === "nice" ? <span className="text-data-sm ml-1 opacity-70">{t("nice")}</span> : null}
    </Badge>
  );
  if (item.quoteIndex === null) return chip;
  return (
    <JumpTag index={item.quoteIndex} label={t("jumpTo", { quote: item.quote })}>
      {chip}
    </JumpTag>
  );
}

function MatchBlock({ view, content }: { view: BreakdownView; content: ViewContent }) {
  const t = useTranslations("jdBreakdown.match");
  const items = content.techGroups.flatMap((group) => group.items);
  if (view.match.state === "none") {
    return (
      <section className="flex flex-col gap-1" aria-label={t("title")} data-testid="jd-breakdown-match-none">
        <Cap>{t("title")}</Cap>
        <span className="text-data text-ink-2 font-mono">
          {t("noProfile")}{" "}
          <Link href="/me" className="text-primary-foreground bg-hi rounded-cell px-1 font-semibold underline-offset-4 hover:underline">
            {t("profileLink")}
          </Link>
        </span>
      </section>
    );
  }
  const match = view.match;
  return (
    <section className="flex flex-col gap-1.5" aria-label={t("title")} data-testid="jd-breakdown-match">
      <Cap>{t("title")}</Cap>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <SkillOverlap skills={items.map((item) => ({ name: item.name, have: item.have === true }))} />
        <span className="text-data text-ink-2 font-mono" data-testid="jd-breakdown-match-counts">
          {t("counts", { mh: match.must.have, mt: match.must.total, nh: match.nice.have, nt: match.nice.total })}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="jd-breakdown-missing">
        {match.missing.length === 0 ? (
          <span className="text-good text-data font-mono">{t("allHave")}</span>
        ) : (
          <>
            <span className="text-data text-ink-3 font-mono">{t("missing")}</span>
            {match.missing.map((item) => (
              <Badge key={item.name} variant="skill-miss" data-requirement={item.requirement}>
                {item.name}
                {item.requirement === "nice" ? <span className="text-data-sm ml-1 opacity-70">{t("niceSuffix")}</span> : null}
              </Badge>
            ))}
          </>
        )}
      </div>
      {match.years ? (
        <span className="text-data font-mono" data-testid="jd-breakdown-years-match" data-ok={match.years.ok === null ? "unknown" : match.years.ok}>
          {match.years.mine === null ? (
            <span className="text-ink-2">{t("yearsUnknown", { required: match.years.required })}</span>
          ) : (
            <>
              {t("years", { required: match.years.required, mine: match.years.mine })}{" "}
              {match.years.ok ? <span className="text-good">✓</span> : <span className="text-bad">✕</span>}
            </>
          )}
        </span>
      ) : null}
    </section>
  );
}
