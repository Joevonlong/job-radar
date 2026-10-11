import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import type { ClosedReason } from "@/lib/jobs/closure";

import { StatusPill } from "./status-pill";

/** The application status as a v3 pill (the detail page and the pipeline cards use this name; the look is `StatusPill`). */
export function StatusChip({ status, className }: { status: ApplicationStatus; className?: string }) {
  return <StatusPill status={status} {...(className ? { className } : {})} />;
}

/** What a recheck of the posting found, shown as the evidence of a closed tag. */
export interface ClosedEvidence {
  httpStatus: number | null;
  quote: string | null;
  url: string | null;
  /** ISO time of the check. */
  at: string;
}

/** The sentence behind a closed tag (its tooltip, and the line under the detail page's header). */
export function useClosedHint(reason: ClosedReason | null | undefined, evidence: ClosedEvidence | null | undefined): string | null {
  const t = useTranslations("dashboard.closed");
  const format = useFormatter();
  if (!reason) return null;
  const when = evidence ? format.dateTime(new Date(evidence.at), { dateStyle: "medium" }) : "";
  if (reason === "gone" && evidence?.httpStatus) return t("reasonHint.gone", { status: evidence.httpStatus, when });
  if (reason === "phrase" && evidence?.quote) return t("reasonHint.phrase", { quote: evidence.quote, when });
  if (reason === "gone" || reason === "phrase") return t(`reason.${reason}`);
  return t(`reasonHint.${reason}`);
}

/**
 * Job that may have disappeared from its sources: yellow "watch" gate (possibly closed) or red (closed). With a `reason` the tag
 * says why (closed by you / taken down at the source / the source says no longer accepting / possibly closed) and its tooltip carries
 * the evidence of the last recheck.
 */
export function JobStatusChip({ status, reason, evidence }: { status: "possibly_closed" | "closed"; reason?: ClosedReason | null; evidence?: ClosedEvidence | null }) {
  const t = useTranslations("dashboard.jobStatus");
  const tc = useTranslations("dashboard.closed");
  const hint = useClosedHint(reason, evidence);
  const label = reason ? tc(`reason.${reason}`) : t(status);
  return (
    <Badge variant={status === "closed" ? "gate-bad" : "gate-warn"} data-slot="job-status-chip" data-job-status={status} data-reason={reason ?? undefined} {...(hint ? { title: hint } : {})}>
      {label}
      {hint && hint !== label ? <span className="sr-only">{tc("srHint", { hint })}</span> : null}
    </Badge>
  );
}
