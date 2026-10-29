import { MAX_WINDOW_HOURS } from "@/lib/config/schemas/channels";
import type { ControlActionState } from "@/lib/control/service-types";
import type { RunCyclePayload } from "@/lib/control/types";

/** Operator syntax; the service alone enforces the installation's configured cap. */
export function parseBackfillArg(text: string): number | null {
  const match = /^([1-9]\d*)(h|d)$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]) * (match[2] === "d" ? 24 : 1);
  return Number.isSafeInteger(hours) && hours <= MAX_WINDOW_HOURS ? hours : null;
}

export function validateBackfillCliArgs({ dryRun, kind }: { dryRun: boolean; kind: string }): string | null {
  if (dryRun) return "a backfill is executed by the runner through the request queue; a dry run does not use it";
  if (kind !== "manual") return "--backfill requires --kind manual";
  return null;
}

interface SubmitDependencies {
  request: (payload: RunCyclePayload) => Promise<ControlActionState>;
  out: (message: string) => void;
  err: (message: string) => void;
}

/** Queue only: collection belongs to the runner, never this operator process. */
export async function submitBackfill({ hours, channelIds }: { hours: number; channelIds: string[] }, { request, out, err }: SubmitDependencies): Promise<number> {
  const state = await request({ backfillHours: hours, ...(channelIds.length > 0 ? { channelIds } : {}) });
  if (state.status === "queued") {
    out(`backfill request #${state.request} queued (${hours} h); the runner executes it, follow it on /sources`);
    return 0;
  }
  if (state.status === "error") {
    const reasons: Record<typeof state.error, string> = {
      backfillOverLimit: `backfill exceeds the configured maximum (${state.maxBackfillHours ?? "unknown"} h)`,
      cycleBusy: "a run is already queued or running; try again when it is over",
      unknownChannel: "unknown channel",
      invalidPayload: "invalid backfill request",
      databaseUnavailable: "database unavailable",
      nothingStale: "nothing stale to process",
      nothingToScore: "nothing to score",
      tooSoon: "a recent request is still cooling down",
    };
    err(reasons[state.error]);
  } else err("backfill request was not queued");
  return 1;
}
