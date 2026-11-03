"use client";

import { AlertTriangle, Check, Clock, Loader2, Minus, Play, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";

import { requestResearchAction as rawRequestAll, requestResearchItemAction as rawRequestItem, researchStatusAction as rawStatus, type ResearchActionResult } from "@/app/jobs/[id]/research-bar-actions";
import { Button } from "@/components/ui/button";
import { withActionFeedback } from "@/lib/actions/client";
import { RESEARCH_ITEMS, type ResearchItem } from "@/lib/config/schemas/research";
import { formatClock } from "@/lib/format/clock";
import { canMoveUp, type ResearchBarStatus, type ResearchItemStatus } from "@/lib/research/bar-view";
import { toastTone } from "@/lib/toast";

const requestAll = withActionFeedback(rawRequestAll)((): ResearchActionResult => ({ ok: false, error: "failed" }));
const requestItem = withActionFeedback(rawRequestItem)((): ResearchActionResult => ({ ok: false, error: "failed" }));

const POLL_MS = 3000;

const ANCHORS: Record<ResearchItem, string> = { company: "#h-company-background", breakdown: "#h-breakdown", salary: "#h-pay" };

/** Codes with their own sentence; every other failure (the provider's) reads as "failed". */
const ERROR_LABELS = ["quota", "disabled", "no_web_provider", "not_found", "no_description", "config_error", "not_ready", "invalid"] as const;
type ErrorLabel = (typeof ERROR_LABELS)[number] | "failed";

const errorKey = (error: string): ErrorLabel => ERROR_LABELS.find((label) => label === error) ?? "failed";

function isRunning(status: ResearchBarStatus): boolean {
  return Object.values(status.items).some((item) => item.state === "running");
}

function doneKey(status: ResearchBarStatus): string {
  return RESEARCH_ITEMS.map((item) => status.items[item]?.state ?? "").join(",");
}

function StateIcon({ item }: { item: ResearchItemStatus }) {
  switch (item.state) {
    case "done":
      return item.expired ? <Clock className="text-warn size-3.5" aria-hidden /> : <Check className="text-good size-3.5" aria-hidden />;
    case "running":
      return canMoveUp(item) ? <Clock className="text-ink-3 size-3.5" aria-hidden /> : <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />;
    case "deferred":
      return <Clock className="text-warn size-3.5" aria-hidden />;
    case "failed":
      return <AlertTriangle className="text-bad size-3.5" aria-hidden />;
    default:
      return <Minus className="text-ink-3 size-3.5" aria-hidden />;
  }
}

/** The state of the job's research in one line under its title: what is there, what is on its way, and a button for the rest. */
export function ResearchBar({ jobId, initial, timeZone }: { jobId: number; initial: ResearchBarStatus; timeZone: string }) {
  const t = useTranslations("research.bar");
  const format = useFormatter();
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  // a refreshed page brings newer state
  const [shownInitial, setShownInitial] = useState(initial);
  if (initial !== shownInitial) {
    setShownInitial(initial);
    setStatus(initial);
  }
  const [pending, startTransition] = useTransition();
  const seen = useRef(doneKey(initial));

  // the page's own panels show the results: a part that finished refreshes them
  const apply = (next: ResearchBarStatus | null): void => {
    if (!next) return;
    setStatus(next);
    const key = doneKey(next);
    if (key !== seen.current) {
      seen.current = key;
      router.refresh();
    }
  };

  const running = isRunning(status);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void rawStatus(jobId).then((result) => {
        if (result) apply(result.status);
      }, () => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `apply` only reads refs and setters
  }, [running, jobId]);

  const handle = (result: ResearchActionResult): void => {
    if (!result.ok) {
      toastTone("error", t(`error.${errorKey(result.error)}`));
      return;
    }
    apply(result.status);
    const errors = Object.entries(result.errors);
    if (errors.length > 0) toastTone("error", errors.map(([item, error]) => `${t(`item.${item as ResearchItem}`)}: ${t(`error.${errorKey(error)}`)}`).join(" "));
  };

  const stateText = (item: ResearchItemStatus): string => {
    switch (item.state) {
      case "done":
        return item.expired ? t("state.expired") : t("state.done", { n: item.ageDays });
      case "running":
        return canMoveUp(item) ? t("state.queuedAuto") : t("state.running");
      case "deferred":
        return item.resumeAt ? t("state.deferred", { time: formatClock(format, item.resumeAt, timeZone) }) : t("state.deferredUnknown");
      case "failed":
        return t(`error.${errorKey(item.error)}`);
      case "off":
        return t("state.off");
      case "unavailable":
        return t("state.unavailable");
      default:
        return t("state.missing");
    }
  };

  const shown = RESEARCH_ITEMS.filter((item) => status.items[item] !== undefined);
  const canRunAll = status.canRequest && shown.some((name) => {
    const item = status.items[name];
    return item !== undefined && (canMoveUp(item) || item.state === "missing" || item.state === "failed" || item.state === "deferred" || (item.state === "done" && item.expired));
  });

  return (
    <section aria-label={t("label")} className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="research-bar">
      <ul className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        {shown.map((name) => {
          const item = status.items[name] as ResearchItemStatus;
          const canRun = status.canRequest && (item.state !== "running" || canMoveUp(item)) && item.state !== "off" && item.state !== "unavailable";
          const label = t(`item.${name}`);
          return (
            <li key={name} className="text-body-sm flex min-w-0 flex-wrap items-center gap-1" data-testid={`research-bar-${name}`} data-state={item.state}>
              <StateIcon item={item} />
              <a href={ANCHORS[name]} className="text-ink font-medium underline-offset-2 hover:underline focus-visible:underline">
                {label}
              </a>
              <span className="text-ink-2">{stateText(item)}</span>
              {item.state === "off" ? (
                <Link href={`/settings?tab=${item.settingsTab}`} className="text-ink-2 underline underline-offset-2" data-testid={`research-bar-${name}-settings`}>
                  {t("settings")}
                </Link>
              ) : null}
              {canRun ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={pending}
                  aria-label={item.state === "done" ? t("refreshItem", { item: label }) : t("runItem", { item: label })}
                  title={item.state === "done" ? t("refreshItem", { item: label }) : t("runItem", { item: label })}
                  onClick={() => startTransition(async () => handle(await requestItem({ jobId, item: name })))}
                  data-testid={`research-bar-${name}-run`}
                >
                  {item.state === "done" ? <RefreshCw aria-hidden /> : <Play aria-hidden />}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canRunAll ? (
        <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending} onClick={() => startTransition(async () => handle(await requestAll(jobId)))} data-testid="research-bar-all">
          {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles aria-hidden />}
          {t("runAll")}
        </Button>
      ) : null}
    </section>
  );
}
