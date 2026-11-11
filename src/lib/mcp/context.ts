import type { Permission } from "@/lib/agent-access/permissions";
import type { McpConfig } from "@/lib/config/schemas/mcp";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import type { SearchPlan } from "@/lib/jobs/search-query";
import type { Db } from "@/lib/db/client";
import type { WriterInputs } from "@/lib/writer/settings";
import type { AuditEntry, AuditOutcome, AuditRecorder, AuditTarget } from "@/lib/agent-access/audit";
import type { Grant, GrantReader } from "@/lib/agent-access/authorize";

import { formatCallLine, type LogLine } from "./call-log";
import { errorResult } from "./guard";
import type { McpTranslator } from "./text";

/** What the application writer's tools need beyond the read-only connection. */
export interface McpWriterAccess {
  /** writer.yaml, me.yaml and stories.yaml as they are now. */
  inputs: () => WriterInputs;
  /**
   * The answer-writing connection, used by `save_application_answer` and by nothing else. Null unless writer:write is
   * effective and the application writer is on.
   */
  writeDb: Db | null;
}

/** Everything a tool reads besides its arguments; the server passes the real loaders, tests their own. */
export interface McpContext {
  /** A read-only connection (`createReadOnlyDb`). */
  db: Db;
  settings: McpConfig;
  /** mcp.yaml as it is on disk now, read again for every call (throws when it cannot be read). */
  readSettings: () => McpConfig;
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
  /** Parsed query using the installation's current matching and ranking settings. */
  searchPlan: (query: string) => SearchPlan;
  text: McpTranslator;
  log: LogLine;
  /** Absent: the writer tools are not offered. */
  writer?: McpWriterAccess;
  /** Absent readers close the corresponding feature gates. */
  features?: { careerEnabled: () => boolean; repliesEnabled: () => boolean };
  /**
   * The caller's effective permissions for this call, from the authorization decision (the server sets it; never read settings a
   * second time). Absent: no field block is given.
   */
  permissions?: ReadonlySet<Permission>;
  audit?: AuditRecorder;
  caller?: { caller: "stdio" | "token"; tokenId: number | null; transport: "stdio" | "http" };
  /** The permissions this connection was granted; absent = the local stdio process. */
  grant?: Grant;
  /** Re-reads a token grant before each call; a token grant without it is refused. */
  readGrant?: GrantReader;
  auditCall?: { success: (count: number) => AuditEntry; committed: boolean };
  /**
   * Runs one tool call. The HTTP route keeps the request's concurrency slot until every call it runs has settled, even
   * after the client disconnects. Absent (stdio): the call just runs.
   */
  track?: <T>(call: () => Promise<T>) => Promise<T>;
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

const hasCode = (value: unknown): boolean => typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";

/**
 * The category of an unexpected error: never its message, which may hold an address, a path or a query. A Postgres error (an SQLSTATE
 * or a connection error such as ECONNREFUSED) carries a string `code`; the query builder wraps it and keeps it as `cause`.
 */
export function errorCategory(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if (hasCode(current)) return "database";
    current = "cause" in current ? current.cause : undefined;
  }
  return "internal";
}

export function auditFailure(error: unknown): AuditOutcome {
  const category = error instanceof ToolFailure ? error.category : errorCategory(error);
  return category === "not_permitted" && error instanceof ToolFailure
    ? { outcome: "not_permitted", error_category: null }
    : { outcome: "error", error_category: category };
}

export function auditEntry(ctx: Pick<McpContext, "caller">, capability: string, target: AuditTarget | null, outcome: AuditOutcome, count: number, durationMs: number): AuditEntry {
  return {
    caller: ctx.caller?.caller ?? "stdio",
    token_id: ctx.caller?.tokenId ?? null,
    transport: ctx.caller?.transport ?? "stdio",
    capability,
    target,
    ...outcome,
    returned_count: count,
    duration_ms: Math.max(0, Math.round(durationMs)),
  };
}

/**
 * Logs and audits one call without its arguments or result. An answer's committed transaction already holds its success row.
 * A `ToolFailure` keeps its message; unexpected failures are reported by category only.
 */
export async function runLogged<R>(ctx: McpContext, tool: string, call: (ctx: McpContext) => Promise<{ result: R; count: number }>, target: AuditTarget | null = null): Promise<R | ErrorResult> {
  const started = performance.now();
  const finish = ctx.audit?.beginCall?.();
  const auditCall = {
    success: (count: number) => auditEntry(ctx, tool, target, { outcome: "ok", error_category: null }, count, performance.now() - started),
    committed: false,
  };
  try {
    const { result, count } = await call({ ...ctx, auditCall });
    ctx.log(formatCallLine({ tool, ok: true, count, ms: performance.now() - started }));
    if (!auditCall.committed) await ctx.audit?.record(auditCall.success(count));
    return result;
  } catch (error) {
    const category = error instanceof ToolFailure ? error.category : errorCategory(error);
    ctx.log(formatCallLine({ tool, ok: false, count: 0, ms: performance.now() - started, category }));
    if (!auditCall.committed) await ctx.audit?.record(auditEntry(ctx, tool, target, auditFailure(error), 0, performance.now() - started));
    return errorResult(error instanceof ToolFailure ? error.message : ctx.text("errors.failed", { category }));
  } finally {
    finish?.();
  }
}
