/**
 * How many subscription-CLI calls Job Radar makes, to choose the ai.yaml `quota_guard` caps. READ-ONLY.
 *
 *   pnpm ai:usage-stats [--window-hours 5] [--min-days 14] [--min-cycles 20] [--json]
 *
 * Reads `ai_usage` (and `cycles.started_at`) of DATABASE_URL in a read-only session (the server refuses any write) and
 * prints per provider: the calls in a rolling window ending at every call and the calls per cycle (p50 / p95 / max),
 * then the caps that follow: 1.5 x the maxima, or the fallback when the history is shorter than --min-days or has
 * fewer than --min-cycles cycles with calls (codex-cli: 2 x per_cycle_limit per cycle and twice that per window;
 * claude-cli: 10 / 20). Only counts and times are read, never prompts or answers.
 */
import { parseArgs } from "node:util";

import { QUOTA_GUARDED_PROVIDERS, suggestQuotaCaps } from "../src/lib/ai/quota-guard";
import { loadConfig } from "../src/lib/config";
import { aiUsageStats, createConnection } from "../src/lib/db";
import { loadDatabaseEnv } from "../src/lib/env";

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

const fmt = (value: number | null): string => (value === null ? "-" : String(Math.round(value * 10) / 10));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "window-hours": { type: "string" },
      "min-days": { type: "string" },
      "min-cycles": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: pnpm ai:usage-stats [--window-hours 5] [--min-days 14] [--min-cycles 20] [--json]");
    return 0;
  }
  const windowHours = positive(values["window-hours"], 5, "window-hours");
  const minDays = positive(values["min-days"], 14, "min-days");
  const minCycles = positive(values["min-cycles"], 20, "min-cycles");
  const perCycleLimit = loadConfig("ai").per_cycle_limit;

  const { sql, db } = createConnection(loadDatabaseEnv().DATABASE_URL, { max: 1, readOnly: true });
  try {
    const stats = await aiUsageStats(db, { providers: QUOTA_GUARDED_PROVIDERS, windowHours });
    const rows = stats.map((s) => ({
      ...s,
      suggestion: suggestQuotaCaps(
        { provider: s.provider, firstAt: s.firstAt, lastAt: s.lastAt, windowMax: s.window.max, cycleMax: s.cycle.max, cycles: s.cycle.samples },
        { perCycleLimit, minDays, minCycles },
      ),
    }));
    if (values.json) {
      console.log(JSON.stringify({ windowHours, minDays, minCycles, perCycleLimit, providers: rows }, null, 2));
      return 0;
    }
    console.log(`window ${windowHours} h · per_cycle_limit ${perCycleLimit} · history needed: ${minDays} days and ${minCycles} cycles`);
    for (const row of rows) {
      const span = row.firstAt && row.lastAt ? `${row.firstAt.toISOString()} .. ${row.lastAt.toISOString()}` : "no calls";
      console.log(`\n${row.provider}: ${row.calls} calls (${span})`);
      console.log(`  per ${windowHours} h window: p50 ${fmt(row.window.p50)} · p95 ${fmt(row.window.p95)} · max ${fmt(row.window.max)}`);
      console.log(`  per cycle (${row.cycle.samples} cycles): p50 ${fmt(row.cycle.p50)} · p95 ${fmt(row.cycle.p95)} · max ${fmt(row.cycle.max)}`);
      const s = row.suggestion;
      console.log(`  suggested (${s.basis}): hard_requests ${s.hardRequests} · cycle_request_cap ${s.cycleRequestCap}`);
    }
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
