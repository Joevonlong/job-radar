/** The cycle schedule: when the next cycle runs and whether the last ones did. */
import { Cron } from "croner";

import { findMissedCycle, SCHEDULED_KINDS } from "@/lib/cycle/schedule";

import { ageSeconds, fail, formatAgo, formatDuration, formatLocal, joinList, merge, ok, warn, type Piece } from "../helpers";
import { loadSources } from "../shared";
import { type DoctorCheck } from "../types";

const lastSpec = { id: "cycle.last", group: "schedule" } as const;

export const lastCycleCheck: DoctorCheck = {
  ...lastSpec,
  async run(ctx) {
    const { t } = ctx;
    const sources = await loadSources(ctx);
    const latest = sources.latestCycle;
    const { schedule } = ctx.config;
    // Scheduled cycles wait for the first-run setup; that is not a failure (setup.completed reports it)
    const setupPending = (await ctx.probes.setup()).pending;
    if (latest === null && setupPending) return ok(lastSpec, t("checks.cycle.last.setupWaiting"));
    if (latest === null) return warn(lastSpec, t("checks.cycle.last.never"), t("checks.cycle.last.neverHint"));
    const pieces: Piece[] = [];
    const age = ageSeconds(latest.startedAt, ctx.now);
    const when = t("checks.cycle.last.when", { time: formatLocal(latest.startedAt, schedule.timezone), ago: formatAgo(ctx, age) });
    const kind = latest.kind;
    const failedChannels = latest.channels.filter((c) => c.failed > 0 && c.succeeded === 0).map((c) => c.channelId);
    if (latest.status === "failed") {
      pieces.push({ status: "fail", detail: t("checks.cycle.last.failed", { kind, when }), hint: t("checks.cycle.last.failedHint") });
    } else if (latest.status === "partial" || failedChannels.length > 0) {
      pieces.push({
        status: "warn",
        detail: failedChannels.length > 0 ? t("checks.cycle.last.partialChannels", { kind, when, channels: joinList(ctx, failedChannels) }) : t("checks.cycle.last.partial", { kind, when }),
        hint: t("checks.cycle.last.partialHint"),
      });
    } else if (latest.status === "running") {
      pieces.push({ status: "ok", detail: t("checks.cycle.last.running", { kind, when }) });
    } else {
      pieces.push({ status: "ok", detail: latest.status === "succeeded" ? t("checks.cycle.last.succeeded", { kind, when }) : t("checks.cycle.last.other", { kind, when, status: latest.status }) });
    }

    if (setupPending) return merge(ctx, lastSpec, [...pieces, { status: "ok", detail: t("checks.cycle.last.setupWaiting") }]);
    const missed = findMissedCycle(ctx.now, schedule, latest.startedAt);
    if (missed !== null && ageSeconds(missed.slot, ctx.now) > ctx.settings.cycle_grace_minutes * 60) {
      pieces.push({
        status: "fail",
        detail: t("checks.cycle.last.missed", { slot: formatLocal(missed.slot, schedule.timezone), kind: missed.kind, elapsed: formatDuration(ctx, ageSeconds(missed.slot, ctx.now)) }),
        hint: t("checks.cycle.last.missedHint"),
      });
    }
    return merge(ctx, lastSpec, pieces);
  },
};

const nextSpec = { id: "cycle.next", group: "schedule" } as const;

export const nextCycleCheck: DoctorCheck = {
  ...nextSpec,
  async run(ctx) {
    const { schedule } = ctx.config;
    const upcoming: Array<{ kind: string; at: Date }> = [];
    for (const kind of SCHEDULED_KINDS) {
      const cycle = schedule.cycles[kind];
      if (!cycle.enabled) continue;
      const job = new Cron(cycle.cron, { timezone: schedule.timezone, paused: true });
      try {
        const at = job.nextRun(ctx.now);
        if (at !== null) upcoming.push({ kind, at });
      } finally {
        job.stop();
      }
    }
    upcoming.sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = upcoming[0];
    if (first === undefined) return fail(nextSpec, ctx.t("checks.cycle.next.none"), ctx.t("checks.cycle.next.noneHint"));
    const untilSeconds = Math.round((first.at.getTime() - ctx.now.getTime()) / 1000);
    return ok(
      nextSpec,
      ctx.t("checks.cycle.next.ok", { kind: first.kind, time: formatLocal(first.at, schedule.timezone), zone: schedule.timezone, until: ctx.t("common.inFuture", { duration: formatDuration(ctx, untilSeconds) }) }),
    );
  },
};

export const SCHEDULE_CHECKS: readonly DoctorCheck[] = [lastCycleCheck, nextCycleCheck];
