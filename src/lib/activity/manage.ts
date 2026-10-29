/** Server Action service. No logging here: actions own logActionFailure and error presentation. */
import { z } from "zod";

import { isDay } from "@/lib/ai-usage/range";
import { loadConfig } from "@/lib/config";
import { activityTablesReady, deleteActivityBatch, previewActivityDelete, type ActivityDeleteScope, type Db } from "@/lib/db";
import { addDays, dayInZone } from "@/lib/insights/range";

const daySchema = z.string().refine((value) => {
  try { return isDay(value) && /^\d{4}-\d{2}-\d{2}$/.test(addDays(value, 1)); } catch { return false; }
}, "invalid calendar day");
const rootInput = z.strictObject({ scope: z.literal("root"), rootId: z.uuid() });
const rangeInput = z.strictObject({ scope: z.literal("range"), from: daySchema.optional(), to: daySchema });
const allInput = z.strictObject({ scope: z.literal("all") });
const ordered = (input: { scope: string; from?: string; to?: string }): boolean => input.scope !== "range" || !input.from || !input.to || input.from <= input.to;
export const activityDeleteInputSchema = z.discriminatedUnion("scope", [rootInput, rangeInput, allInput]).refine(ordered, "reversed date range");
const asOfSchema = z.iso.datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)), "invalid instant");
export const activityDeleteExecuteSchema = z.discriminatedUnion("scope", [
  rootInput.extend({ asOf: asOfSchema }), rangeInput.extend({ asOf: asOfSchema }), allInput.extend({ asOf: asOfSchema }),
]).refine(ordered, "reversed date range");
export type ActivityDeleteInput = z.infer<typeof activityDeleteInputSchema>;
export type ActivityDeleteExecuteInput = z.infer<typeof activityDeleteExecuteSchema>;
export type PreviewDeleteResult = { status: "ok"; asOf: string; roots: number; events: number; skippedActive: number } | { status: "not_ready" | "invalid" };
export type ExecuteDeleteResult = { status: "done" | "partial"; roots: number; events: number } | { status: "not_ready" | "invalid" };

/** First instant of a calendar day in an IANA zone, including offset changes at midnight and skipped days. */
function startOfDay(day: string, timeZone: string): Date {
  const target = Date.parse(`${day}T00:00:00Z`);
  // Bracket the boundary using UTC day arithmetic, then find its first millisecond via the existing zone helper.
  let low = Date.parse(`${addDays(day, -2)}T00:00:00Z`);
  let high = Date.parse(`${addDays(day, 2)}T00:00:00Z`);
  if (!Number.isFinite(target) || !Number.isFinite(low) || !Number.isFinite(high)) throw new RangeError("invalid calendar day");
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dayInZone(new Date(middle), timeZone) < day) low = middle + 1;
    else high = middle;
  }
  return new Date(low);
}

/** Inclusive UI day range becomes [from, day-after-to) in schedule.yaml's timezone. */
export function resolveActivityDeleteScope(input: ActivityDeleteInput, timeZone: string): ActivityDeleteScope {
  switch (input.scope) {
    case "root": return { kind: "root", rootId: input.rootId };
    case "all": return { kind: "all" };
    case "range": return { kind: "range", from: input.from ? startOfDay(input.from, timeZone) : null, to: startOfDay(addDays(input.to, 1), timeZone) };
  }
}
function settings() {
  const config = loadConfig("activityLog");
  return { config, liveness: { staleAfterSeconds: config.liveness.stale_after_seconds, startupGraceSeconds: config.liveness.startup_grace_seconds } };
}

/** Invalid caller data returns a code; database/config failures propagate for the action to log safely. */
export async function previewDelete(db: Db, input: unknown): Promise<PreviewDeleteResult> {
  if (!(await activityTablesReady(db))) return { status: "not_ready" };
  const parsed = activityDeleteInputSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" };
  const { liveness } = settings();
  const scope = resolveActivityDeleteScope(parsed.data, loadConfig("schedule").timezone);
  const preview = await previewActivityDelete(db, scope, liveness);
  return { status: "ok", ...preview, asOf: preview.asOf.toISOString() };
}

/** Budget is checked between bounded transactions. Reusing the same input/asOf safely resumes a partial deletion. */
export async function executeDelete(db: Db, input: unknown): Promise<ExecuteDeleteResult> {
  if (!(await activityTablesReady(db))) return { status: "not_ready" };
  const parsed = activityDeleteExecuteSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" };
  const { config, liveness } = settings();
  const { asOf, ...scopeInput } = parsed.data;
  const scope = resolveActivityDeleteScope(scopeInput, loadConfig("schedule").timezone);
  // A client-supplied asOf can only narrow the deletion: entries started after the server's now are never in scope.
  const cutoff = new Date(Math.min(Date.parse(asOf), Date.now()));
  const started = performance.now();
  const total = { roots: 0, events: 0 };
  do {
    const batch = await deleteActivityBatch(db, {
      scope, asOf: cutoff, liveness, batchSize: config.prune.batch_size, rootsPerBatch: config.prune.roots_per_batch,
    });
    total.roots += batch.roots;
    total.events += batch.events;
    if (!batch.found) return { status: "done", ...total };
  } while (performance.now() - started < config.ui.delete_budget_ms);
  return { status: "partial", ...total };
}
