import { z } from "zod";

import { BudgetExceededError, ChannelError } from "../../errors";
import { apifyDatePostedSchema } from "../apify/contract";

export { MAX_RESPONSE_CHARS } from "../apify/contract";
export const MONID_API_KEY_ENV = "MONID_API_KEY";

/** Full raw config block; values (including prices and timeouts) come from sources.yaml. */
export const monidSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  markets: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).optional(),
  monthly_budget_usd: z.number().nonnegative(),
  throttle: z.strictObject({ min_delay_ms: z.number().int().nonnegative(), max_delay_ms: z.number().int().nonnegative() })
    .refine((t) => t.min_delay_ms <= t.max_delay_ms, { path: ["min_delay_ms"], message: "min_delay_ms must be <= max_delay_ms" }),
  max_results: z.number().int().positive(),
  api_base_url: z.url({ protocol: /^https?$/ }),
  provider: z.string().trim().min(1),
  endpoint: z.string().trim().startsWith("/").min(2),
  price_per_1k_usd: z.number().nonnegative(),
  flat_fee_usd: z.number().nonnegative(),
  poll_interval_ms: z.number().int().positive(),
  timeout_ms: z.number().int().positive(),
  stop_grace_ms: z.number().int().positive(),
  country_name: z.string().trim().optional(),
  remote_locations: z.strictObject({ home_country: z.string().optional(), region: z.string().optional(), worldwide: z.string().optional() }).default({}),
  date_posted: apifyDatePostedSchema,
  input_template: z.record(z.string(), z.unknown()),
  remote_input: z.record(z.string(), z.unknown()),
}).refine((s) => s.poll_interval_ms <= s.timeout_ms, { path: ["poll_interval_ms"], message: "poll_interval_ms must be <= timeout_ms" });
export type MonidSettings = z.infer<typeof monidSettingsSchema>;
export type MonidPricing = Pick<MonidSettings, "price_per_1k_usd" | "flat_fee_usd">;

const finalInputSchema = z.object({
  jobTitles: z.array(z.string().trim().min(1)).length(1),
  locations: z.array(z.string().trim().min(1)).length(1),
  maxItems: z.number().int().positive(),
});

/** Check after template substitution AND remote overrides: zero means unlimited to the actor. */
export function validateFinalInput(input: unknown, limit: number): void {
  const parsed = finalInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.maxItems !== limit) {
    throw new ChannelError("unknown", "Monid input needs one title, one location and maxItems equal to the run limit", { retryable: false });
  }
}

export const runIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const billedUnitsSchema = z.number().int().nonnegative();
export const dollarCostSchema = z.object({ value: z.number().nonnegative(), currency: z.literal("USD") });
export const microDollarCostSchema = z.object({ value: z.number().nonnegative(), unit: z.literal("MICRO_DOLLAR"), currency: z.literal("USD") });
const billingFieldsSchema = z.object({
  calculatedCost: z.unknown().optional(),
  reportedCost: z.unknown().optional(),
  actualCost: z.unknown().optional(),
});
export const billingSchema = z.object({
  calculatedCost: microDollarCostSchema.optional(),
  reportedCost: microDollarCostSchema.optional(),
  actualCost: microDollarCostSchema.optional(),
});
export const priceSchema = z.object({
  type: z.string().min(1),
  amount: z.number().nonnegative(),
  flatFee: z.number().nonnegative().optional(),
  currency: z.literal("USD").optional(),
});
export const providerResponseSchema = z.object({ httpStatus: z.number().int().min(100).max(599) });

/** Billing and output are checked separately so malformed output cannot prevent accounting. */
const runFields = {
  runId: runIdSchema.optional(),
  cost: z.unknown().optional(),
  billing: z.unknown().optional(),
  billedUnits: z.unknown().optional(),
  providerResponse: z.unknown().optional(),
  output: z.unknown().optional(),
  price: z.unknown().optional(),
};
export const runResponseSchema = z.object({ ...runFields, status: z.string().trim().min(1) });
export type MonidRun = z.infer<typeof runResponseSchema>;
export const acceptedRunSchema = z.object({ ...runFields, runId: runIdSchema, status: z.string().trim().min(1).optional() });
export const stopAcceptedSchema = z.object({ ...runFields, status: z.literal("STOPPING") });
export const errorResponseSchema = z.object({
  error: z.union([z.string(), z.object({ code: z.string().optional(), message: z.string().optional() })]).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
}).refine((body) => body.error !== undefined || body.code !== undefined || body.message !== undefined);
export const stopConflictSchema = z.union([runResponseSchema, errorResponseSchema]);
export const outputSchema = z.array(z.unknown());

export function isTerminal(status: string): boolean {
  return !["READY", "RUNNING", "STOPPING"].includes(status);
}

/** Status in the JSON body takes precedence over HTTP, including a 200 BLOCKED response. */
export function errorForResponse(httpStatus: number, body: unknown): ChannelError | null {
  const parsed = runResponseSchema.safeParse(body);
  if (parsed.success) {
    const { status, providerResponse } = parsed.data;
    if (status === "BLOCKED") return new BudgetExceededError("channel", "Monid workspace blocked the run");
    if (status === "COMPLETED") {
      const provider = providerResponseSchema.safeParse(providerResponse);
      if (!provider.success) return new ChannelError("parse", "Monid completed run has no valid provider HTTP status");
      const code = provider.data.httpStatus;
      if ((code >= 200 && code < 300) || code === 404) return null;
      if (code === 429) return new ChannelError("rate_limited", "Monid provider rate limited the run", { status: code });
      if (code >= 500) return new ChannelError("network", "Monid provider failed the run", { status: code, retryable: true });
      return new ChannelError("unknown", "Monid provider rejected the run", { status: code, retryable: false });
    }
    if (status === "STOPPED") return new ChannelError("network", "Monid run stopped before completion", { retryable: true });
    if (isTerminal(status)) return new ChannelError("network", "Monid run failed or timed out", { retryable: true });
  }
  if (httpStatus === 402 || httpStatus === 503) return new BudgetExceededError("channel", "Monid wallet needs credit or activation");
  if (httpStatus === 401) return new ChannelError("auth_expired", "Monid API key is invalid", { status: httpStatus });
  if (httpStatus === 403) return new ChannelError("blocked", "Monid workspace access denied", { status: httpStatus });
  if (httpStatus === 429) return new ChannelError("rate_limited", "Monid rate limited the request", { status: httpStatus });
  if (httpStatus === 408 || (httpStatus >= 500 && httpStatus !== 502)) {
    return new ChannelError("network", "Monid request failed", { status: httpStatus, retryable: true });
  }
  return httpStatus >= 400 ? new ChannelError("unknown", "Monid request rejected", { status: httpStatus, retryable: false }) : null;
}

export interface RunCost {
  costUsd: number;
  units: number;
  source: "settled" | "calculated" | "estimate";
  invalidFields: string[];
  conservative: boolean;
}

/** Pure billing precedence, including explicit zero settlements and per-terminal-state estimates. */
export function calculateRunCost(run: MonidRun, limit: number, pricing: MonidPricing): RunCost {
  const count = Array.isArray(run.output) ? run.output.length : 0;
  const invalidFields: string[] = [];
  const units = billedUnitsSchema.safeParse(run.billedUnits);
  if (run.billedUnits !== undefined && !units.success) invalidFields.push("billedUnits");
  const billing = billingFieldsSchema.safeParse(run.billing);
  if (run.billing !== undefined && !billing.success) invalidFields.push("billing");
  const settled: number[] = [];
  const read = (field: string, value: unknown, micro: boolean): void => {
    if (value === undefined) return;
    const parsed = (micro ? microDollarCostSchema : dollarCostSchema).safeParse(value);
    if (!parsed.success) invalidFields.push(field);
    else settled.push(parsed.data.value / (micro ? 1e6 : 1));
  };
  read("cost", run.cost, false);
  read("billing.reportedCost", billing.success ? billing.data.reportedCost : undefined, true);
  read("billing.actualCost", billing.success ? billing.data.actualCost : undefined, true);
  const calculated = billing.success ? billing.data.calculatedCost : undefined;
  const parsedCalculated = microDollarCostSchema.safeParse(calculated);
  if (calculated !== undefined && !parsedCalculated.success) invalidFields.push("billing.calculatedCost");
  const result = (costUsd: number, source: RunCost["source"], conservative = false): RunCost => ({
    costUsd, units: units.success ? units.data : count, source, invalidFields, conservative,
  });
  const invalidCost = (): boolean => invalidFields.some((field) => field !== "billedUnits");
  if (!invalidCost() && settled.length > 0) return result(Math.max(...settled), "settled");
  if (!invalidCost() && parsedCalculated.success) return result(parsedCalculated.data.value / 1e6, "calculated");
  const estimate = (items: number): number => items * pricing.price_per_1k_usd / 1000 + pricing.flat_fee_usd;
  if (units.success) return result(estimate(units.data), "estimate");
  if (run.status === "COMPLETED") return result(estimate(count), "estimate");
  if (run.status === "BLOCKED" || run.status === "STOPPED") return result(0, "estimate");
  return result(estimate(limit), "estimate", true);
}
