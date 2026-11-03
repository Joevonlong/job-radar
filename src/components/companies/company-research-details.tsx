"use client";

import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";

import { requestCompanyResearchAction as rawRequest, type CompanyResearchActionErrorKey } from "@/app/jobs/[id]/research-actions";
import { readCompanyResearchRequestState } from "@/components/jobs/detail/company-background-panel";
import { CompanyDomainRow } from "@/components/jobs/detail/company-domain-row";
import { CompanyResearchFields } from "@/components/jobs/detail/company-research-fields";
import { useControlRequest } from "@/components/control/use-control-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { withActionFeedback } from "@/lib/actions/client";
import type { AiProviderId } from "@/lib/ai/types";
import { formatClock } from "@/lib/format/clock";
import type { CompanyResearchItem } from "@/lib/research/company-overview";
import { toastTone } from "@/lib/toast";

const requestAction = withActionFeedback(rawRequest)(() => ({ ok: false, error: "failed" }));

/** A company without a stored result: its website behind one small button in the row's actions, so the list gets no extra row. */
export function CompanyWebsiteAction({ company, companyId, website }: { company: string; companyId: number; website: CompanyResearchItem["website"] }) {
  const t = useTranslations("research.overview");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={t("websiteLabel", { company })} data-testid="company-website-action">
          {t("website")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))]">
        <CompanyDomainRow companyId={companyId} website={website} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A company's background in the company list: one line with its summary and size, and on request the fields with their sources and
 * its website. Read only, except for one button that asks for a new lookup under the manual limit.
 */
export function CompanyResearchDetails({ company, companyId, info, canRefresh, canEditDomain, providers, timeZone }: { company: string; companyId: number; info: CompanyResearchItem; canRefresh: boolean; canEditDomain: boolean; providers: readonly AiProviderId[]; timeZone: string }) {
  const t = useTranslations("research.overview");
  const tError = useTranslations("research.error");
  const format = useFormatter();
  const router = useRouter();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const { latest, website, jobId } = info;

  const fail = (key: CompanyResearchActionErrorKey, resumeAt: string | null = null): void => {
    toastTone("error", key === "auth" ? tError("auth", { providers: providers.join(", ") }) : key === "quota_guard" ? tError("quota_guard", { time: resumeAt ? formatClock(format, resumeAt, timeZone) : "none" }) : tError(key));
  };

  useControlRequest({
    requestId: waiting,
    read: (id) => readCompanyResearchRequestState(jobId as number, id),
    onDone: () => {
      setWaiting(null);
      toastTone("success", t("done"));
      router.refresh();
    },
    onFailed: (failed) => {
      setWaiting(null);
      fail(failed?.error ?? "not_found", failed?.resumeAt ?? null);
    },
  });

  const refresh = (): void => {
    if (jobId === null) return;
    startTransition(async () => {
      const result = await requestAction({ jobId, force: true });
      if (!result.ok) fail(result.error);
      else if (result.queued) {
        setWaiting(result.requestId);
        toastTone("info", t("queued"));
      } else router.refresh();
    });
  };

  // the extra row is for a stored result; a company without one has `CompanyWebsiteAction` in its actions
  if (latest === null) return null;
  const summary = latest.fields.summary?.text ?? null;
  const size = latest.fields.size?.text ?? null;
  const busy = pending || waiting !== null;

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="company-research-details">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {summary ? (
          <p className="text-ink-2 text-body-sm min-w-0 flex-1 truncate sm:max-w-[72ch]" title={summary} data-testid="company-research-summary">
            {summary}
          </p>
        ) : null}
        {size ? (
          <span className="text-ink-3 text-data font-mono [overflow-wrap:anywhere]" data-testid="company-research-size">
            {size}
          </span>
        ) : null}
        <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={panelId} aria-label={t("toggleLabel", { company })} onClick={() => setOpen((value) => !value)} data-testid="company-research-toggle">
          <ChevronDown className={open ? "rotate-180 motion-reduce:transition-none" : "motion-reduce:transition-none"} aria-hidden />
          {open ? t("hide") : t("details")}
        </Button>
      </div>
      <div id={panelId} hidden={!open} className="border-border flex min-w-0 flex-col gap-3 border-l-2 pl-3 [overflow-wrap:anywhere]">
        {open ? (
          <>
            <>
                <Badge variant="gate-note" className="w-fit max-w-full whitespace-normal">
                  {t("unverified")}
                </Badge>
                {latest.expired ? <p className="text-ink-2 text-body-sm">{t("expired")}</p> : null}
                <CompanyResearchFields fields={latest.fields} />
                <p className="text-data text-ink-3 font-mono [overflow-wrap:anywhere]" data-testid="company-research-meta">
                  {[latest.provider, latest.model, format.dateTime(new Date(latest.fetchedAt), { dateStyle: "medium", timeStyle: "short", timeZone })].filter((part): part is string => part !== null && part !== "").join(" · ")}
                </p>
            </>
            {canEditDomain ? <CompanyDomainRow companyId={companyId} website={website} /> : null}
            {canRefresh && jobId !== null ? (
              <Button type="button" variant="outline" size="sm" className="w-fit" disabled={busy} aria-busy={busy} onClick={refresh} data-testid="company-overview-refresh">
                {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}
                {t("refresh")}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
