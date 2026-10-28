"use client";

import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toastTone } from "@/lib/toast";

import { approveSuggestionAction as rawApproveSuggestionAction, rejectSuggestionAction as rawRejectSuggestionAction, requestSuggestRunAction as rawRequestSuggestRunAction } from "@/app/interests/suggestion-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pickSummary, summaryOrder } from "@/lib/dashboard/summary";
import { bcp47 } from "@/lib/i18n/languages";
import { suggestedValue, type FilterAction, type SuggestionPayload } from "@/lib/interests/suggestion";
import type { SuggestionActionState, SuggestionError, SuggestRunState } from "@/lib/interests/suggestion-types";
import type { SuggestionItemView, SuggestionsSectionData, SuggestRunView } from "@/lib/interests/suggestion-view";
import { cn } from "@/lib/utils";
import { INK_LINK } from "@/components/ui/ink-link";
import { withActionFeedback } from "@/lib/actions/client";

const approveSuggestionAction = withActionFeedback(rawApproveSuggestionAction)((id) => ({ status: "error", id: typeof id === "number" ? id : 0, nonce: Date.now(), error: "databaseUnavailable" }));
const rejectSuggestionAction = withActionFeedback(rawRejectSuggestionAction)((id) => ({ status: "error", id: typeof id === "number" ? id : 0, nonce: Date.now(), error: "databaseUnavailable" }));
const requestSuggestRunAction = withActionFeedback(rawRequestSuggestRunAction)(() => ({ status: "error", error: "databaseUnavailable", nonce: Date.now() }));

type KindLabelKey = "kind.signal_word" | "kind.watched_company" | `kind.filter.${FilterAction}`;

function kindLabelKey(payload: SuggestionPayload): KindLabelKey {
  if (payload.kind === "signal_word") return "kind.signal_word";
  if (payload.kind === "watched_company") return "kind.watched_company";
  return `kind.filter.${payload.action}`;
}

/** Parameters of the kind label: a signal word names its category. */
function kindLabelValues(item: SuggestionItemView): { name: string } {
  return { name: item.categoryName ?? (item.payload?.kind === "signal_word" ? item.payload.tier : "") };
}

function Evidence({ payload }: { payload: SuggestionPayload }) {
  const t = useTranslations("interestSuggestions");
  return (
    <details className="text-sm" data-testid="suggestion-evidence">
      <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">{t("evidence", { count: payload.evidence.length })}</summary>
      <ul className="mt-2 flex flex-col gap-2">
        {payload.evidence.map((item) => (
          <li key={item.jobId} className="border-border flex flex-col gap-1 border-l-2 pl-3">
            <Link href={`/jobs/${item.jobId}`} className={cn(INK_LINK, "w-fit text-xs")}>
              {item.title} · {item.company}
            </Link>
            {item.quote ? <blockquote className="text-muted-foreground text-xs break-words italic">“{item.quote}”</blockquote> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function SuggestionCard({ item, busy, onApprove, onReject }: { item: SuggestionItemView; busy: boolean; onApprove: () => void; onReject: () => void }) {
  const t = useTranslations("interestSuggestions");
  const locale = useLocale();
  const { payload } = item;
  return (
    <li className="border-border flex flex-col gap-2 rounded-lg border px-4 py-3" data-testid="suggestion-item" data-id={item.id} data-kind={payload?.kind ?? "unreadable"}>
      {payload === null ? (
        <p className="text-muted-foreground text-sm">{t("unreadable")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="outline" className="font-normal">
              {t(kindLabelKey(payload), kindLabelValues(item))}
            </Badge>
            <span className="text-sm font-semibold break-words" data-testid="suggestion-value">
              {suggestedValue(payload)}
            </span>
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">{t("confidence", { percent: Math.round(payload.confidence * 100) })}</span>
          </div>
          <Reason reasons={payload.reasons} locale={locale} />
          <Evidence payload={payload} />
        </>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {payload === null ? null : (
          <Button type="button" size="sm" disabled={busy} onClick={onApprove} data-testid="suggestion-approve">
            <Check aria-hidden />
            {t("approve")}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReject} data-testid="suggestion-reject">
          <X aria-hidden />
          {t("reject")}
        </Button>
      </div>
    </li>
  );
}

function LastRun({ run }: { run: SuggestRunView | null }) {
  const t = useTranslations("interestSuggestions.lastRun");
  const format = useFormatter();
  if (run === null) return <p className="text-muted-foreground text-xs">{t("never")}</p>;
  const time = format.dateTime(new Date(run.requestedAt), { dateStyle: "medium", timeStyle: "short" });
  let detail: string;
  if (run.status === "pending" || run.status === "running") detail = t(run.status);
  else if (run.status === "failed") detail = t("failed");
  else if (run.skipped === "too_few_liked_jobs") detail = t("skippedFewJobs");
  else detail = t("done", { count: run.stored ?? 0 });
  return (
    <p className="text-muted-foreground text-xs" data-testid="suggest-last-run" data-status={run.status}>
      {t("line", { time, detail })}
    </p>
  );
}

function ErrorText({ code }: { code: SuggestionError }) {
  const t = useTranslations("interestSuggestions.errors");
  return <>{t(code)}</>;
}

function History({ items }: { items: SuggestionItemView[] }) {
  const t = useTranslations("interestSuggestions.history");
  const tKind = useTranslations("interestSuggestions");
  if (items.length === 0) return null;
  return (
    <details data-testid="suggestion-history">
      <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">{t("title", { count: items.length })}</summary>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2 text-xs" data-status={item.status}>
            <Badge variant="outline" className={cn("font-normal", item.status === "approved" ? "text-success-text border-success/40" : "text-muted-foreground")}>
              {item.status === "approved" ? t("approved") : t("rejected")}
            </Badge>
            {item.payload ? (
              <>
                <span className="text-muted-foreground">{tKind(kindLabelKey(item.payload), kindLabelValues(item))}</span>
                <span className="font-medium break-words">{suggestedValue(item.payload)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{tKind("unreadable")}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The "suggestions" block of /interests: what the weekly AI pass found, each with its evidence, to approve
 * (it is written into interests.yaml / preferences.yaml and the ranking is recomputed) or reject. Nothing here is
 * applied without a click.
 */
export function SuggestionsPanel({ data }: { data: SuggestionsSectionData }) {
  const t = useTranslations("interestSuggestions");
  const [gone, setGone] = useState<ReadonlySet<number>>(new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [errorState, setErrorState] = useState<SuggestionActionState>({ status: "idle" });
  const [lastApproved, setLastApproved] = useState<Extract<SuggestionActionState, { status: "approved" }> | null>(null);
  const [runState, setRunState] = useState<SuggestRunState>({ status: "idle" });
  const [pending, startTransition] = useTransition();
  const [runPending, startRun] = useTransition();

  const visible = data.pending.filter((item) => !gone.has(item.id));
  const runOpen = data.lastRun?.status === "pending" || data.lastRun?.status === "running" || runState.status === "queued";

  function decide(id: number, action: (id: number) => Promise<SuggestionActionState>) {
    setBusyId(id);
    startTransition(async () => {
      const result = await action(id);
      setBusyId(null);
      if (result.status === "approved" || result.status === "rejected") {
        setGone((previous) => new Set(previous).add(id));
        setErrorState({ status: "idle" });
        setLastApproved(result.status === "approved" ? result : null);
        toastTone("success", t(result.status === "approved" ? "toast.approved" : "toast.rejected"), { id: `suggestion-${id}` });
      } else {
        setErrorState(result);
      }
    });
  }

  function requestRun() {
    startRun(async () => {
      const result = await requestSuggestRunAction();
      setRunState(result);
    });
  }

  return (
    <Card className="gap-4 py-4" data-testid="suggestions-card">
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Sparkles aria-hidden className="text-primary size-4" />
            {t("title")}
            {visible.length > 0 ? (
              <Badge variant="secondary" data-testid="suggestions-count">
                {visible.length}
              </Badge>
            ) : null}
          </h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4 md:px-5">
        {data.loadError ? (
          <p role="alert" className="text-destructive text-sm">
            {t("loadError")}
          </p>
        ) : visible.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="suggestions-empty">
            {t("empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((item) => (
              <SuggestionCard
                key={item.id}
                item={item}
                busy={pending && busyId === item.id}
                onApprove={() => decide(item.id, approveSuggestionAction)}
                onReject={() => decide(item.id, rejectSuggestionAction)}
              />
            ))}
          </ul>
        )}

        {errorState.status === "error" ? (
          <p role="alert" className="text-destructive text-sm" data-testid="suggestion-error">
            <ErrorText code={errorState.error} />
          </p>
        ) : null}

        {lastApproved ? (
          <div role="status" className="border-success/40 bg-success/10 flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm" data-testid="suggestion-approved">
            <p className="font-medium">{lastApproved.change === "added" ? t("approvedAdded") : t("approvedPresent")}</p>
            {lastApproved.recompute.reconciled ? <p className="text-muted-foreground text-xs">{t("recompute.done", { checked: lastApproved.recompute.checked, updated: lastApproved.recompute.updated })}</p> : null}
            {lastApproved.recompute.rescanPending ? <p className="text-muted-foreground text-xs">{t("recompute.rescan")}</p> : null}
            {lastApproved.recompute.rescorePending ? <p className="text-muted-foreground text-xs">{t("recompute.rescore")}</p> : null}
          </div>
        ) : null}

        <div className="border-border flex flex-col gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" disabled={data.loadError || runPending || runOpen} onClick={requestRun} data-testid="suggest-run">
              {runPending || runOpen ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
              {runPending ? t("run.requesting") : t("run.button")}
            </Button>
            <LastRun run={data.lastRun} />
          </div>
          {runState.status === "queued" ? (
            <p role="status" className="text-muted-foreground text-xs" data-testid="suggest-run-queued">
              {runState.existing ? t("run.existing") : t("run.queued")}
            </p>
          ) : null}
          {runState.status === "error" ? (
            <p role="alert" className="text-destructive text-xs">
              {t("errors.databaseUnavailable")}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">{t("run.hint")}</p>
        </div>

        <History items={data.decided} />
      </CardContent>
    </Card>
  );
}

/** The reason in the interface language, else the AI's, else English, else any; tagged with its language. */
function Reason({ reasons, locale }: { reasons: Readonly<Record<string, string>>; locale: string }) {
  const picked = pickSummary(reasons, summaryOrder(locale, null));
  if (picked === null) return null;
  return (
    <p className="text-sm" lang={bcp47(picked.lang)} data-testid="suggestion-reason">
      {picked.text}
    </p>
  );
}
