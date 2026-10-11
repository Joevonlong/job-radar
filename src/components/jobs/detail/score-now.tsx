"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { scoreJobNowAction } from "@/app/jobs/[id]/actions";
import { useControlStatus } from "@/components/settings/use-control-status";
import { Button } from "@/components/ui/button";
import { IDLE_CONTROL_STATE, type ControlActionState } from "@/lib/control/service-types";
import type { ProfileScoringField } from "@/lib/scoring/profile";
import { INK_LINK } from "@/components/ui/ink-link";

const ERROR_CODES = ["invalid_payload", "score_failed", "score_stopped", "score_profile_incomplete", "score_ai_unavailable", "handler_error", "no_handler"] as const;

/**
 * "Score now" for a job that waits for its AI score: asks the runner for a `score_jobs` request for this
 * job, polls the request like the settings controls do and refreshes the page when the score is there.
 * With an incomplete profile scoring cannot start: the button is off and says why, with a link to /me.
 */
export function ScoreNowButton({ jobId, profileMissing = [] }: { jobId: number; profileMissing?: readonly ProfileScoringField[] }) {
  const t = useTranslations("dashboard.detail.scoreNow");
  const tProfile = useTranslations("profile.incomplete");
  const router = useRouter();
  const { status, refresh } = useControlStatus(null);
  const [state, setState] = useState<ControlActionState>(IDLE_CONTROL_STATE);
  const [pending, startTransition] = useTransition();
  const refreshed = useRef<number | null>(null);

  const requestId = state.status === "queued" ? state.request : null;
  const request = requestId === null ? null : (status?.requests.find((r) => r.id === requestId) ?? null);
  const open = requestId !== null && (request === null || request.status === "pending" || request.status === "running");
  const failed = request?.status === "failed";

  useEffect(() => {
    if (request?.status === "done" && refreshed.current !== request.id) {
      refreshed.current = request.id;
      router.refresh();
    }
  }, [request, router]);

  const click = () =>
    startTransition(async () => {
      setState(await scoreJobNowAction({ jobId }));
      refresh();
    });

  const errorCode = failed ? ERROR_CODES.find((code) => code === request?.error) : undefined;
  const runnerDown = open && status !== null && !status.heartbeat.online;
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
      {runnerDown ? (
        <p role="status" className="text-warning-text text-xs">
          {t("runnerDown")}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-destructive text-xs">
          {errorCode ? t(`failure.${errorCode}`) : t("failure.unknown")}
          {errorCode === "score_profile_incomplete" ? <> {profileLink}</> : null}
        </p>
      ) : null}
    </div>
  );
}
