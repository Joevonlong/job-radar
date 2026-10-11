import type { McpConfig } from "@/lib/config/schemas/mcp";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import type { Db } from "@/lib/db/client";

import { formatCallLine, type LogLine } from "./call-log";
import { errorResult } from "./guard";
import type { McpTranslator } from "./text";

/** Everything a tool reads besides its arguments; the server passes the real loaders, tests their own. */
export interface McpContext {
  /** A read-only connection (`createReadOnlyDb`). */
  db: Db;
  settings: McpConfig;
  now: () => Date;
  /** schedule.yaml `timezone`: what "today" and the date filters mean. */
  timezone: () => string;
  /** traps.yaml; may throw (the JD is then withheld). */
  traps: () => TrapsConfig;
  /** notify.yaml reminder thresholds in days; may throw (`stale_only` then fails). */
  reminderDays: () => { interested: number; applied: number };
  /** The market's base currency the salary filter compares in; null = none. */
  baseCurrency: () => string | null;
  /** The raw city values a city name stands for (its metro group's members). */
  cityMembers: (db: Db, city: string) => Promise<string[]>;
  /** The spellings of a search text that also match the location field. */
  locationTerms: (query: string) => string[];
  text: McpTranslator;
  log: LogLine;
}

type ErrorResult = ReturnType<typeof errorResult>;

/** A failure a tool reports on purpose (job not found, ...): its own message, a category for the log line. */
export class ToolFailure extends Error {
  constructor(
    readonly category: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolFailure";
  }
}

/** The category of an unexpected error: never its message, which may hold an address, a path or a query. */
export function errorCategory(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") return "database";
  return "internal";
}

/**
 * Runs one tool call: the call log line (tool, item count, time, ok / failure category; no arguments, no result) and the error
 * result for anything thrown. A `ToolFailure` keeps its message; any other error is reported by its category only.
 */
export async function runLogged<R>(ctx: McpContext, tool: string, call: () => Promise<{ result: R; count: number }>): Promise<R | ErrorResult> {
  const started = performance.now();
  try {
    const { result, count } = await call();
    ctx.log(formatCallLine({ tool, ok: true, count, ms: performance.now() - started }));
    return result;
  } catch (error) {
    const category = error instanceof ToolFailure ? error.category : errorCategory(error);
    ctx.log(formatCallLine({ tool, ok: false, count: 0, ms: performance.now() - started, category }));
    return errorResult(error instanceof ToolFailure ? error.message : ctx.text("errors.failed", { category }));
  }
}
