import type { JobListViz } from "@/components/jobs/job-row";
import { loadConfig } from "@/lib/config";
import { salaryAxisScale } from "@/components/viz/salary-shared";
import { loadBaseCurrency, loadSalaryFloor } from "@/lib/signals/floor";

import { loadDealBreakerLabels } from "./deal-breakers";

/** Scales and lines of the list graphics and the names of the deal-breakers, read from `ui.yaml` / `notify.yaml` / `preferences.yaml` on every request (C8: no thresholds in code). */
export function loadListViz(now: Date, timezone: string): JobListViz {
  const ui = loadConfig("ui");
  return {
    pushLine: loadConfig("notify").push_min_score,
    bonusCap: loadConfig("interests").bonus_cap,
    floor: loadSalaryFloor(),
    salaryAxis: salaryAxisScale(ui, loadBaseCurrency() ?? ""),
    freshness: { decayHours: ui.freshness.decay_hours, warnHours: ui.freshness.warn_hours },
    nowIso: now.toISOString(),
    timezone,
    dealBreakerLabels: loadDealBreakerLabels(),
  };
}
