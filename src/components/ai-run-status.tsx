import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { INK_LINK } from "@/components/ui/ink-link";

export interface AiRunStatusProps {
  /** `pending`: waits for the ai-worker; `running`: the worker is on it. */
  status: "pending" | "running";
  cycleId: number | null;
  /** Seconds since the worker took the request (since it was queued, while it waits). */
  elapsedSeconds: number;
  scored: number;
  translated: number;
  className?: string;
}

/** `m:ss` (or `h:mm:ss`) of a number of seconds. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * "AI processing" for the AI part of a cycle that the ai-worker is working on (queued or running): the heading, the
 * cycle, what it has produced so far and how long it has taken. Shown on /settings and Today while the part is open.
 */
export function AiRunStatus({ status, cycleId, elapsedSeconds, scored, translated, className }: AiRunStatusProps) {
  const t = useTranslations("aiRun");
  return (
    <div className={cn("flex flex-col gap-0.5", className)} role="status" data-testid="ai-run-status" data-status={status}>
      <p className="text-warning-text flex items-center gap-2 text-sm font-medium">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        {status === "pending" ? t("pending") : t("running")}
      </p>
      <p className="text-muted-foreground text-xs" data-testid="ai-run-progress">
        {[
          cycleId === null ? null : t("cycle", { id: cycleId }),
          status === "running" ? t("progress", { scored, translated }) : t("waiting", { time: formatElapsed(elapsedSeconds) }),
          status === "running" ? t("elapsed", { time: formatElapsed(elapsedSeconds) }) : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ")}
      </p>
      {status === "pending" ? (
        <p className="text-muted-foreground text-xs">
          {t("pendingHint")}{" "}
          <Link href="/sources" className={INK_LINK}>
            {t("viewWorker")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
