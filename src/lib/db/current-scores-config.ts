import { loadConfig } from "@/lib/config/load";

/** Explicit migration input, also used by startup and preparation scripts. */
export function currentScoresBackfill() {
  const config = loadConfig("currentScores").backfill;
  return { lockTimeoutMs: config.lock_timeout_ms, statementTimeoutMs: config.statement_timeout_ms };
}
