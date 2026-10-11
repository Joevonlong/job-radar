import { BudgetExceededError } from "../errors";
import type { ChannelBudget } from "../types";

import type { JsearchSettings } from "@/lib/config";

type BudgetSettings = Pick<JsearchSettings, "monthly_request_limit" | "overage_cost_per_request_usd" | "pace_requests">;

/**
 * Requests the plan lets the channel have used by `now`: the monthly limit spread evenly over the
 * calendar month (rounded up, so the first day already has some). Returns the whole limit when the
 * month cannot be told apart from the budget's month (UTC date vs the schedule's time zone).
 */
export function pacedAllowance(limit: number, now: Date, budgetMonth: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(budgetMonth);
  if (!match) return limit;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (now.getUTCFullYear() !== year || now.getUTCMonth() + 1 !== month) return limit;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(limit, Math.ceil((limit * now.getUTCDate()) / daysInMonth));
}

/**
 * Raise `BudgetExceededError` (the cascade skips the channel for the rest of the cycle; not a failure)
 * when `requests` more requests are not allowed: the monthly limit is used up and no overage is
 * priced, the overage does not fit the USD budget, or the paced share of the limit is used up.
 * Call it before the request; book the usage with `budget.consume` after it succeeded.
 */
export function assertRequestsAllowed(budget: ChannelBudget, settings: BudgetSettings, requests: number, now: Date): void {
  const snapshot = budget.snapshot();
  const overage = Math.max(0, requests - snapshot.freeRecordsLeft);
  if (overage > 0) {
    if (settings.overage_cost_per_request_usd <= 0) {
      throw new BudgetExceededError("channel", `jsearch: monthly request limit reached (${snapshot.records} of ${settings.monthly_request_limit} requests used)`);
    }
    if (!budget.canAfford(requests)) {
      throw new BudgetExceededError("channel", `jsearch: monthly request limit reached and the budget does not cover more paid requests (${snapshot.records} used)`);
    }
    return;
  }
  if (settings.pace_requests && snapshot.records + requests > pacedAllowance(settings.monthly_request_limit, now, snapshot.month)) {
    throw new BudgetExceededError("channel", `jsearch: paced share of the monthly limit used for now (${snapshot.records} of ${settings.monthly_request_limit} requests)`);
  }
}
