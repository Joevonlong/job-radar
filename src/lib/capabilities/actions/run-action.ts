import { giveBackAgentBudget, readAgentBudget, takeAgentBudget, type BudgetRefusal } from "@/lib/agent-access/budget";
import type { AgentCaller } from "@/lib/agent-access/caller";
import type { AgentAction } from "@/lib/config/schemas/mcp";
import type { ControlActionState } from "@/lib/control/service-types";
import type { Db } from "@/lib/db/client";
import { formatFullTime } from "@/lib/format/time";
import { ToolFailure, type McpContext } from "@/lib/mcp/context";
import { actionOutput } from "@/lib/mcp/dto/actions";
import { actionAvailable } from "./availability";

type EnqueueResult =
  | { state: "queued"; requestId: number; existing: boolean }
  | { state: "cached" }
  | { state: "error"; error: string };

const errorCategories = {
  invalidPayload: "invalid_input", invalid: "invalid_input", unknownChannel: "unknown_channel",
  nothingToScore: "nothing_to_score", databaseUnavailable: "database", tooSoon: "too_soon",
  backfillOverLimit: "backfill_over_limit", cycleBusy: "cycle_busy", configUnavailable: "config_error",
} as const;

export const actionCaller = (ctx: Pick<McpContext, "caller">): AgentCaller => ctx.caller?.tokenId ?? "stdio";

export function budgetRefusalText(ctx: Pick<McpContext, "text" | "timezone">, refusal: BudgetRefusal): string {
  const zone = ctx.timezone();
  return ctx.text(refusal.reason === "total_cap" ? "errors.totalBudget" : "errors.actionBudget", {
    action: refusal.action, cap: refusal.cap, remaining: refusal.remaining, requested: refusal.requested,
    reset: formatFullTime(refusal.resetsAt, { locale: ctx.text.locale, timeZone: zone }), zone,
  });
}

const actionErrorMessages = {
  not_found: "actionErrors.not_found",
  disabled: "actionErrors.disabled",
  quota: "actionErrors.quota",
  busy: "actionErrors.busy",
  too_soon: "actionErrors.too_soon",
  cycle_busy: "actionErrors.cycle_busy",
  another_cycle_running: "actionErrors.another_cycle_running",
  backfill_over_limit: "actionErrors.backfill_over_limit",
  invalid_input: "actionErrors.invalid_input",
  unknown_channel: "actionErrors.unknown_channel",
  nothing_to_score: "actionErrors.nothing_to_score",
  database: "actionErrors.database",
  config_error: "actionErrors.config_error",
  no_description: "actionErrors.no_description",
  same_language: "actionErrors.same_language",
  no_web_provider: "actionErrors.no_web_provider",
  not_ready: "actionErrors.not_ready",
  no_material: "actionErrors.no_material",
  too_long: "actionErrors.too_long",
  failed: "actionErrors.failed",
} as const;

export function actionFailure(ctx: Pick<McpContext, "text">, error: string): ToolFailure {
  const category = Object.hasOwn(errorCategories, error) ? errorCategories[error as keyof typeof errorCategories] : error;
  const known = Object.hasOwn(actionErrorMessages, category) ? category as keyof typeof actionErrorMessages : "failed";
  return new ToolFailure(known, ctx.text(actionErrorMessages[known]));
}

export function controlOutcome(outcome: ControlActionState): EnqueueResult {
  if (outcome.status === "queued") return { state: "queued", requestId: outcome.request, existing: outcome.existing };
  return { state: "error", error: outcome.status === "error" ? outcome.error : "failed" };
}

/** Reserve before enqueueing; only a newly queued request keeps its ticket, including when a later response read fails. */
export async function runAction(ctx: McpContext, action: AgentAction, enqueue: (db: Db, caller: AgentCaller) => Promise<EnqueueResult>, options: { units?: number } = {}) {
  if (!await actionAvailable(ctx, action) || !ctx.actions) throw new ToolFailure("disabled", ctx.text("errors.actionDisabled"));
  const db = ctx.actions.db;
  const caller = actionCaller(ctx);
  const now = ctx.now();
  const deps = { budgets: () => ctx.settings.budgets, timeZone: ctx.timezone, now: () => now };
  const taken = await takeAgentBudget(db, { caller, action, units: options.units }, deps);
  if (!taken.ok) throw new ToolFailure("over_budget", budgetRefusalText(ctx, taken.refusal));
  let created = false;
  let outcome: Exclude<EnqueueResult, { state: "error" }>;
  try {
    const result = await enqueue(db, caller);
    if (result.state === "error") throw actionFailure(ctx, result.error);
    created = result.state === "queued" && !result.existing;
    outcome = result;
  } finally {
    if (!created) await giveBackAgentBudget(db, taken.ticket);
  }
  const budget = await readAgentBudget(db, caller, deps);
  return actionOutput.parse({
    request_id: outcome.state === "queued" ? outcome.requestId : null,
    state: outcome.state === "cached" ? "cached" : outcome.existing ? "joined_existing" : "queued",
    existing: outcome.state === "queued" && outcome.existing,
    budget: { action, remaining: budget.actions[action].remaining, resets_at: budget.resetsAt.toISOString() },
    notices: [],
  });
}
