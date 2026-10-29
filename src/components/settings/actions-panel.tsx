"use client";

import { CheckCircle2, CircleDashed, Loader2, Play, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useState, useTransition } from "react";

import { AiRunStatus } from "@/components/ai-run-status";
import { TriggerButton } from "@/components/control/trigger-button";
import { rescoreStaleAction as rawRescoreStaleAction, runCycleAction as rawRunCycleAction, scoreJobsAction as rawScoreJobsAction } from "@/app/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IDLE_CONTROL_STATE, type ControlActionState } from "@/lib/control/service-types";
import { formatClock } from "@/lib/format/clock";
import { ageParts } from "@/lib/settings/age";
import type { ControlRequestView, ControlStatus } from "@/lib/settings/status-schema";
import { cn } from "@/lib/utils";
import { INK_LINK } from "@/components/ui/ink-link";
import { withActionFeedback } from "@/lib/actions/client";

const rescoreStaleAction = withActionFeedback(rawRescoreStaleAction)(() => ({ status: "error", error: "databaseUnavailable", nonce: Date.now() }));
const runCycleAction = withActionFeedback(rawRunCycleAction)(() => ({ status: "error", error: "databaseUnavailable", nonce: Date.now() }));
const scoreJobsAction = withActionFeedback(rawScoreJobsAction)(() => ({ status: "error", error: "databaseUnavailable", nonce: Date.now() }));

const ERROR_CODES = ["invalid_payload", "another_cycle_running", "backfill_over_limit", "cycle_failed", "handler_error", "no_handler", "rescore_failed", "rescore_stopped", "rescore_profile_incomplete", "rescore_ai_unavailable", "score_failed", "score_stopped", "score_profile_incomplete", "score_ai_unavailable", "quota_guard"] as const;

function useAgeText() {
  const t = useTranslations("settings.control.age");
  return (seconds: number): string => {
    const { unit, count } = ageParts(seconds);
    return t(unit, { count });
  };
}

function RunnerLine({ status }: { status: ControlStatus | null }) {
  const t = useTranslations("settings.control.runner");
  const ageText = useAgeText();
  if (status === null) {
    return (
      <p className="text-destructive flex items-center gap-2 text-sm" data-testid="runner-line" data-state="unavailable">
        <XCircle aria-hidden className="size-4" /> {t("unavailable")}
      </p>
    );
  }
  const { heartbeat } = status;
  if (heartbeat.ageSeconds === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" data-testid="runner-line" data-state="never">
        <CircleDashed aria-hidden className="size-4" /> {t("never")}
      </p>
    );
  }
  const age = ageText(heartbeat.ageSeconds);
  return (
    <p className={cn("flex items-center gap-2 text-sm", heartbeat.online ? "text-success-text" : "text-warning-text")} data-testid="runner-line" data-state={heartbeat.online ? "online" : "stale"}>
      {heartbeat.online ? <CheckCircle2 aria-hidden className="size-4" /> : <XCircle aria-hidden className="size-4" />}
      {heartbeat.online ? t("online", { age }) : t("stale", { age })}
    </p>
  );
}

function RequestRow({ request, timezone, aiRunning }: { request: ControlRequestView; timezone: string; aiRunning: boolean }) {
  const t = useTranslations("settings.control.requests");
  const tCycle = useTranslations("dashboard.cycle");
  const format = useFormatter();
  const time = format.dateTime(new Date(request.requestedAt), { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: timezone });
  // the collect part of a manual cycle is done, but its AI stage (score, signals, translate) still runs on the ai-worker
  const aiStage = aiRunning && request.status === "done" && request.kind === "run_cycle";
  const open = request.status === "pending" || request.status === "running" || aiStage;
  const errorCode = ERROR_CODES.find((code) => code === request.error);

  let detail: string | null = null;
  const { cycle } = request;
  if (cycle) {
    detail =
      cycle.status === "running"
        ? t("progress", { id: cycle.id, finished: cycle.runsFinished, total: cycle.runsTotal, fetched: cycle.fetched })
        : t("cycleResult", { id: cycle.id, state: tCycle(`state.${cycle.status}`), fetched: cycle.fetched, fresh: cycle.newCount });
  } else if (request.kind === "rescore_stale" && request.status === "done") {
    detail = request.placeholder ? t("placeholder") : t("rescoreResult", { scored: request.scored ?? 0, failed: request.failed ?? 0 });
  } else if (request.kind === "score_jobs" && request.status === "done") {
    detail = request.placeholder ? t("placeholder") : t("scoreResult", { scored: request.scored ?? 0, failed: request.failed ?? 0 });
  }

  return (
    <li className="border-border flex flex-col gap-1 rounded-md border px-3 py-2" data-testid="control-request" data-status={request.status} data-kind={request.kind}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{t(`kind.${request.kind}`)}</span>
        <Badge
          variant="outline"
          className={cn(
            "font-normal",
            request.status === "done" && !aiStage && "text-success-text border-success/40",
            request.status === "failed" && "text-destructive border-destructive/40",
            open && "text-warning-text border-warning/40",
          )}
        >
          {open ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {aiStage ? t("status.ai_running") : t(`status.${request.status}`)}
        </Badge>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">#{request.id}</span>
        <span className="text-muted-foreground ml-auto text-xs">{t("at", { time })}</span>
      </div>
      {request.jobIds ? <p className="text-muted-foreground font-mono text-xs break-words">{t("jobs", { jobs: request.jobIds.map((id) => `#${id}`).join(", ") })}</p> : null}
      {request.channelIds ? <p className="text-muted-foreground font-mono text-xs break-words">{t("channels", { channels: request.channelIds.join(", ") })}</p> : null}
      {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
      {request.stopped === "time_budget" ? (
        <p className="text-muted-foreground text-xs" data-testid="control-request-time-budget">
          {t("timeBudget", { remaining: request.remaining ?? 0 })}
        </p>
      ) : request.status === "failed" ? (
        <p className="text-destructive text-xs">
          {errorCode ? t(`error.${errorCode}`, { time: request.resumeAt ? formatClock(format, request.resumeAt, timezone) : "none" }) : t("error.unknown")}
        </p>
      ) : null}
      {request.cycle && !open ? (
        <Link href="/sources" className={cn(INK_LINK, "w-fit text-xs")}>
          {t("viewSources")}
        </Link>
      ) : null}
    </li>
  );
}

interface ActionsPanelProps {
  status: ControlStatus | null;
  /** Called after a request was created, so the page asks for the new status right away. */
  onRequested: () => void;
  /** Enabled channels a manual cycle can be limited to. */
  channelChoices: string[];
  timezone: string;
}

/** "Run a cycle now" and "re-score N stale scores": leave a request for the runner and show how it goes. */
export function ActionsPanel({ status, onRequested, channelChoices, timezone }: ActionsPanelProps) {
  const t = useTranslations("settings.control");
  const [runState, setRunState] = useState<ControlActionState>(IDLE_CONTROL_STATE);
  const [rescoreState, setRescoreState] = useState<ControlActionState>(IDLE_CONTROL_STATE);
  const [runPending, startRun] = useTransition();
  const [rescorePending, startRescore] = useTransition();
  const [backlogState, setBacklogState] = useState<ControlActionState>(IDLE_CONTROL_STATE);
  const [backlogPending, startBacklog] = useTransition();
  const [only, setOnly] = useState<string[]>([]);

  const requestRun = () =>
    startRun(async () => {
      setRunState(await runCycleAction(only.length > 0 ? { channelIds: only } : {}));
      onRequested();
    });
  const requestRescore = () =>
    startRescore(async () => {
      setRescoreState(await rescoreStaleAction());
      onRequested();
    });

  const requestBacklog = () =>
    startBacklog(async () => {
      setBacklogState(await scoreJobsAction({ backlog: true }));
      onRequested();
    });

  const stale = status?.staleScores ?? 0;
  const unscored = status?.unscoredJobs ?? 0;
  const requestOpen = (kind: ControlRequestView["kind"]) => status?.requests.some((r) => r.kind === kind && (r.status === "pending" || r.status === "running")) ?? false;
  const runOpen = requestOpen("run_cycle");
  const rescoreOpen = requestOpen("rescore_stale");
  // a request for one job (the button on its page) does not block the backlog button, and the other way round
  const backlogOpen = status?.requests.some((r) => r.kind === "score_jobs" && r.jobIds === null && (r.status === "pending" || r.status === "running")) ?? false;
  const dbDown = status === null;

  function feedback(state: ControlActionState) {
    if (state.status === "error") {
      return (
        <p role="alert" className="text-destructive text-xs">
          {t(`errors.${state.error}`)}
        </p>
      );
    }
    if (state.status === "queued") {
      return (
        <p role="status" className="text-muted-foreground text-xs">
          {state.existing ? t("existing") : t("queued")}
        </p>
      );
    }
    return null;
  }

  return (
    <Card className="gap-4 py-4" data-testid="control-card">
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2 className="text-base font-semibold">{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-4 md:px-5">
        <RunnerLine status={status} />
        {status?.aiRun ? <AiRunStatus {...status.aiRun} /> : null}

        <div className="grid gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-2" id="run-cycle">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={dbDown || runPending || runOpen}
                onClick={requestRun}
              >
                {runPending || runOpen ? <Loader2 aria-hidden className="animate-spin" /> : <Play aria-hidden />}
                {runPending ? t("run.requesting") : t("run.button")}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{t("run.hint")}</p>
            {channelChoices.length > 0 ? (
              <details className="text-sm">
                <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">{t("run.only")}</summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p className="text-muted-foreground text-xs">{t("run.onlyHint")}</p>
                  <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {channelChoices.map((id) => (
                      <li key={id}>
                        <label className="flex items-center gap-2 font-mono text-xs">
                          <input
                            type="checkbox"
                            className="accent-primary size-4"
                            checked={only.includes(id)}
                            onChange={(event) => setOnly(event.target.checked ? [...only, id] : only.filter((x) => x !== id))}
                          />
                          {id}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            ) : null}
            {feedback(runState)}
          </div>

          <div className="flex scroll-mt-20 flex-col gap-2" id="rescore">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" disabled={dbDown || stale === 0 || rescorePending || rescoreOpen} onClick={requestRescore}>
                {rescorePending || rescoreOpen ? <Loader2 aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
                {stale === 0 ? t("rescore.none") : t("rescore.button", { count: stale })}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{t("rescore.hint")}</p>
            {feedback(rescoreState)}

            <div className="mt-3 flex scroll-mt-20 flex-col gap-2" id="score-backlog">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" disabled={dbDown || unscored === 0 || backlogPending || backlogOpen} onClick={requestBacklog} data-testid="score-backlog-button">
                  {backlogPending || backlogOpen ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
                  {unscored === 0 ? t("backlog.none") : t("backlog.button", { count: unscored })}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{t("backlog.hint")}</p>
              {feedback(backlogState)}
            </div>
          </div>
        </div>

        <div className="flex scroll-mt-20 flex-col gap-2" id="telegram-test">
          <TriggerButton kind="testTelegram" confirm disabled={dbDown} />
          <p className="text-muted-foreground text-xs">{t("telegramTest.hint")}</p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("requests.title")}</h3>
          {status && status.requests.length > 0 ? (
            <ul className="flex flex-col gap-2" data-testid="control-requests">
              {status.requests.map((request) => (
                <RequestRow key={request.id} request={request} timezone={timezone} aiRunning={status?.aiRun != null && status.aiRun.cycleId !== null && status.aiRun.cycleId === request.cycle?.id} />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">{t("requests.empty")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
