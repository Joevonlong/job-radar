import { useFormatter, useTranslations } from "next-intl";

import { useClosedHint } from "@/components/jobs/status-chip";

import { ClosureAnswers } from "./close-job-button";
import type { JobClosure } from "@/lib/db/queries/job-detail";

interface ClosureNoticeProps {
  jobId: number;
  title: string;
  closure: JobClosure;
  lastSeenAt: Date;
  timezone: string;
}

/**
 * The lines under the detail page's header about a closed job: why it shows as closed (with the evidence of the last recheck
 * and a link to the checked page), the user's own note, and "a source still listed this job" when a source returned it after the
 * user closed it (the user's judgement stays; the hint lets them reopen it). The answers to the evidence sit here too: "Still open" for
 * a possibly closed job, "Edit note" for one the user closed.
 */
export function ClosureNotice({ jobId, title, closure, lastSeenAt, timezone }: ClosureNoticeProps) {
  const t = useTranslations("dashboard.closed");
  const format = useFormatter();
  const evidence = closure.linkCheck;
  const hint = useClosedHint(closure.reason, evidence);
  const override = closure.override;
  const manual = override?.action === "closed";
  const stillListed = manual && lastSeenAt.getTime() > override.createdAt.getTime();
  const lines = closure.reason !== null || manual || evidence !== null;
  if (!lines) return null;
  const checkedUrl = evidence?.url && /^https?:\/\//iu.test(evidence.url) ? evidence.url : null;
  return (
    <div className="text-ink-2 text-body-sm flex flex-col gap-0.5" data-testid="closure-notice" data-reason={closure.reason ?? undefined}>
      {hint && closure.reason !== "manual" ? <p data-testid="closure-hint">{hint}</p> : null}
      {manual && override.note ? <p data-testid="closure-note">{t("noteShown", { note: override.note })}</p> : null}
      {stillListed ? (
        <p data-testid="closure-still-listed">{t("stillListed", { date: format.dateTime(lastSeenAt, { dateStyle: "medium", timeZone: timezone }) })}</p>
      ) : null}
      {evidence ? (
        <p className="font-mono text-data" data-testid="closure-checked">
          {t("checkedOn", { when: format.dateTime(new Date(evidence.at), { dateStyle: "medium", timeStyle: "short", timeZone: timezone }) })}
          {checkedUrl ? (
            <>
              {" · "}
              <a href={checkedUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
                {t("evidenceLink")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {closure.reason === "manual" || closure.reason === "phrase" || closure.reason === "possibly" ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <ClosureAnswers jobId={jobId} title={title} reason={closure.reason} note={manual ? override.note : null} />
        </div>
      ) : null}
    </div>
  );
}
