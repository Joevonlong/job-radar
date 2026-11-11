/** Operations egress allow-lists. No raw errors, doctor details, arbitrary JSON, paths or job dimensions cross this boundary. */
import { z } from "zod";
import { safeErrorCode, SAFE_ERROR_CODES } from "@/lib/activity/error-codes";
import { EVENT_CODES, EVENT_LEVELS, SPAN_NAMES, SPAN_SCOPES, SPAN_STATUSES } from "@/lib/activity/names";
import { CHANNEL_CONFIG_TABLE } from "@/lib/channels/config-table";
import { AI_PROVIDER_IDS, AI_TASK_NAMES } from "@/lib/config/ai-options";
import { STEP_NAMES } from "@/lib/cycle/step-health";
import type { ActivityRootRow, ActivitySpanRow, ActivityEventRow } from "@/lib/db/queries/activity";
import type { AiUsageGroup } from "@/lib/db/queries/ai-usage";
import type { RecentRun } from "@/lib/db/queries/sources";
import type { Cycle } from "@/lib/db/repos/cycles";
import type { Run } from "@/lib/db/repos/runs";
import type { DoctorReport } from "@/lib/ops/doctor/types";
import type { SourceCard } from "@/lib/sources/view";
import type { McpTranslator } from "../text";

const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();
const stamp = z.iso.datetime().nullable();
const notices = z.array(z.string());
const code = z.enum([...SAFE_ERROR_CODES, "other"]);
const runStatus = z.enum(["running", "succeeded", "partial", "failed", "skipped", "unknown"]);
const checkStatus = z.enum(["ok", "warn", "fail"]);
const channelId = z.enum([...Object.keys(CHANNEL_CONFIG_TABLE), "unknown"]);
const providerId = z.enum([...AI_PROVIDER_IDS, "unknown"]);
const taskId = z.enum([...AI_TASK_NAMES, "probe", "unknown"]);
const errorDto = z.strictObject({ category: z.enum(["channel", "activity", "step"]), code });
const errorOf = (category: z.infer<typeof errorDto>["category"], value: unknown) => value === null || value === undefined ? null : { category, code: safeErrorCode(value) };
const iso = (value: Date | null) => value?.toISOString() ?? null;
const enumOrUnknown = <T extends string>(schema: z.ZodType<T>, value: unknown): T | "unknown" => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
};

export const DOCTOR_IDS = [
  "docker.daemon", "compose.services", "compose.project", "compose.db", "compose.web", "compose.runner", "compose.jobspy", "compose.career-pdf",
  "web.http", "web.access", "db.connect", "db.migrations", "runner.heartbeat", "aiworker.launchd", "aiworker.heartbeat",
  "ai.claude", "ai.codex", "ai.profile", "ai.backlog", "ai.quota", "config.guards", "config.layers", "config.market", "config.pending", "config.shipped", "i18n.config",
  "telegram.credentials", "telegram.allowed_users", "telegram.enabled", "network.public_url", "tailscale.status", "tailscale.serve",
  "backup.recent", "disk.free", "disk.backups", "disk.docker", "disk.docker_location", "disk.internal", "host.power",
  "data.traps", "data.mcp", "data.replies", "data.ownership", "data.deliveries", "data.current_scores", "setup.completed",
  "channels.each", "channels.enabled", "channels.disabled", "channels.linkedin", "budget.all", "budget.paid", "budget.ai_api",
  "sources.registry", "cycle.last", "cycle.next", "ops.releases_lock", "ops.ai_worker_swap_backup",
  ...Object.keys(CHANNEL_CONFIG_TABLE).map((id) => `channels.${id}`),
];
const doctorId = z.enum([...DOCTOR_IDS, "unknown"]);
const doctorCheckDto = z.strictObject({ id: doctorId, status: checkStatus, summary: z.string() });
export const systemStatusOutput = z.strictObject({
  notices,
  doctor: z.strictObject({ generated_at: z.iso.datetime(), status: checkStatus, checks: z.array(doctorCheckDto) }),
  runner_online: z.boolean(), ai_worker_online: z.boolean(), cycle_running: z.boolean(), pending_requests: count,
  disk: checkStatus.nullable(),
});

/** Every summary is fixed translated wording, including checks that normally print paths, commands or hosts. */
export function toDoctorDto(report: DoctorReport, text: McpTranslator) {
  return {
    generated_at: report.generatedAt,
    status: report.worst,
    checks: report.checks.map((check) => ({
      id: doctorId.safeParse(check.id).success ? check.id : "unknown",
      status: check.status,
      summary: text(`ops.checkSummary.${check.status}`),
    })),
  };
}

const COUNTERS = ["queries", "runs", "fetched", "inserted", "changed", "unchanged", "succeeded", "failed", "skipped", "interrupted", "processed", "parsed", "created", "updated", "relisted", "parseFailed", "deferred", "evaluated", "passed", "filteredOut", "scored", "translated", "pushed", "newJobs", "passedFilter", "qualified", "overflow", "deleted", "pruned", "candidates", "checked", "reviewed", "fresh", "read", "stored", "oversized", "ownSkipped", "cleared", "seen", "reopened", "possiblyClosed", "linkChecked", "closed", "alive", "scanned", "withSignals", "signals", "synced", "salarySynced", "bonusUpdated", "revalued", "trapsScanned", "visaScanned", "ghostScanned"] as const;
const countsDto = z.strictObject(Object.fromEntries(COUNTERS.map((key) => [key, count.optional()])) as Record<(typeof COUNTERS)[number], z.ZodOptional<typeof count>>);
const tolerantCount = count.optional().catch(undefined);
const storedCounts = z.object(Object.fromEntries(COUNTERS.map((key) => [key, tolerantCount])) as Record<(typeof COUNTERS)[number], typeof tolerantCount>);
const nestedCounts = storedCounts.nullish().catch(undefined);
const storedResult = storedCounts.extend({
  channels: z.record(z.string(), storedCounts).optional(), jobs: nestedCounts, subtasks: z.array(z.object({ result: nestedCounts })).optional(),
  scan: nestedCounts, salary: nestedCounts, bonus: nestedCounts, revalued: nestedCounts, traps: nestedCounts, visa: nestedCounts, ghost: nestedCounts,
});
const storedStep = z.object({ name: z.enum(STEP_NAMES), status: z.enum(["ok", "partial", "failed", "skipped"]), result: storedResult.optional().catch(undefined) });
const stepDto = z.strictObject({ name: z.enum(STEP_NAMES), status: storedStep.shape.status, counts: countsDto });
const cycleDto = z.strictObject({ id: count, kind: z.enum(["weekday_morning", "weekday_evening", "weekend", "manual", "catchup", "unknown"]), started_at: z.iso.datetime(), finished_at: stamp, status: runStatus, steps: z.array(stepDto) });
const runDto = z.strictObject({ id: count, channel_id: channelId, started_at: z.iso.datetime(), finished_at: stamp, status: runStatus, fetched: count, new_count: count, interrupted: z.boolean(), usage_units: amount, window_hours: amount.nullable(), window_extended: z.boolean(), error: errorDto.nullable() });
export const listCyclesOutput = z.strictObject({ notices, returned: count, truncated: z.boolean(), cycles: z.array(cycleDto), expanded: z.strictObject({ cycle: cycleDto, runs: z.array(runDto), returned: count, truncated: z.boolean() }).nullable() });

function stepCounts(result: z.infer<typeof storedResult> | undefined) {
  const totals: Partial<Record<(typeof COUNTERS)[number], number>> = {};
  if (!result) return totals;
  const parts = [storedCounts.parse(result), ...Object.values(result.channels ?? {}), ...(result.jobs ? [result.jobs] : []), ...(result.subtasks ?? []).flatMap((task) => task.result ? [task.result] : [])];
  for (const part of parts) {
    for (const key of COUNTERS) {
      const value = part[key];
      if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  const signalCounts = [
    ["scanned", result.scan?.scanned], ["withSignals", result.scan?.withSignals], ["signals", result.scan?.signals],
    ["salarySynced", result.salary?.synced], ["bonusUpdated", result.bonus?.updated], ["revalued", result.revalued?.updated],
    ["trapsScanned", result.traps?.scanned], ["visaScanned", result.visa?.scanned], ["ghostScanned", result.ghost?.scanned],
  ] as const;
  for (const [key, value] of signalCounts) if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
  for (const part of [result.scan, result.salary, result.traps, result.visa, result.ghost]) {
    if (part?.failed !== undefined) totals.failed = (totals.failed ?? 0) + part.failed;
  }
  return totals;
}

export function toCycleDto(row: Cycle) {
  const summary = z.object({ steps: z.array(z.unknown()) }).safeParse(row.summaryJson);
  const steps = summary.success ? summary.data.steps.flatMap((raw) => {
    const step = storedStep.safeParse(raw);
    return step.success ? [{ name: step.data.name, status: step.data.status, counts: stepCounts(step.data.result) }] : [];
  }) : [];
  return { id: row.id, kind: enumOrUnknown(cycleDto.shape.kind, row.kind), started_at: row.startedAt.toISOString(), finished_at: iso(row.finishedAt), status: enumOrUnknown(runStatus, row.status), steps };
}

export function toRunDto(row: Run) {
  return { id: row.id, channel_id: enumOrUnknown(channelId, row.channelId), started_at: row.startedAt.toISOString(), finished_at: iso(row.finishedAt), status: enumOrUnknown(runStatus, row.status), fetched: row.fetched, new_count: row.newCount, interrupted: row.interrupted, usage_units: row.usageUnits, window_hours: row.windowHours, window_extended: row.windowExtended, error: errorOf("channel", row.errorCode ?? (row.error === null ? null : "other")) };
}

const latestRunDto = z.strictObject({ id: count, status: runStatus, started_at: z.iso.datetime(), finished_at: stamp, fetched: count, new_count: count, interrupted: z.boolean(), error: errorDto.nullable() });
const breakerState = z.enum(["closed", "open", "half_open", "unknown"]);
const channelDto = z.strictObject({
  id: channelId, enabled: z.boolean(), registered: z.boolean(), health: z.enum(["off", "not_registered", "missing_credentials", "open", "half_open", "failing", "degraded", "ok", "idle", "unknown"]),
  breaker: z.strictObject({ state: breakerState, open_until: stamp, consecutive_failures: count, error: errorDto.nullable() }).nullable(),
  usage: z.strictObject({ records: count, usd: amount, budget_usd: amount, included_records: count }), latest_run: latestRunDto.nullable(),
});
export const listChannelsOutput = z.strictObject({ notices, month: z.string().regex(/^\d{4}-\d{2}$/), total: count, returned: count, truncated: z.boolean(), channels: z.array(channelDto) });
function toLatestRunDto(row: RecentRun) {
  return { id: row.id, status: enumOrUnknown(runStatus, row.status), started_at: row.startedAt.toISOString(), finished_at: iso(row.finishedAt), fetched: row.fetched, new_count: row.newCount, interrupted: row.interrupted, error: errorOf("channel", row.errorCode ?? (row.error === null ? null : "other")) };
}
export function toChannelDto(row: SourceCard) {
  return {
    id: enumOrUnknown(channelId, row.id), enabled: row.enabled, registered: row.registered, health: enumOrUnknown(channelDto.shape.health, row.status),
    breaker: row.circuit ? { state: enumOrUnknown(breakerState, row.circuit.state), open_until: iso(row.circuit.openUntil), consecutive_failures: row.circuit.consecutiveFailures, error: errorOf("channel", row.circuit.lastErrorCode) } : null,
    usage: { records: row.usage.records, usd: row.usage.usd, budget_usd: row.usage.budgetUsd, included_records: row.usage.freeRecords },
    latest_run: row.runs[0] ? toLatestRunDto(row.runs[0]) : null,
  };
}

const activityName = z.enum([...SPAN_NAMES, "unknown"]);
const activityStatus = z.enum([...SPAN_STATUSES, "unknown"]);
const activityRootDto = z.strictObject({ id: z.uuid(), scope: z.enum([...SPAN_SCOPES, "unknown"]), name: activityName, status: activityStatus, started_at: z.iso.datetime(), finished_at: stamp, active: z.boolean(), progress_done: count.nullable(), progress_total: count.nullable(), failed_children: count, warn_events: count, error_events: count, events_dropped: count, error: errorDto.nullable() });
const activitySpanDto = z.strictObject({ id: z.uuid(), parent_id: z.uuid().nullable(), name: activityName, status: activityStatus, progress_done: count.nullable(), progress_total: count.nullable(), events_dropped: count, error: errorDto.nullable() });
const activityEventDto = z.strictObject({ id: z.uuid(), span_id: z.uuid(), level: z.enum([...EVENT_LEVELS, "unknown"]), code: z.enum([...EVENT_CODES, "unknown"]), count: count.nullable(), error: errorDto.nullable() });
export const activityLogOutput = z.strictObject({ notices, state: z.enum(["ready", "not_ready", "not_found", "error"]), page: count, total: count, returned: count, truncated: z.boolean(), roots: z.array(activityRootDto), detail: z.strictObject({ root: activityRootDto, spans: z.array(activitySpanDto), spans_truncated: z.boolean(), events: z.array(activityEventDto), events_total: count }).nullable() });
export function toActivityRootDto(row: ActivityRootRow) {
  return { id: row.id, scope: enumOrUnknown(activityRootDto.shape.scope, row.scope), name: enumOrUnknown(activityName, row.name), status: enumOrUnknown(activityStatus, row.status), started_at: row.startedAt.toISOString(), finished_at: iso(row.finishedAt), active: row.active, progress_done: row.progressDone, progress_total: row.progressTotal, failed_children: row.failedChildren, warn_events: row.warnEvents, error_events: row.errorEvents, events_dropped: row.eventsDropped, error: errorOf("activity", row.reasonCode ?? row.request?.errorCode) };
}
export function toActivitySpanDto(row: ActivitySpanRow) {
  return { id: row.id, parent_id: row.parentId, name: enumOrUnknown(activityName, row.name), status: enumOrUnknown(activityStatus, row.status), progress_done: row.progressDone, progress_total: row.progressTotal, events_dropped: row.eventsDropped, error: errorOf("activity", row.reasonCode) };
}
export function toActivityEventDto(row: ActivityEventRow) {
  const value = count.safeParse(row.params.count);
  return { id: row.id, span_id: row.spanId, level: enumOrUnknown(activityEventDto.shape.level, row.level), code: enumOrUnknown(activityEventDto.shape.code, row.code), count: value.success ? value.data : null, error: errorOf("activity", row.params.error_code) };
}

const usageMeasuresDto = z.strictObject({ calls: count, tokens_in: amount, tokens_out: amount, token_unknown_calls: count, duration_ms: amount, duration_unknown_calls: count, cost_usd: amount, cost_unknown_calls: count });
const dayUsageDto = z.strictObject({ day: z.iso.date(), ...usageMeasuresDto.shape });
const taskUsageDto = z.strictObject({ task: taskId, ...usageMeasuresDto.shape });
const modelUsageDto = z.strictObject({ provider: providerId, model: z.string().nullable(), ...usageMeasuresDto.shape });
export const aiUsageOutput = z.strictObject({ notices, from: z.iso.date(), to: z.iso.date(), time_zone: z.string(), returned: count, truncated: z.boolean(), totals: usageMeasuresDto, by_day: z.array(dayUsageDto), by_task: z.array(taskUsageDto), by_model: z.array(modelUsageDto) });
function usageMeasures(rows: readonly AiUsageGroup[]) {
  return {
    calls: rows.reduce((n, row) => n + row.calls, 0), tokens_in: rows.reduce((n, row) => n + row.tokensIn, 0), tokens_out: rows.reduce((n, row) => n + row.tokensOut, 0),
    token_unknown_calls: rows.reduce((n, row) => n + row.calls - row.tokenCalls, 0), duration_ms: rows.reduce((n, row) => n + row.durationMsSum, 0), duration_unknown_calls: rows.reduce((n, row) => n + row.calls - row.durationCalls, 0),
    cost_usd: rows.reduce((n, row) => n + row.actualUsd, 0), cost_unknown_calls: rows.reduce((n, row) => n + row.calls - row.actualCalls, 0),
  };
}
function buckets(rows: readonly AiUsageGroup[], key: (row: AiUsageGroup) => string) {
  const result = new Map<string, AiUsageGroup[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return [...result.entries()];
}
export function toAiUsageDto(rows: readonly AiUsageGroup[], knownModelIds: ReadonlySet<string>) {
  const provider = (row: AiUsageGroup) => providerId.safeParse(row.provider).success ? row.provider : "unknown";
  const model = (row: AiUsageGroup) => row.model !== null && knownModelIds.has(row.model) ? row.model : null;
  const task = (row: AiUsageGroup) => taskId.safeParse(row.task).success ? row.task : "unknown";
  return {
    totals: usageMeasures(rows),
    by_day: buckets(rows, (row) => row.day).map(([day, group]) => ({ day, ...usageMeasures(group) })).sort((a, b) => b.day.localeCompare(a.day)),
    by_task: buckets(rows, task).map(([task, group]) => ({ task, ...usageMeasures(group) })).sort((a, b) => b.calls - a.calls || a.task.localeCompare(b.task)),
    by_model: buckets(rows, (row) => JSON.stringify([provider(row), model(row)])).map(([, group]) => ({ provider: provider(group[0]!), model: model(group[0]!), ...usageMeasures(group) }))
      .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider) || (a.model ?? "").localeCompare(b.model ?? "")),
  };
}
