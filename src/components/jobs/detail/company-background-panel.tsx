"use client";

import { Loader2, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";

import { companyResearchStatusAction as rawStatusAction, requestCompanyResearchAction as rawRequestAction, type CompanyResearchActionErrorKey, type CompanyResearchStatusResult } from "@/app/jobs/[id]/research-actions";
import { QueueHint } from "@/components/control/queue-hint";
import { useControlRequest, type ControlRequestRead } from "@/components/control/use-control-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INK_LINK } from "@/components/ui/ink-link";
import { callAction, withActionFeedback } from "@/lib/actions/client";
import { controlQueueViewSchema, type ControlQueueView } from "@/lib/control/request-view-schema";
import { formatClock } from "@/lib/format/clock";
import { displayDomain } from "@/lib/research/display-domain";
import type { CompanyResearchContext } from "@/lib/research/view";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { CompanyDomainRow } from "./company-domain-row";
import { CompanyResearchFields } from "./company-research-fields";
import { Panel, PlaceholderBox } from "./panel";

const requestAction = withActionFeedback(rawRequestAction)(() => ({ ok: false, error: "failed" }));
const statusAction = (input: Parameters<typeof rawStatusAction>[0]) => callAction(() => rawStatusAction(input), () => null);

type ErrorKey = CompanyResearchActionErrorKey;
type StatusFailure = Extract<CompanyResearchStatusResult, { ok: false }>;

export async function readCompanyResearchRequestState(jobId: number, requestId: number): Promise<ControlRequestRead<null, null, StatusFailure>> {
  const result = await statusAction({ jobId, requestId });
  if (result === null) return null;
  if (!result.ok) return result.error === "not_found" ? { state: "missing" } : { state: "failed", failed: result };
  if (result.state === "waiting") {
    const queue = controlQueueViewSchema.nullable().safeParse(result.queue);
    return queue.success ? { state: "waiting", stage: result.stage, queue: queue.data, waiting: null } : null;
  }
  return { state: "done", done: null };
}

/**
 * The company background of a job: AI web search results, each field with its source, marked as unverified, all plain
 * text. A button asks the ai-worker for the lookup (off by default); the request is followed until it has finished, then the
 * page refreshes and shows the stored result.
 */
export function CompanyBackgroundPanel({ jobId, company, context, timeZone }: { jobId: number; company: string; context: CompanyResearchContext; timeZone: string }) {
  const t = useTranslations("research.company");
  const tError = useTranslations("research.error");
  const router = useRouter();
  const format = useFormatter();
  const { availability, latest, initialRequest, maxPerDay } = context;

  const [error, setError] = useState<{ key: ErrorKey; detail: string | null; resumeAt?: string | null } | null>(
    initialRequest?.state === "failed" ? { key: initialRequest.error, detail: initialRequest.detail, resumeAt: initialRequest.resumeAt } : null,
  );
  const [pending, startTransition] = useTransition();
  const [waiting, setWaiting] = useState<{ requestId: number; stage: "pending" | "running"; queue?: ControlQueueView | null; auto?: true } | null>(
    initialRequest?.state === "waiting" ? { requestId: initialRequest.requestId, stage: initialRequest.stage, queue: initialRequest.queue, ...(initialRequest.auto ? { auto: true as const } : {}) } : null,
  );

  // a fresh result from the server: stop waiting
  const marker = latest ? `${latest.id}` : null;
  const [seen, setSeen] = useState(marker);
  if (seen !== marker) {
    setSeen(marker);
    setWaiting(null);
    setError(null);
  }

  // the counter of the last 24 hours: the server's count, updated by a queued request without a reload
  const [used, setUsed] = useState(context.usedToday);
  const [seenUsed, setSeenUsed] = useState(context.usedToday);
  if (seenUsed !== context.usedToday) {
    setSeenUsed(context.usedToday);
    setUsed(context.usedToday);
  }
  const usedUp = used >= maxPerDay;

  const errorText = (key: ErrorKey, resumeAt: string | null = null): string =>
    key === "auth"
      ? tError("auth", { providers: context.providers.join(", ") })
      : key === "quota_guard"
        ? tError("quota_guard", { time: resumeAt ? formatClock(format, resumeAt, timeZone) : "none" })
        : tError(key);
  const fail = (key: ErrorKey, detail: string | null = null, resumeAt: string | null = null): void => {
    if (key === "quota") setUsed((current) => Math.max(current, maxPerDay));
    setError({ key, detail, resumeAt });
    toastTone("error", errorText(key, resumeAt));
  };

  // Follow the queued request until the ai-worker has finished it: no wait limit, the queue hint says when the worker is offline.
  const wait = useControlRequest({
    requestId: waiting?.requestId ?? null,
    initialStage: waiting?.stage,
    initialQueue: waiting?.queue ?? null,
    read: (id) => readCompanyResearchRequestState(jobId, id),
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
  // an automatic request still waiting stays pressable: the press moves it to the interactive lane
  const busy = pending || (waiting !== null && !(waiting.auto === true && stage === "pending"));

  const run = (force: boolean): void => {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof requestAction>>;
      try {
        result = await requestAction({ jobId, force });
      } catch {
        result = { ok: false, error: "failed" };
      }
      if (!result.ok) fail(result.error);
      else if (result.queued) {
        setUsed(result.usedToday);
        setWaiting({ requestId: result.requestId, stage: "pending" });
      } else router.refresh();
    });
  };

  const enabled = availability === "enabled";
  const blocked = usedUp && !busy;
  const state = busy ? "waiting" : error ? "failed" : latest ? "done" : availability === "enabled" ? "ready" : availability;

  const button = (label: string, force: boolean, testId: string, primary: boolean) => (
    <Button type="button" variant={primary ? "primary" : "outline"} size={primary ? "md" : "sm"} onClick={() => run(force)} disabled={busy || blocked} aria-busy={busy} aria-describedby={blocked ? "company-research-quota" : undefined} data-testid={testId} data-blocked={blocked ? "quota" : undefined}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : force ? <RefreshCw aria-hidden /> : <Search aria-hidden />}
      {busy ? (stage === "running" ? t("running") : t("requesting")) : label}
    </Button>
  );

  const errorBlock =
    error && !busy && error.key !== "quota" ? (
      <div role="alert" className="text-bad text-body-sm [overflow-wrap:anywhere]" data-testid="company-research-error" data-error={error.key}>
        <p className="font-semibold">{errorText(error.key, error.resumeAt ?? null)}</p>
        {error.detail ? <p className="text-ink-3 text-data mt-0.5 font-mono">{error.detail}</p> : null}
      </div>
    ) : null;

  const quota = enabled ? (
    <p id="company-research-quota" className={cn("text-data font-mono", usedUp ? "text-bad" : "text-ink-3")} data-testid="company-research-quota" data-used={used} data-max={maxPerDay} data-used-up={usedUp}>
      {usedUp ? t("quotaUsedUp", { used, max: maxPerDay }) : t("quota", { used, max: maxPerDay })}
    </p>
  ) : null;

  let actions: ReactNode = null;
  switch (availability) {
    case "disabled":
      // a stored result stays readable after the feature was turned off; there is just no way to run it again
      break;
    case "no_web_provider":
      actions = (
        <PlaceholderBox testId="company-research-no-provider">
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
      actions = <PlaceholderBox testId="company-research-config-error">{t("configError")}</PlaceholderBox>;
      break;
    case "not_ready":
      actions = <PlaceholderBox testId="company-research-not-ready">{t("notReady")}</PlaceholderBox>;
      break;
    case "enabled":
      actions = (
        <div className={cn("flex flex-col items-start gap-3", !latest && "border-border rounded-card border-dashed border-[1.5px] px-4 py-3.5")} data-testid={latest ? "company-research-rerun" : "company-research-ready"}>
          {!latest ? <p className="text-muted-foreground max-w-[64ch]">{t("readyHint", { company })}</p> : null}
          {context.unrestricted ? (
            <p className="text-ink-2 text-body-sm" data-testid="company-research-unrestricted">
              {t("unrestricted")}
            </p>
          ) : null}
          {errorBlock}
          {latest ? button(t("refresh"), true, "company-research-refresh", false) : button(error && error.key !== "quota" && !usedUp ? t("retry") : t("button"), false, "company-research-button", true)}
          {quota}
        </div>
      );
      break;
  }

  const when = latest ? format.dateTime(new Date(latest.fetchedAt), { dateStyle: "medium", timeStyle: "short", timeZone }) : null;
  const meta = latest ? [latest.provider, latest.model, when].filter((part): part is string => part !== null && part !== "").join(" · ") : "";

  return (
    <Panel id="h-company-background" title={t("title")} aside={<Badge variant="gate-note" className="max-w-full whitespace-normal" data-testid="company-research-badge">{t("badge")}</Badge>} bodyClassName="flex flex-col gap-3.5">
      <div className="flex min-w-0 flex-col gap-3.5" data-testid="company-research-panel" data-state={state}>
        {latest ? (
          <div className={cn("flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]", busy && "opacity-60")} aria-busy={busy} data-testid="company-research-result">
            {latest.expired ? (
              <p className="text-ink-2 text-body-sm" data-testid="company-research-expired">
                {t("expired", { days: context.ttlDays })}
              </p>
            ) : null}
            {context.domainChanged ? (
              <p className="text-ink-2 text-body-sm" data-testid="company-research-domain-changed">
                {t("domainChanged")}
              </p>
            ) : null}
            <CompanyResearchFields fields={latest.fields} />
            {latest.dropped > 0 ? (
              <p className="text-ink-3 text-data font-mono" data-testid="company-research-dropped">
                {t("dropped", { n: latest.dropped })}
              </p>
            ) : null}
            <div className="border-border border-t pt-2.5">
              <p className="text-data text-ink-3 font-mono [overflow-wrap:anywhere]" data-testid="company-research-meta">
                {meta}
              </p>
              <p className="text-ink-2 text-body-sm mt-1" data-testid="company-research-sent">
                {latest.domainUsed !== null ? t("sentWithDomain", { domain: displayDomain(latest.domainUsed) }) : t("sentNameOnly")}
              </p>
            </div>
          </div>
        ) : null}
        {enabled && context.companyId !== null ? <CompanyDomainRow companyId={context.companyId} website={context.website} /> : null}
        {actions}
        {/* a failed request newer than the stored result is reported even when the lookup is off (the enabled case shows it above its button) */}
        {enabled ? null : errorBlock}
        {/* the one live region of the panel: the waiting line and the queue lines are read as one */}
        <div role="status" className="flex flex-col gap-1 empty:hidden" data-testid="company-research-status">
          {busy ? (
            <>
              <p className="text-ink-2 text-body-sm flex items-center gap-2" data-testid="company-research-loading" data-stage={stage ?? "requesting"}>
                <Loader2 className="size-4 animate-spin" aria-hidden /> {stage === "running" ? t("running") : t("requesting")} · {t("waitingHint")}
              </p>
              <QueueHint queue={wait.queue} stage={stage} timeZone={timeZone} live={false} />
            </>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
