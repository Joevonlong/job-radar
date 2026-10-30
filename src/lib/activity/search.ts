import { z } from "zod";
import { isDay } from "@/lib/ai-usage/range";
import { addDays } from "@/lib/insights/range";
import { resolveActivityDeleteScope } from "./manage";

export type ActivitySearchParams = Record<string, string | string[] | undefined>;
const day = z.string().refine(isDay);
export const activitySearchSchema = z.object({
  type: z.enum(["cycle", "request", "system", "all"]).catch("all"),
  status: z.enum(["active", "failed", "partial", "all"]).catch("all"),
  range: z.enum(["today", "7d", "30d", "custom"]).optional().catch(undefined),
  from: day.optional().catch(undefined), to: day.optional().catch(undefined),
  issues: z.literal("1").optional().catch(undefined),
  page: z.coerce.number().int().safe().positive().catch(1),
  level: z.enum(["info", "warn", "error", "all"]).catch("all"),
  cycle: z.coerce.number().int().safe().positive().optional().catch(undefined),
});
export type ActivityUrlState = z.infer<typeof activitySearchSchema>;

export function resolveActivityRange(state: ActivityUrlState, today: string, defaultDays: number, timeZone: string) {
  const days = state.range === "today" ? 1 : state.range === "7d" ? 7 : state.range === "30d" ? 30 : defaultDays;
  const custom = state.range === "custom" && state.from && state.to && state.from <= state.to;
  const from = custom ? state.from! : addDays(today, 1 - days);
  const to = custom ? state.to! : today;
  const scope = resolveActivityDeleteScope({ scope: "range", from, to }, timeZone);
  if (scope.kind !== "range" || scope.from === null) throw new Error("invalid range");
  return { from, to, fromInstant: scope.from, toInstant: scope.to };
}

/** Keep paging/filter links shareable; never serialize unvalidated search parameters. */
export function activityHref(state: ActivityUrlState, patch: Partial<ActivityUrlState> = {}, base = "/sources/logs"): string {
  const next = { ...state, ...patch };
  const params = new URLSearchParams();
  if (base === "/sources/logs") {
    if (next.type !== "all") params.set("type", next.type);
    if (next.status !== "all") params.set("status", next.status);
    if (next.range) params.set("range", next.range);
    if (next.range === "custom") {
      if (next.from) params.set("from", next.from);
      if (next.to) params.set("to", next.to);
    }
    if (next.issues) params.set("issues", next.issues);
  } else if (next.level !== "all") params.set("level", next.level);
  if (next.page > 1) params.set("page", String(next.page));
  return `${base}${params.size ? `?${params}` : ""}`;
}
