"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { scoreJobNowAction as rawScoreJobNowAction } from "@/app/jobs/[id]/actions";
import { QueueHint } from "@/components/control/queue-hint";
import { readRequestView } from "@/components/control/read-request-view";
import { useControlRequest } from "@/components/control/use-control-request";
import { Button } from "@/components/ui/button";
import type { ControlRequestView } from "@/lib/control/request-view-schema";
import { IDLE_CONTROL_STATE, type ControlActionState } from "@/lib/control/service-types";
import { formatClock } from "@/lib/format/clock";
import type { ProfileScoringField } from "@/lib/scoring/profile";
import { INK_LINK } from "@/components/ui/ink-link";
import { withActionFeedback } from "@/lib/actions/client";

const scoreJobNowAction = withActionFeedback(rawScoreJobNowAction)(() => ({ status: "error", error: "databaseUnavailable", nonce: Date.now() }));

const ERROR_CODES = ["invalid_payload", "score_failed", "score_stopped", "score_profile_incomplete", "score_ai_unavailable", "quota_guard", "handler_error", "no_handler"] as const;

/** How a request of this button ended: its final view, or null when it is gone. */
interface Finished {
  id: number;
  view: ControlRequestView | null;
}

/**
 * "Score now" for a job that waits for its AI score: leaves a `score_jobs` request for this job, follows that request at
 * `/api/control/requests/<id>` (its place in the queue, and whether the process that scores, the ai-worker or with
 * `execution: container` the runner, is alive) and refreshes the page when the score is there.
 * With an incomplete profile scoring cannot start: the button is off and says why, with a link to /me.
 */
export function ScoreNowButton({ jobId, profileMissing = [], timeZone }: { jobId: number; profileMissing?: readonly ProfileScoringField[]; timeZone?: string }) {
  const t = useTranslations("dashboard.detail.scoreNow");
  const tProfile = useTranslations("profile.incomplete");
  const tRequests = useTranslations("settings.control.requests");
  const format = useFormatter();
  const router = useRouter();
  const [state, setState] = useState<ControlActionState>(IDLE_CONTROL_STATE);
  const [pending, startTransition] = useTransition();
  const [finished, setFinished] = useState<Finished | null>(null);

  const queuedId = state.status === "queued" ? state.request : null;
  const ended = finished !== null && finished.id === queuedId ? finished : null;
  const wait = useControlRequest({
    requestId: ended ? null : queuedId,
    read: readRequestView,
    onDone: (view) => {
      setFinished({ id: view.id, view });
      router.refresh();
    },
    onFailed: (view) => {
      if (queuedId !== null) setFinished({ id: queuedId, view });
    },
  });
  const open = queuedId !== null && ended === null;
  const failed = ended !== null && ended.view?.status !== "done";
  const result = ended?.view?.result;

  const click = () =>
    startTransition(async () => {
      setState(await scoreJobNowAction({ jobId }));
    });

  const errorCode = failed ? ERROR_CODES.find((code) => code === result?.error) : undefined;
  const blocked = profileMissing.length > 0;
  const profileLink = (
    <Link href="/me" className={INK_LINK} data-testid="score-now-profile-link">
      {tProfile("link")}
    </Link>
  );

  return (
    <div className="flex flex-col gap-1.5" data-testid="score-now">
      <Button type="button" size="sm" variant="outline" className="self-start" disabled={pending || open || blocked} onClick={click} data-testid="score-now-button">
        {pending || open ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
        {pending ? t("requesting") : open ? t("scoring") : t("button")}
      </Button>
      {blocked ? (
        <p role="status" className="text-warning-text text-xs" data-testid="score-now-profile-incomplete">
          <span className="block font-medium">{tProfile("title")}</span>
          {tProfile("hint", { fields: profileMissing.map((field) => tProfile(`fields.${field}`)).join(tProfile("separator")) })} {profileLink}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="text-destructive text-xs">
          {t(`errors.${state.error}`)}
        </p>
      ) : null}
      {open ? <QueueHint queue={wait.queue} stage={wait.stage} timeZone={timeZone} className="text-muted-foreground text-xs" /> : null}
      {result?.stopped === "time_budget" ? (
        <p role="status" className="text-muted-foreground text-xs" data-testid="score-now-time-budget">
          {tRequests("timeBudget", { remaining: result.remaining ?? 0 })}
        </p>
      ) : failed ? (
        <p role="alert" className="text-destructive text-xs" data-testid="score-now-failed">
          {errorCode ? t(`failure.${errorCode}`, { time: result?.resumeAt ? formatClock(format, result.resumeAt, timeZone) : "none" }) : t("failure.unknown")}
          {errorCode === "score_profile_incomplete" ? <> {profileLink}</> : null}
        </p>
      ) : null}
    </div>
  );
}
