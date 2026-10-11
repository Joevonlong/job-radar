"use client";

import { FlaskConical, Loader2, Play, Send } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition } from "react";

import { runChannelNowAction, testAiAction, testChannelAction, testTelegramAction } from "@/app/control-actions";
import { Button } from "@/components/ui/button";
import { controlRequestViewSchema, isOpenRequest, type ControlRequestView } from "@/lib/control/request-view-schema";
import { IDLE_CONTROL_STATE, type ControlActionState } from "@/lib/control/service-types";
import { formatClock } from "@/lib/format/clock";
import { STATUS_POLL_MS, TRIGGER_WAIT_MAX_MS } from "@/lib/settings/constants";
import { cn } from "@/lib/utils";

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

function call(kind: TriggerKind, target: string): Promise<ControlActionState> {
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

/** Poll one request until it is finished (or the page gave up waiting). */
function useRequestView(requestId: number | null): { view: ControlRequestView | null; gaveUp: boolean } {
  // keyed by the request: a new request starts from "nothing known yet" without resetting state in the effect
  const [polled, setPolled] = useState<{ id: number; view: ControlRequestView | null; gaveUp: boolean } | null>(null);

  const load = useCallback(async (id: number): Promise<ControlRequestView | null> => {
    try {
      const response = await fetch(`/api/control/requests/${id}`, { cache: "no-store" });
      if (!response.ok) return null;
      const parsed = controlRequestViewSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // the next poll retries
    }
  }, []);

  useEffect(() => {
    if (requestId === null) return;
    let stopped = false;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      const next = await load(requestId);
      if (stopped) return;
      if (next) setPolled({ id: requestId, view: next, gaveUp: false });
      if (next && !isOpenRequest(next)) return;
      if (Date.now() - started > TRIGGER_WAIT_MAX_MS) {
        setPolled((current) => ({ id: requestId, view: current?.id === requestId ? current.view : null, gaveUp: true }));
        return;
      }
      timer = setTimeout(() => void tick(), STATUS_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [requestId, load]);

  const current = polled !== null && polled.id === requestId ? polled : null;
  return { view: current?.view ?? null, gaveUp: current?.gaveUp ?? false };
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
  const [state, setState] = useState<ControlActionState>(IDLE_CONTROL_STATE);
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const requestId = state.status === "queued" ? state.request : null;
  const { view, gaveUp } = useRequestView(requestId);
  const open = requestId !== null && !gaveUp && (view === null || isOpenRequest(view));
  const Icon = ICON[kind];

  const send = () => {
    setConfirming(false);
    startTransition(async () => setState(await call(kind, target)));
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)} data-testid={`trigger-${kind}`} data-target={target || undefined} data-state={pending || open ? "busy" : (view?.status ?? "idle")}>
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
      <Outcome kind={kind} state={state} view={view} gaveUp={gaveUp} timeZone={timeZone} />
    </div>
  );
}

function Outcome({ kind, state, view, gaveUp, timeZone }: { kind: TriggerKind; state: ControlActionState; view: ControlRequestView | null; gaveUp: boolean; timeZone?: string | undefined }) {
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
  const worker = kind === "testAi" ? "aiWorker" : "runner";
  if (gaveUp && (view === null || isOpenRequest(view))) {
    return (
      <p role="status" className="text-warning-text text-xs" data-testid="trigger-outcome" data-outcome="waiting">
        {t(`stillWaiting.${worker}`)}
      </p>
    );
  }
  if (view === null || view.status === "pending") {
    return (
      <p role="status" className="text-muted-foreground text-xs" data-testid="trigger-outcome" data-outcome="pending">
        {state.existing ? t("existing") : t(`pending.${worker}`)}
      </p>
    );
  }
  if (view.status === "running") {
    const cycle = view.cycle;
    return (
      <p role="status" className="text-muted-foreground text-xs" data-testid="trigger-outcome" data-outcome="running">
        {cycle ? t("runningCycle", { id: cycle.id, finished: cycle.runsFinished, total: cycle.runsTotal, fetched: cycle.fetched }) : t("running")}
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
