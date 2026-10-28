"use client";

import { FlaskConical, Loader2, Play, Send } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { runChannelNowAction as rawRunChannelNowAction, testAiAction as rawTestAiAction, testChannelAction as rawTestChannelAction, testTelegramAction as rawTestTelegramAction } from "@/app/control-actions";
import { Button } from "@/components/ui/button";
import { followsCoveringCycle, isOpenRequest, type ControlQueueView, type ControlRequestView } from "@/lib/control/request-view-schema";
import { IDLE_CONTROL_STATE, type ControlActionState } from "@/lib/control/service-types";
import { formatClock } from "@/lib/format/clock";
import { cn } from "@/lib/utils";
import { withActionFeedback } from "@/lib/actions/client";

import { QueueHint } from "./queue-hint";
import { readRequestView } from "./read-request-view";
import { useControlRequest, type ControlRequestStage } from "./use-control-request";

type TriggerActionState = ControlActionState | { status: "error"; error: "transportFailed"; nonce: number };

function withTriggerFeedback<Args extends unknown[]>(action: (...args: Args) => Promise<ControlActionState>): (...args: Args) => Promise<TriggerActionState> {
  return withActionFeedback<Args, TriggerActionState>(action)(() => ({ status: "error", error: "transportFailed", nonce: Date.now() }));
}

const runChannelNowAction = withTriggerFeedback(rawRunChannelNowAction);
const testAiAction = withTriggerFeedback(rawTestAiAction);
const testChannelAction = withTriggerFeedback(rawTestChannelAction);
const testTelegramAction = withTriggerFeedback(rawTestTelegramAction);


/** What a trigger button asks for. */
export type TriggerKind = "runChannel" | "testChannel" | "testAi" | "testTelegram";

const ICON = { runChannel: Play, testChannel: FlaskConical, testAi: FlaskConical, testTelegram: Send } as const;

/** Error codes of a finished request that have their own message; anything else reads "failed". */
const RESULT_ERRORS = [
  "another_cycle_running",
  "cycle_failed",
  "unknown_channel",
  "channel_excluded",
  "channel_disabled",
  "not_configured",
  "budget_exceeded",
  "channel_test_failed",
  "ai_unavailable",
  "ai_test_failed",
  "quota_guard",
  "telegram_not_configured",
  "telegram_failed",
  "no_handler",
  "handler_error",
  "invalid_payload",
] as const;

function call(kind: TriggerKind, target: string): Promise<TriggerActionState> {
  switch (kind) {
    case "runChannel":
      return runChannelNowAction(target);
    case "testChannel":
      return testChannelAction({ channelId: target });
    case "testAi":
      return testAiAction({ provider: target });
    case "testTelegram":
      return testTelegramAction();
  }
}

/** The outcome of one finished request: its view, or null when the request is gone. */
interface Finished {
  id: number;
  view: ControlRequestView | null;
}

interface TriggerButtonProps {
  kind: TriggerKind;
  /** Channel id (`runChannel`, `testChannel`) or provider id (`testAi`); unused for `testTelegram`. */
  target?: string;
  disabled?: boolean;
  /** Shown under a disabled button. */
  disabledHint?: string;
  /** Ask once more before sending (`testTelegram`). */
  confirm?: boolean;
  variant?: "default" | "outline";
  className?: string;
  /** schedule.yaml `timezone`: the zone of a resume time in the outcome (default: the browser's). */
  timeZone?: string;
}

/**
 * A manual trigger: leaves a control request, polls `/api/control/requests/<id>` and shows the outcome right
 * under the button. The button stays off while its request is open; the server reuses an open request and refuses a
 * repeat within `schedule.yaml: manual_triggers.min_interval_seconds`.
 */
export function TriggerButton({ kind, target = "", disabled = false, disabledHint, confirm = false, variant = "outline", className, timeZone }: TriggerButtonProps) {
  const t = useTranslations("trigger");
  const [state, setState] = useState<TriggerActionState>(IDLE_CONTROL_STATE);
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const queuedId = state.status === "queued" ? state.request : null;
  // keyed by the request, like the hook: a new request starts from "not finished" without a reset in an effect
  const [finished, setFinished] = useState<Finished | null>(null);
  const ended = finished !== null && finished.id === queuedId ? finished : null;
  const wait = useControlRequest({
    requestId: ended ? null : queuedId,
    read: readRequestView,
    onDone: (view) => setFinished({ id: view.id, view }),
    onFailed: (view) => {
      if (queuedId !== null) setFinished({ id: queuedId, view });
    },
  });
  const view = ended ? ended.view : wait.waiting;
  // A covered request is already done, so the button is free while the hook follows the covering cycle.
  const open = queuedId !== null && ended === null && (view === null || isOpenRequest(view));
  const Icon = ICON[kind];

  const send = () => {
    setConfirming(false);
    startTransition(async () => setState(await call(kind, target)));
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)} data-testid={`trigger-${kind}`} data-target={target || undefined} data-state={pending || open ? "busy" : (view?.status ?? (ended ? "failed" : "idle"))}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant={variant} disabled={disabled || pending || open || confirming} onClick={confirm ? () => setConfirming(true) : send} data-testid={`trigger-${kind}-button`}>
          {pending || open ? <Loader2 aria-hidden className="animate-spin" /> : <Icon aria-hidden />}
          {t(`button.${kind}`)}
        </Button>
        {confirming ? (
          <span role="group" aria-label={t(`confirm.${kind === "testTelegram" ? "testTelegram" : "generic"}`)} className="flex flex-wrap items-center gap-2 text-xs">
            <span>{t(`confirm.${kind === "testTelegram" ? "testTelegram" : "generic"}`)}</span>
            <Button type="button" size="xs" onClick={send} data-testid={`trigger-${kind}-confirm`}>
              {t("confirm.yes")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              {t("confirm.no")}
            </Button>
          </span>
        ) : null}
      </div>
      {disabled && disabledHint ? <p className="text-muted-foreground text-xs">{disabledHint}</p> : null}
      <Outcome kind={kind} state={state} open={open} view={view} finished={ended !== null} stage={wait.stage} queue={wait.queue} timeZone={timeZone} />
    </div>
  );
}

interface OutcomeProps {
  kind: TriggerKind;
  state: TriggerActionState;
  /** The request is queued or running (not finished, not gone). */
  open: boolean;
  /** The newest view: while open the last one polled, after the end the final one (null: not read yet, or gone). */
  view: ControlRequestView | null;
  finished: boolean;
  stage: ControlRequestStage | null;
  queue: ControlQueueView | null;
  timeZone?: string | undefined;
}

function Outcome({ kind, state, open, view, finished, stage, queue, timeZone }: OutcomeProps) {
  const t = useTranslations("trigger");
  const tCycle = useTranslations("dashboard.cycle");
  const format = useFormatter();
  if (state.status === "error") {
    return (
      <p role="alert" className="text-destructive text-xs" data-testid="trigger-outcome" data-outcome="refused">
        {state.error === "tooSoon" ? t("refused.tooSoon", { seconds: state.retryAfterSeconds ?? 1 }) : t(`refused.${state.error}`)}
      </p>
    );
  }
  if (state.status !== "queued") return null;
  if (kind === "runChannel" && view?.cycle && followsCoveringCycle(view)) {
    return (
      <p role="status" className="text-muted-foreground text-xs" data-testid="trigger-outcome" data-outcome="covered">
        {t("done.runChannelCovered", { id: view.cycle.id, finished: view.cycle.runsFinished, total: view.cycle.runsTotal, fetched: view.cycle.fetched })}
      </p>
    );
  }
  if (open) {
    // the process comes from the queue view (`kinds.ts` with ai.yaml `execution`), never from the button's kind
    const worker = queue?.worker.process === "runner" ? "runner" : "aiWorker";
    const hint = <QueueHint queue={queue} stage={stage} timeZone={timeZone} className="text-muted-foreground text-xs" />;
    if (stage === "running") {
      const cycle = view?.cycle ?? null;
      return (
        <div className="flex flex-col gap-0.5">
          <p role="status" className="text-muted-foreground text-xs" data-testid="trigger-outcome" data-outcome="running">
            {cycle ? t("runningCycle", { id: cycle.id, finished: cycle.runsFinished, total: cycle.runsTotal, fetched: cycle.fetched }) : t("running")}
          </p>
          {hint}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-0.5">
        <p role="status" className="text-muted-foreground text-xs" data-testid="trigger-outcome" data-outcome="pending" data-process={queue?.worker.process ?? undefined}>
          {state.existing ? t("existing") : queue ? t(`pending.${worker}`) : t("queued")}
        </p>
        {hint}
      </div>
    );
  }
  if (!finished || view === null) {
    return (
      <p role="alert" className="text-destructive text-xs" data-testid="trigger-outcome" data-outcome="failed" data-error="">
        {t("failed.unknown")}
      </p>
    );
  }
  const { result } = view;
  if (view.status === "failed") {
    const code = RESULT_ERRORS.find((x) => x === result.error);
    const detail = result.errorCode ?? result.errorKind;
    return (
      <p role="alert" className="text-destructive text-xs" data-testid="trigger-outcome" data-outcome="failed" data-error={result.error ?? ""}>
        {code ? t(`failed.${code}`, { time: result.resumeAt ? formatClock(format, result.resumeAt, timeZone) : "none" }) : t("failed.unknown")}
        {detail ? <span className="ml-1 font-mono">({detail})</span> : null}
      </p>
    );
  }
  const seconds = (ms: number | undefined): string => ((ms ?? 0) / 1000).toFixed(1);
  switch (kind) {
    case "testChannel":
      return (
        <div role="status" className="text-success-text text-xs" data-testid="trigger-outcome" data-outcome="done">
          <p>{t("done.testChannel", { fetched: result.fetched ?? 0, parsed: result.parsed ?? 0, seconds: seconds(result.durationMs) })}</p>
          {result.sampleTitles && result.sampleTitles.length > 0 ? (
            <ul className="text-muted-foreground mt-0.5 list-disc pl-4">
              {result.sampleTitles.map((title, index) => (
                <li key={index} className="break-words">
                  {title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "testAi":
      return (
        <p role="status" className="text-success-text text-xs" data-testid="trigger-outcome" data-outcome="done">
          {t("done.testAi", { model: result.model ?? "?", seconds: seconds(result.latencyMs), tokensIn: result.tokensIn ?? 0, tokensOut: result.tokensOut ?? 0 })}
        </p>
      );
    case "testTelegram":
      return (
        <p role="status" className="text-success-text text-xs" data-testid="trigger-outcome" data-outcome="done">
          {t("done.testTelegram", { id: result.messageId ?? 0 })}
        </p>
      );
    case "runChannel":
      return (
        <p role="status" className="text-success-text text-xs" data-testid="trigger-outcome" data-outcome="done">
          {view.cycle
            ? t("done.runChannel", { id: view.cycle.id, state: tCycle(`state.${view.cycle.status}`), fetched: view.cycle.fetched, fresh: view.cycle.newCount })
            : t("done.runChannelNoCycle")}
        </p>
      );
  }
}
