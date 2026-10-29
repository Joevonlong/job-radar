import { sql } from "drizzle-orm";
import { createActivityRecorder, type ActivityRecorderOptions } from "@/lib/activity/recorder";
import type { ActivityRecorder, SpanHandle } from "@/lib/activity/types";
import type { Db } from "@/lib/db/client";
import { resetActivityTablesCache } from "@/lib/db/repos/activity";
import { activityEvents, activitySpans } from "@/lib/db/schema";
import { CYCLE_STEP_NAMES, registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { config } from "../cycle/helpers";
import { integrationActivitySettings } from "./activity-helpers";

export const HOOK_NOW = new Date("2026-10-07T12:00:00Z");

export function hookConfig() {
  const result = config();
  result.search = {
    keyword_groups: { engineering: ["Engineer"] }, locations: ["Test City A", "Test City B", "Test City C"],
    remote_scope: "none", window_hours: { morning: 24, evening: 12, weekend: 48 }, max_per_group_per_location: 2,
  };
  result.schedule = { ...result.schedule, timezone: "UTC", skip_if_running: true };
  result.channels = { ...result.channels, paid_total_monthly_budget_usd: 100, collect: { ...result.channels.collect, concurrency: 1 } };
  return result;
}

/** Keep collect real; later steps are explicit no-ops unless a scenario replaces one. */
export function isolateHookSteps(): void {
  resetCycleSteps();
  for (const name of CYCLE_STEP_NAMES) if (name !== "collect") registerCycleStep(name, async () => {});
}

export async function resetHookTables(db: Db): Promise<void> {
  resetActivityTablesCache();
  await db.execute(sql`truncate table activity_events, activity_spans, control_requests, notifications,
    applications, jobs, companies, raw_postings, runs, cycles, channels, runtime_state restart identity cascade`);
}

export function hookRecorder(db: Db, options: Partial<ActivityRecorderOptions> = {}) {
  const settings = integrationActivitySettings();
  // Every test tree fits without depending on opportunistic background flushes.
  settings.writer.queue_max = 1000;
  settings.writer.batch_size = 100;
  return createActivityRecorder({ db, process: "runner", autoFlush: false, loadSettings: () => settings, warn: () => {}, ...options });
}

export async function activityRows(db: Db) {
  const spans = await db.select().from(activitySpans).orderBy(activitySpans.startedAt, activitySpans.id);
  const events = await db.select().from(activityEvents).orderBy(activityEvents.at, activityEvents.id);
  return { spans, events };
}

/** Read the complete persisted records, including columns a narrower projection could miss. */
export async function activityText(db: Db): Promise<string> {
  const rows = await db.execute<{ record: string }>(sql`
    select row_to_json(s)::text as record from activity_spans s
    union all select row_to_json(e)::text as record from activity_events e`);
  return rows.map((row) => row.record).join("\n");
}

/** Observe calls while forwarding every operation to the real recorder and real writer. */
export function observeFinishes(recorder: ActivityRecorder) {
  const finishes = new Map<string, number>();
  const track = (span: SpanHandle): SpanHandle => {
    finishes.set(span.id, finishes.get(span.id) ?? 0);
    return {
      ...span,
      child: (name, links) => track(span.child(name, links)),
      finish: (...args) => { finishes.set(span.id, (finishes.get(span.id) ?? 0) + 1); span.finish(...args); },
    };
  };
  const observed: ActivityRecorder = {
    ...recorder,
    cycleRoot: (...args) => track(recorder.cycleRoot(...args)),
    systemRoot: (...args) => track(recorder.systemRoot(...args)),
    attachCycle: (...args) => track(recorder.attachCycle(...args)),
    requestRoot: (...args) => {
      const span = recorder.requestRoot(...args);
      return { ...track(span), discard: () => span.discard() };
    },
  };
  return { recorder: observed, finishes };
}
