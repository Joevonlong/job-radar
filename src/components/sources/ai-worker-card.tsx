import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { Led, type LedTone } from "@/components/viz";
import type { AiWorkerStatus } from "@/lib/ops/ai-worker";
import { ageParts } from "@/lib/settings/age";

import { Block, BlockNote, BlockState } from "./block";
import { formatWhen } from "./format";

const AI_ERROR_CODES = ["ai_failed", "cycle_not_found", "aborted", "unknown"] as const;

function workerState(worker: AiWorkerStatus): "online" | "offline" | "never" {
  return worker.ageSeconds === null ? "never" : worker.online ? "online" : "offline";
}

/**
 * The host ai-worker: AI runs on the Mac with the local subscriptions, so this block shows
 * whether that process is alive (light + words), how many AI requests wait for it, and how the last `run_ai` went.
 */
export async function AiWorkerCard({ worker, timeZone }: { worker: AiWorkerStatus; timeZone: string }) {
  const [t, tAge, format] = await Promise.all([getTranslations("sources.aiWorker"), getTranslations("settings.control.age"), getFormatter()]);
  const age = (seconds: number): string => {
    const parts = ageParts(seconds);
    return tAge(parts.unit, { count: parts.count });
  };
  const state = workerState(worker);
  const queued = worker.queue.pending + worker.queue.running;
  const { lastRun } = worker;
  const container = worker.execution === "container";
  const tone: LedTone = container ? "idle" : state === "online" ? "good" : state === "never" ? "idle" : "bad";

  return (
    <Block
      label={<Led tone={tone} live={!container && state === "online" && queued > 0} label={t("title")} />}
      data-testid="ai-worker-card"
      data-state={container ? "container" : state}
      data-queued={queued}
    >
      {container ? (
        <BlockNote>{t("container")}</BlockNote>
      ) : (
        <>
          <BlockState>
            {t(`state.${state}`)}
            {state === "online" ? ` · ${queued === 0 ? t("queueShortEmpty") : t("queueShort", { count: queued })}` : null}
          </BlockState>
          {worker.ageSeconds !== null ? <BlockNote>{t("heartbeat", { age: age(worker.ageSeconds) })}</BlockNote> : null}
        </>
      )}
      <BlockNote data-testid="ai-worker-queue">{queued === 0 ? t("queueEmpty") : t("queue", { pending: worker.queue.pending, running: worker.queue.running })}</BlockNote>
      {lastRun?.aiStatus === "skipped_profile_incomplete" ? (
        <BlockNote className="text-warning-text" role="status" data-testid="ai-worker-profile-skip" data-status="skipped_profile_incomplete">
          {t("profileSkipped", { id: lastRun.cycleId ?? "-", time: lastRun.finishedAt ? formatWhen(format, lastRun.finishedAt, timeZone) : "-" })}{" "}
          <Link href="/me" className="underline underline-offset-2">
            {t("profileSkippedLink")}
          </Link>
        </BlockNote>
      ) : lastRun ? (
        <BlockNote data-testid="ai-worker-last-run" data-status={lastRun.status}>
          {t(`lastRun.${lastRun.status}`, {
            id: lastRun.cycleId ?? "-",
            time: lastRun.finishedAt ? formatWhen(format, lastRun.finishedAt, timeZone) : "-",
            scored: lastRun.scored ?? 0,
            translated: lastRun.translated ?? 0,
            pushed: lastRun.pushed ?? 0,
            error: t(`error.${AI_ERROR_CODES.find((code) => code === lastRun.error) ?? "unknown"}`),
          })}
        </BlockNote>
      ) : queued > 0 ? (
        // the first run is being worked on: "never ran" would contradict the queue line above
        <BlockNote data-testid="ai-worker-processing">{t("lastRunProcessing")}</BlockNote>
      ) : (
        <BlockNote>{t("lastRunNone")}</BlockNote>
      )}
    </Block>
  );
}
