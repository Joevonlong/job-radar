"use client";

import { ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";

import { lookupSalaryAction as rawLookupSalaryAction, salaryLookupStatusAction as rawSalaryLookupStatusAction, type SalaryActionErrorKey, type SalaryLookupStatusResult } from "@/app/jobs/[id]/salary-actions";
import { QueueHint } from "@/components/control/queue-hint";
import { useControlRequest, type ControlRequestRead } from "@/components/control/use-control-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INK_LINK } from "@/components/ui/ink-link";
import { useAppLocale } from "@/components/viz/intl";
import type { AiProviderId } from "@/lib/ai/types";
import { controlQueueViewSchema, type ControlQueueView } from "@/lib/control/request-view-schema";
import type { InitialSalaryRequest } from "@/lib/control/salary-request";
import { formatClock } from "@/lib/format/clock";
import { formatSalary } from "@/lib/format/numbers";
import type { SalaryBand, SalarySource } from "@/lib/salary/lookup-types";
import { percentileIn } from "@/lib/salary/percentile";
import type { LookupAvailability, SalaryLookupView } from "@/lib/salary/view";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { PlaceholderBox } from "./panel";
import { callAction, withActionFeedback } from "@/lib/actions/client";

const lookupSalaryAction = withActionFeedback(rawLookupSalaryAction)(() => ({ ok: false, error: "failed" }));
const salaryLookupStatusAction = (input: Parameters<typeof rawSalaryLookupStatusAction>[0]) => callAction(() => rawSalaryLookupStatusAction(input), () => null);

/** What the lookup state machine reads from the page. */
export interface SalaryLookupInput {
  jobId: number;
  availability: LookupAvailability;
  /** The providers the lookup may use, in order: an auth failure names only their logins. */
  providers: readonly AiProviderId[];
  latest: SalaryLookupView | null;
  initialRequest: InitialSalaryRequest | null;
  usedToday: number;
  maxPerDay: number;
  timeZone: string;
}

type ErrorKey = SalaryActionErrorKey;
type StatusFailure = Extract<SalaryLookupStatusResult, { ok: false }>;

/** The status action's answer in the shape `useControlRequest` reads. */
async function readLookup(jobId: number, requestId: number): Promise<ControlRequestRead<null, null, StatusFailure>> {
  const result = await salaryLookupStatusAction({ jobId, requestId });
  if (result === null) return null;
  if (!result.ok) return result.error === "not_found" ? { state: "missing" } : { state: "failed", failed: result };
  if (result.state === "waiting") {
    const queue = controlQueueViewSchema.nullable().safeParse(result.queue);
    return queue.success ? { state: "waiting", stage: result.stage, queue: queue.data, waiting: null } : null;
  }
  return { state: "done", done: null };
}

const KNOWN_SENIORITIES = ["entry", "mid", "senior", "lead"] as const;
const isKnownSeniority = (value: string | null): value is (typeof KNOWN_SENIORITIES)[number] => KNOWN_SENIORITIES.some((s) => s === value);

/** How to fix a rejected login or key of each provider (shown after an auth failure; commands, not translated). */
const AUTH_FIX: Record<AiProviderId, string> = {
  "claude-cli": "claude → /login",
  "codex-cli": "codex login",
  anthropic: "ANTHROPIC_API_KEY (.env)",
  openai: "OPENAI_API_KEY (.env)",
  openrouter: "OPENROUTER_API_KEY (.env)",
  deepseek: "DEEPSEEK_API_KEY (.env)",
  mimo: "MIMO_API_KEY (.env)",
};

/** Only an https link is ever rendered as a link (the stored sources were checked; this is the second fence). */
const safeHref = (url: string): string | null => {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

function Cap({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="text-cap text-ink-3 text-cap-style">
      {children}
    </h3>
  );
}

export type LookupState = "disabled" | "no_web_provider" | "config_error" | "not_ready" | "ready" | "waiting" | "failed" | "done";

export interface SalaryLookupState {
  state: LookupState;
  busy: boolean;
  stage: "pending" | "running" | null;
  queue: ControlQueueView | null;
  error: { key: ErrorKey; detail: string | null; resumeAt?: string | null } | null;
  /** The text of an error, with the logins to fix or the time the AI usage cap lifts. */
  errorText: (key: ErrorKey, resumeAt?: string | null) => string;
  used: number;
  maxPerDay: number;
  usedUp: boolean;
  run: (force: boolean) => void;
}

/**
 * The salary lookup's state machine: a button asks the ai-worker to search the web for this company's salaries (off by default,
 * the one task allowed to reach the web); the request is followed until the worker has finished it, then the page refreshes and
 * shows the stored result. Every state is one of `LookupState` (the panel's `data-lookup-state`).
 */
export function useSalaryLookup(props: SalaryLookupInput): SalaryLookupState {
  const { jobId, availability, latest, initialRequest } = props;
  const t = useTranslations("salary.lookup");
  const tError = useTranslations("salary.error");
  const router = useRouter();
  const format = useFormatter();
  const [error, setError] = useState<{ key: ErrorKey; detail: string | null; resumeAt?: string | null } | null>(
    initialRequest?.state === "failed" ? { key: initialRequest.error, detail: initialRequest.detail, resumeAt: initialRequest.resumeAt } : null,
  );
  const [pending, startTransition] = useTransition();
  const [waiting, setWaiting] = useState<{ requestId: number; stage: "pending" | "running"; queue?: ControlQueueView | null } | null>(
    initialRequest?.state === "waiting" ? { requestId: initialRequest.requestId, stage: initialRequest.stage, queue: initialRequest.queue } : null,
  );
  const requestId = waiting?.requestId ?? null;

  // a fresh result from the server: stop waiting
  const marker = latest ? `${latest.id}` : null;
  const [seen, setSeen] = useState(marker);
  if (seen !== marker) {
    setSeen(marker);
    setWaiting(null);
    setError(null);
  }

  // the counter of the last 24 hours: the server's count, updated by a queued request without a reload
  const [used, setUsed] = useState(props.usedToday);
  const [seenUsed, setSeenUsed] = useState(props.usedToday);
  if (seenUsed !== props.usedToday) {
    setSeenUsed(props.usedToday);
    setUsed(props.usedToday);
  }
  const usedUp = used >= props.maxPerDay;

  // `resumeAt`: with `quota_guard`, when Job Radar's AI usage cap is expected to let the AI work again ("none" = not known)
  const errorText = (key: ErrorKey, resumeAt: string | null = null): string =>
    key === "auth"
      ? tError("auth", { providers: props.providers.join(", "), fixes: props.providers.map((id) => AUTH_FIX[id]).join(", ") })
      : key === "quota_guard"
        ? tError("quota_guard", { time: resumeAt ? formatClock(format, resumeAt, props.timeZone) : "none" })
        : tError(key);
  const fail = (key: ErrorKey, detail: string | null = null, resumeAt: string | null = null): void => {
    if (key === "quota") setUsed((current) => Math.max(current, props.maxPerDay));
    setError({ key, detail, resumeAt });
    toastTone("error", errorText(key, resumeAt));
  };

  // Follow the queued request until the ai-worker has finished it: no wait limit, the queue hint says when the worker is offline.
  const wait = useControlRequest({
    requestId,
    initialStage: waiting?.stage,
    initialQueue: waiting?.queue ?? null,
    read: (id) => readLookup(jobId, id),
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
      let result: Awaited<ReturnType<typeof lookupSalaryAction>>;
      try {
        result = await lookupSalaryAction({ jobId, force });
      } catch {
        result = { ok: false, error: "failed" };
      }
      if (!result.ok) fail(result.error);
      else if (result.queued) {
        setUsed(result.usedToday);
        setWaiting({ requestId: result.requestId, stage: "pending" });
      }
      else router.refresh();
    });
  };

  const state: LookupState = busy ? "waiting" : error ? "failed" : latest ? "done" : availability === "enabled" ? "ready" : availability;
  return { state, busy, stage, queue: wait.queue, error, errorText, used, maxPerDay: props.maxPerDay, usedUp, run };
}

/**
 * The right column under the ruler: the lookup button (or why there is none), the daily quota, the one live region
 * (the "waiting" line and the queue lines together) and the one alert. A stored result stays shown when the lookup has
 * been turned off since; the column then says why it cannot be run again.
 */
export function LookupActions({ lookup, availability, hasResult, company, unrestricted, timeZone }: { lookup: SalaryLookupState; availability: LookupAvailability; hasResult: boolean; company: string; unrestricted: boolean; timeZone: string }) {
  const t = useTranslations("salary.lookup");
  const { busy, stage, error, usedUp } = lookup;
  const enabled = availability === "enabled";
  // the daily limit is used up: no button to press until earlier lookups age out (the quota line says why)
  const blocked = usedUp && !busy;
  const button = (label: string, force: boolean, testId: string, primary: boolean) => (
    <Button type="button" variant={primary ? "primary" : "outline"} size={primary ? "md" : "sm"} onClick={() => lookup.run(force)} disabled={busy || blocked} aria-busy={busy} aria-describedby={blocked ? "salary-lookup-quota" : undefined} data-testid={testId} data-blocked={blocked ? "quota" : undefined}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : force ? <RefreshCw aria-hidden /> : <Search aria-hidden />}
      {busy ? (stage === "running" ? t("running") : t("requesting")) : label}
    </Button>
  );

  const errorBlock =
    enabled && error && !busy && error.key !== "quota" ? (
      <div role="alert" className="text-bad text-body-sm [overflow-wrap:anywhere]" data-testid="salary-lookup-error" data-error={error.key}>
        <p className="font-semibold">{lookup.errorText(error.key, error.resumeAt ?? null)}</p>
        {error.detail ? <p className="text-ink-3 text-data mt-0.5 font-mono">{error.detail}</p> : null}
      </div>
    ) : null;

  const quota = enabled ? (
    <p id="salary-lookup-quota" className={cn("text-data font-mono", usedUp ? "text-bad" : "text-ink-3")} data-testid="salary-lookup-quota" data-used={lookup.used} data-max={lookup.maxPerDay} data-used-up={usedUp}>
      {usedUp ? t("quotaUsedUp", { used: lookup.used, max: lookup.maxPerDay }) : t("quota", { used: lookup.used, max: lookup.maxPerDay })}
    </p>
  ) : null;

  let body: ReactNode = null;
  switch (availability) {
    case "disabled":
      body = (
        <PlaceholderBox testId="salary-lookup-disabled">
          <p className="max-w-[64ch]">{t("disabled")}</p>
          <p className="mt-1.5">
            <Link href="/settings?tab=salary" className={INK_LINK} data-testid="salary-lookup-settings-link">
              {t("settingsLink")}
            </Link>
          </p>
        </PlaceholderBox>
      );
      break;
    case "no_web_provider":
      body = (
        <PlaceholderBox testId="salary-lookup-no-provider">
          <p className="max-w-[64ch]">{t("noProvider")}</p>
          <p className="mt-1.5">
            <Link href="/settings?tab=ai" className={INK_LINK}>
              {t("aiSettingsLink")}
            </Link>
          </p>
        </PlaceholderBox>
      );
      break;
    case "config_error":
      body = <PlaceholderBox testId="salary-lookup-config-error">{t("configError")}</PlaceholderBox>;
      break;
    case "not_ready":
      body = <PlaceholderBox testId="salary-lookup-not-ready">{t("notReady")}</PlaceholderBox>;
      break;
    case "enabled":
      body = (
        <div className={cn("flex flex-col items-start gap-3", !hasResult && "border-border rounded-card border-dashed border-[1.5px] px-4 py-3.5")} data-testid={hasResult ? "salary-lookup-rerun" : "salary-lookup-ready"}>
          {!hasResult ? <p className="text-muted-foreground max-w-[64ch]">{t("readyHint", { company })}</p> : null}
          {unrestricted ? (
            <p className="text-ink-2 text-body-sm" data-testid="salary-lookup-unrestricted">
              {t("unrestricted")}
            </p>
          ) : null}
          {errorBlock}
          {hasResult ? button(t("refresh"), true, "salary-lookup-refresh", false) : button(error && error.key !== "quota" && !usedUp ? t("retry") : t("button"), false, "salary-lookup-button", true)}
          {quota}
        </div>
      );
      break;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="salary-lookup-actions">
      {body}
      {/* the one live region of the panel: the waiting line and the queue lines are read as one */}
      <div role="status" className="flex flex-col gap-1" data-testid="salary-lookup-status">
        {busy ? (
          <>
            <p className="text-ink-2 text-body-sm flex items-center gap-2" data-testid="salary-lookup-loading" data-stage={stage ?? "requesting"}>
              <Loader2 className="size-4 animate-spin" aria-hidden /> {stage === "running" ? t("running") : t("requesting")} · {t("waitingHint")}
            </p>
            <QueueHint queue={lookup.queue} stage={stage} timeZone={timeZone} live={false} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The stored result in full: who answered, the disclaimer and scope, the company's level, the role's band, related roles, sources and notes. */
export function LookupDetails({
  jobId,
  latest,
  currency,
  groupQuantiles,
  timeZone,
  ttlDays,
  busy,
}: {
  jobId: number;
  latest: SalaryLookupView;
  /** The base currency the figures are in. */
  currency: string;
  /** The benchmark group the ruler shows (its p10..p90), for "about P80 of the group". */
  groupQuantiles: number[] | null;
  timeZone: string;
  ttlDays: number;
  /** A refresh is running: the shown result is dimmed. */
  busy: boolean;
}) {
  const t = useTranslations("salary.lookup");
  const tSeniority = useTranslations("salary.seniority");
  const format = useFormatter();
  const locale = useAppLocale();
  const { result, origin } = latest;
  const money = (value: number, cur: string = currency): string => formatSalary({ min: value, max: value, currency: cur }, { locale }) ?? "";
  const when = format.dateTime(new Date(latest.fetchedAt), { dateStyle: "medium", timeStyle: "short", timeZone });
  const meta = [latest.provider, latest.model, when].filter((part): part is string => part !== null && part !== "").join(" · ");
  const hasFigures = result.companyLevel.median !== null || result.roleBand !== null || result.relatedRoles.length > 0;

  const sourceRefs = (indexes: number[]): ReactNode =>
    indexes.length > 0 ? (
      <span className="text-ink-3 text-data ml-1 font-mono">
        {indexes.map((index) => (
          <a key={index} href={`#salary-source-${index + 1}`} className={cn(INK_LINK, "mr-1 decoration-1")} aria-label={t("sourceRef", { n: index + 1 })}>
            [{index + 1}]
          </a>
        ))}
      </span>
    ) : null;

  const band = (item: SalaryBand, testId: string, key?: number) => {
    const figure = item.median ?? (item.min !== null && item.max !== null ? (item.min + item.max) / 2 : (item.min ?? item.max));
    const position = item.convertible && item.basis !== "total" && figure !== null && groupQuantiles ? percentileIn(groupQuantiles, figure) : null;
    const range = item.convertible
      ? formatSalary({ min: item.min, max: item.max, currency }, { locale })
      : formatSalary({ min: item.original.min, max: item.original.max, currency: item.original.currency ?? "" }, { locale });
    const median = item.convertible ? (item.median !== null ? money(item.median) : null) : item.original.median !== null ? money(item.original.median, item.original.currency ?? "") : null;
    const details = [isKnownSeniority(item.seniority) ? tSeniority(item.seniority) : null, item.location, t(`basis.${item.basis}`)].filter((part): part is string => part !== null && part !== "");
    return (
      <li key={key} className="flex flex-col gap-0.5 [overflow-wrap:anywhere]" data-testid={testId}>
        <span className="font-semibold">
          {item.title}
          {sourceRefs(item.sources)}
        </span>
        <span className="text-ink-2 text-body-sm" data-testid={`${testId}-unverified`}>{t("unverified")}</span>
        <span className="text-body-sm">
          <span className="font-mono">{range ?? "–"}</span>
          {median ? <span className="text-ink-2"> · {t("bandMedian", { amount: median })}</span> : null}
          {position ? (
            <span className="text-ink-2" data-testid={`${testId}-percentile`}>
              {" "}
              ·{" "}
              {position.clamp === "below"
                ? t("bandVsGroupBelow")
                : position.clamp === "above"
                  ? t("bandVsGroupAbove")
                  : t("bandVsGroup", { p: Math.round(position.value) })}
            </span>
          ) : null}
        </span>
        <span className="text-ink-3 text-data font-mono">{details.join(" · ")}</span>
        {!item.convertible ? <span className="text-ink-3 text-body-sm">{t("notConvertible", { currency: item.original.currency ?? "?" })}</span> : null}
      </li>
    );
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere]", busy && "opacity-60")} data-testid="salary-lookup-result" aria-busy={busy} data-confidence={result.confidence}>
      <div className="flex flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-data text-ink-3 font-mono [overflow-wrap:anywhere]" data-testid="salary-lookup-meta">
            {meta}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="gate-note" data-testid="salary-lookup-ai-badge">{t("aiBadge")}</Badge>
            <Badge variant={result.confidence === "low" ? "gate-warn" : "gate-note"} className="max-w-full whitespace-normal" data-testid="salary-lookup-confidence">
              {t("confidenceLabel")}: {t(`confidence.${result.confidence}`)}
            </Badge>
            {latest.expired ? (
              <Badge variant="gate-note" className="max-w-full whitespace-normal" data-testid="salary-lookup-expired">
                {t("expired", { days: ttlDays })}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
      <p className="border-border bg-soft rounded-card text-body-sm border-[1.5px] px-3 py-2" data-testid="salary-lookup-disclaimer">
        {t("disclaimer")}
      </p>
      <p className="text-ink-2 text-body-sm" data-testid="salary-lookup-scope">{t("scope")}</p>
      {origin?.jobId !== jobId ? (
        <p className="text-ink-2 text-body-sm" data-testid="salary-lookup-origin">
          {origin ? (
            t.rich("origin", {
              title: origin.title,
              link: (chunks) => <Link href={`/jobs/${origin.jobId}`} className={INK_LINK}>{chunks}</Link>,
            })
          ) : t("originDeleted")}
        </p>
      ) : null}

      {!hasFigures ? <p className="text-muted-foreground">{t("empty")}</p> : null}

      <section className="flex flex-col gap-1" aria-labelledby="salary-lookup-company" data-testid="salary-lookup-company" data-level={result.companyLevel.level}>
        <Cap id="salary-lookup-company">{t("companyHeading")}</Cap>
        <p className="text-ink-2 text-body-sm" data-testid="salary-lookup-company-unverified">{t("unverified")}</p>
        <p className="font-semibold">
          {t(`companyLevel.${result.companyLevel.level}`)}
          {result.companyLevel.median !== null ? <span className="text-ink-2 font-normal"> · {t("companyMedian", { amount: money(result.companyLevel.median) })}</span> : null}
          {sourceRefs(result.companyLevel.sources)}
        </p>
        {result.companyLevel.summary ? <p className="text-ink-2 text-body-sm max-w-[72ch] [overflow-wrap:anywhere]">{result.companyLevel.summary}</p> : null}
      </section>

      <section className="flex flex-col gap-1.5" aria-labelledby="salary-lookup-role">
        <Cap id="salary-lookup-role">{t("roleHeading")}</Cap>
        {result.roleBand ? <ul>{band(result.roleBand, "salary-lookup-role")}</ul> : <p className="text-ink-3 text-body-sm">{t("noRole")}</p>}
      </section>

      {result.relatedRoles.length > 0 ? (
        <section className="flex flex-col gap-1.5" aria-labelledby="salary-lookup-related">
          <Cap id="salary-lookup-related">{t("relatedHeading")}</Cap>
          <ul className="flex flex-col gap-2.5" data-testid="salary-lookup-related">
            {result.relatedRoles.map((item, index) => band(item, `salary-lookup-related-${index}`, index))}
          </ul>
        </section>
      ) : null}

      {result.sources.length > 0 ? (
        <div role="group" className="flex flex-col gap-1.5" aria-labelledby="salary-lookup-sources">
          <Cap id="salary-lookup-sources">{t("sourcesHeading")}</Cap>
          <ol className="flex flex-col gap-2" data-testid="salary-lookup-sources">
            {result.sources.map((source, index) => (
              <SourceItem key={index} source={source} index={index} />
            ))}
          </ol>
        </div>
      ) : null}

      {result.notes ? (
        <section className="flex flex-col gap-1" aria-labelledby="salary-lookup-notes">
          <Cap id="salary-lookup-notes">{t("notesHeading")}</Cap>
          <p className="text-ink-2 text-body-sm max-w-[72ch] [overflow-wrap:anywhere]">{result.notes}</p>
        </section>
      ) : null}
      {result.dropped > 0 ? (
        <p className="text-ink-3 text-data font-mono" data-testid="salary-lookup-dropped">
          {t("dropped", { n: result.dropped })}
        </p>
      ) : null}
    </div>
  );
}

function SourceItem({ source, index }: { source: SalarySource; index: number }) {
  const t = useTranslations("salary.lookup");
  const href = safeHref(source.url);
  return (
    <li id={`salary-source-${index + 1}`} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-1.5 [overflow-wrap:anywhere]" data-testid="salary-lookup-source" data-trusted={source.trusted}>
      <span className="text-ink-3 text-data pt-px font-mono">[{index + 1}]</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cn(INK_LINK, "inline-flex items-center gap-1 font-mono")}>
              {source.host}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : (
            <span className="font-mono">{source.host}</span>
          )}
          {!source.trusted ? (
            <Badge variant="gate-note" className="max-w-full whitespace-normal" data-testid="salary-lookup-other-source">
              {t("otherSource")}
            </Badge>
          ) : null}
        </span>
        {source.title ? <span className="text-body-sm">{source.title}</span> : null}
        {source.excerpt ? <span className="text-ink-3 text-body-sm">“{source.excerpt}”</span> : null}
      </span>
    </li>
  );
}
