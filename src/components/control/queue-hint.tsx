"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { INK_LINK } from "@/components/ui/ink-link";
import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { formatClock } from "@/lib/format/clock";
import { ageParts } from "@/lib/settings/age";
import { cn } from "@/lib/utils";

import type { ControlRequestStage } from "./use-control-request";

interface QueueHintProps {
  queue: ControlQueueView | null;
  stage: ControlRequestStage | null;
  /** schedule.yaml `timezone` for the start times (default: the browser's). */
  timeZone?: string | undefined;
  /** Text colour and size of the lines (default: the job page's secondary text). */
  className?: string;
}

/**
 * The lines under a waiting button: how many requests go first and what the process is doing meanwhile (queued), since when
 * this request runs (running), and a warning with a link to /sources while the process has no fresh heartbeat. It only adds
 * lines: the component's own state (`data-state`, `data-stage`) does not change. A live region whose text only changes when
 * its content does (the elapsed minutes at most once a minute), so a screen reader is not read the same line every poll.
 */
export function QueueHint({ queue, stage, timeZone, className }: QueueHintProps) {
  const t = useTranslations("controlQueue");
  const tKind = useTranslations("settings.control.requests.kind");
  const tAge = useTranslations("settings.control.age");
  const format = useFormatter();
  if (!queue || stage === null) return null;

  const process = queue.worker.process ?? "none";
  const clock = (iso: string): string => formatClock(format, iso, timeZone);
  // every request kind has a name (tests/i18n/control-wait-copy.test.ts); a kind of a newer server falls back to its code
  const kindName = (kind: string): string => {
    const key = kind as Parameters<typeof tKind>[0];
    return tKind.has(key) ? tKind(key) : kind;
  };
  const age = queue.worker.heartbeatAgeSeconds === null ? "never" : ((parts) => tAge(parts.unit, { count: parts.count }))(ageParts(queue.worker.heartbeatAgeSeconds));
  const minutes = queue.startedAt ? Math.max(0, Math.floor((new Date(queue.now).getTime() - new Date(queue.startedAt).getTime()) / 60_000)) : 0;

  return (
    <div role="status" className={cn("flex flex-col gap-0.5", className ?? "text-ink-2 text-body-sm")} data-testid="queue-hint" data-offline={!queue.worker.online} data-ahead={stage === "pending" ? queue.ahead : undefined}>
      {!queue.worker.online ? (
        <p className="text-warning-text" data-testid="queue-hint-offline" data-process={process}>
          {queue.worker.process === null ? t("noProcess") : t("offline", { process, age })}{" "}
          <Link href="/sources" className={INK_LINK} data-testid="queue-hint-sources">
            {t("sourcesLink")}
          </Link>
        </p>
      ) : null}
      {stage === "pending" ? <p data-testid="queue-hint-ahead">{t("ahead", { count: queue.ahead })}</p> : null}
      {stage === "pending" && queue.running ? (
        <p data-testid="queue-hint-running" data-kind={queue.running.kind}>
          {t("running", { process, kind: kindName(queue.running.kind), time: clock(queue.running.since) })}
        </p>
      ) : null}
      {stage === "running" && queue.startedAt ? <p data-testid="queue-hint-self">{t("self", { time: clock(queue.startedAt), minutes })}</p> : null}
    </div>
  );
}
