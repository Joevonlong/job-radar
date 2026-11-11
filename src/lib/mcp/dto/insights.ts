import { z } from "zod";
import type { Permission } from "@/lib/agent-access/permissions";
import { notices } from "./shared";

const number = z.number().nullable();
const histogram = z.strictObject({ from: z.number(), to: number, count: z.number().int() });
export const insightsMatchDto = z.strictObject({ filters: z.array(z.strictObject({ code: z.string().nullable(), jobs: z.number().int(), share: z.number() })) });
export const insightsTrackingDto = z.strictObject({ applied: z.number().int(), funnel: z.array(z.strictObject({ stage: z.string(), count: z.number().int(), conversion: number })), exits: z.strictObject({ rejected: z.number().int(), withdrawn: z.number().int(), archived: z.number().int() }) });
export const insightsOutput = z.strictObject({
  notices, truncated: z.boolean(), range_days: z.number().int(), window: z.strictObject({ from: z.string(), to: z.string() }), text_withheld: z.string().nullable(),
  kpi: z.strictObject({ total: z.number().int(), previous_total: z.number().int(), change: number, passed: z.number().int(), pass_rate: number, previous_pass_rate: number, pass_rate_change_pt: number, salary_rate: number, avg_rank: number }),
  daily: z.array(z.strictObject({ day: z.string(), passed: z.number().int(), filtered: z.number().int(), avg_rank: number })),
  sources: z.array(z.strictObject({ family: z.string().nullable(), total: z.number().int(), passed: z.number().int(), pass_rate: z.number() })),
  cities: z.array(z.strictObject({ kind: z.enum(["city", "remote", "other"]), city: z.string().nullable(), count: z.number().int(), share: z.number() })),
  salary: z.strictObject({ passed: z.number().int(), disclosed: z.number().int(), comparable: z.number().int(), rate: number, median_per_year: number, currency: z.string(), bars: z.array(histogram) }),
  signals: z.strictObject({ passed: z.number().int(), without_signal: z.number().int(), high_value: z.number().int(), avg_rank: number, categories: z.array(z.strictObject({ id: z.string(), label: z.string(), jobs: z.number().int(), share: z.number(), avg_rank: number })) }),
  scores: z.strictObject({ scored: z.number().int(), pending: z.number().int(), avg_rank: number, bars: z.array(histogram) }),
  conversion: z.strictObject({ fetched: z.number().int(), passed: z.number().int(), pushable: z.number().int() }),
  match: insightsMatchDto.optional(), tracking: insightsTrackingDto.optional(),
});
export function insightsOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<z.infer<typeof insightsOutput>> {
  if (permissions.has("match:read") && permissions.has("tracking:read")) return insightsOutput;
  if (permissions.has("match:read")) return insightsOutput.omit({ tracking: true });
  if (permissions.has("tracking:read")) return insightsOutput.omit({ match: true });
  return insightsOutput.omit({ match: true, tracking: true });
}
