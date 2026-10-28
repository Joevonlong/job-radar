import { getTranslations } from "next-intl/server";

import type { AiWorkerStatus } from "@/lib/ops/ai-worker";
import { ageParts } from "@/lib/settings/age";
import type { SourcesView } from "@/lib/sources/view";

import { Banner } from "./banner";

/**
 * The two background programs the app depends on: the runner (collects on schedule) and the ai-worker (scores, translates, pushes).
 * One banner while either is silent, saying which one, for how long it has really been silent, what waits for it and what to do
 * (user-facing words, no dev paths). Nothing when both are fine (the ai-worker only counts when AI runs on the host).
 */
export async function HeartbeatBanner({ runner, aiWorker }: { runner: SourcesView["runner"]; aiWorker: AiWorkerStatus }) {
  const aiExpected = aiWorker.execution !== "container";
  const runnerOffline = !runner.online;
  const aiDown = aiExpected && !aiWorker.online;
  if (!runnerOffline && !aiDown) return null;
  const [t, tAge] = await Promise.all([getTranslations("sources.heartbeat"), getTranslations("settings.control.age")]);
  const age = (seconds: number): string => {
    const parts = ageParts(seconds);
    return tAge(parts.unit, { count: parts.count });
  };

  return (
    <Banner tone="warn" testId="heartbeat-warning" data-runner={runnerOffline ? "down" : "ok"} data-ai-worker={aiDown ? "down" : "ok"}>
      <ul className="flex flex-col gap-1">
        {runnerOffline ? (
          <li data-testid="heartbeat-runner">{runner.ageSeconds === null ? t("runnerNever") : t("runnerStale", { age: age(runner.ageSeconds) })}</li>
        ) : null}
        {aiDown ? (
          <li data-testid="heartbeat-ai-worker">
            {aiWorker.ageSeconds === null ? t("aiWorkerNever") : t("aiWorkerStale", { age: age(aiWorker.ageSeconds) })}
          </li>
        ) : null}
      </ul>
    </Banner>
  );
}
