/**
 * What the agent activity page shows: the filters read from the URL, the rows of `agent_calls` turned into a view model that holds
 * only what the audit stores (never arguments or content), and the registry through which an undo feature reports whether a row can
 * be undone. Server only. Nothing is registered by default, so every row's `undo` is null.
 */
import { z } from "zod";

import { CAPABILITIES } from "@/lib/capabilities/registry";
import { loadConfig } from "@/lib/config";
import { AGENT_ACTIVITY_DEFAULTS, AGENT_ACTIVITY_RANGES, type AgentActivityRange } from "@/lib/config/schemas/ui";
import { getDb } from "@/lib/db";
import {
  AGENT_CALL_OUTCOMES,
  agentCallConnections,
  listAgentCalls,
  summarizeAgentCalls,
  type AgentCallCursor,
  type AgentCallFilter,
  type AgentCallListRow,
} from "@/lib/db/repos/agent-calls";
import { dayInZone, startOfDayInZone } from "@/lib/insights/range";

import { liveMcpSettings } from "./authorize";

const DAY_MS = 24 * 60 * 60 * 1000;

const cursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z~\d{1,15}$/)
  .refine((value) => Number.isFinite(Date.parse(value.slice(0, 19) + "Z")) && new Date(value.slice(0, 19) + "Z").toISOString().startsWith(value.slice(0, 19)));

/** The URL query of the page; a value that does not parse is ignored, so a hand-edited link still opens. */
export const agentActivityQuerySchema = z.object({
  connection: z.union([z.literal("stdio"), z.string().regex(/^\d{1,9}$/).transform(Number)]).optional().catch(undefined),
  tool: z.string().regex(/^[a-z0-9_.-]{1,100}$/).optional().catch(undefined),
  result: z.enum(AGENT_CALL_OUTCOMES).optional().catch(undefined),
  range: z.enum(AGENT_ACTIVITY_RANGES).optional().catch(undefined),
  before: cursorSchema.optional().catch(undefined),
});
export type AgentActivityQuery = z.infer<typeof agentActivityQuerySchema>;
export type AgentActivitySearchParams = Record<string, string | string[] | undefined>;

export function parseAgentActivityQuery(params: AgentActivitySearchParams): AgentActivityQuery {
  const first = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  return agentActivityQuerySchema.parse(first);
}

function parseCursor(value: string | undefined): AgentCallCursor | undefined {
  if (value === undefined) return undefined;
  const [at, id] = value.split("~");
  return at === undefined || id === undefined ? undefined : { at, id: Number(id) };
}

export function cursorOf(row: { cursorAt: string; id: number }): string {
  return `${row.cursorAt}~${row.id}`;
}

/** The earliest instant a range covers; today counts from local midnight in the schedule time zone. */
export function rangeStart(range: AgentActivityRange, now: Date, timeZone: string): Date | undefined {
  if (range === "all") return undefined;
  if (range === "today") return startOfDayInZone(dayInZone(now, timeZone), timeZone);
  return new Date(now.getTime() - (range === "7d" ? 7 : 30) * DAY_MS);
}

export type UndoState = "undoable" | "undone" | "not_undoable";
export type UndoLoader = (callIds: readonly number[]) => Promise<ReadonlyMap<number, UndoState>>;

let undoLoader: UndoLoader | null = null;

/** The one entry through which an undo feature fills the last column; none is registered here. */
export function registerUndoLoader(loader: UndoLoader | null): void {
  undoLoader = loader;
}

export const agentActivityRowSchema = z.strictObject({
  id: z.number().int(),
  calledAt: z.string(),
  connection: z.strictObject({ kind: z.enum(["stdio", "token"]), tokenId: z.number().int().nullable(), name: z.string().nullable(), revoked: z.boolean() }),
  tool: z.string(),
  toolKind: z.enum(["read", "write", "trigger"]).nullable(),
  target: z.strictObject({ type: z.enum(["job", "application", "question"]), id: z.number().int(), jobId: z.number().int().nullable(), title: z.string().nullable(), company: z.string().nullable() }).nullable(),
  outcome: z.string(),
  errorCategory: z.string().nullable(),
  returnedCount: z.number().int(),
  durationMs: z.number().int(),
  undo: z.strictObject({ state: z.enum(["undoable", "undone", "not_undoable"]) }).nullable(),
});
export type AgentActivityRow = z.infer<typeof agentActivityRowSchema>;

export function toActivityRow(row: AgentCallListRow, undo: UndoState | undefined, kinds: ReadonlyMap<string, AgentActivityRow["toolKind"]> = TOOL_KINDS): AgentActivityRow {
  return agentActivityRowSchema.parse({
    id: row.id,
    calledAt: row.calledAt.toISOString(),
    connection: { kind: row.caller === "stdio" ? "stdio" : "token", tokenId: row.tokenId, name: row.tokenName, revoked: row.tokenRevoked },
    tool: row.capability,
    toolKind: kinds.get(row.capability) ?? null,
    target: row.targetType === null || row.targetId === null ? null : { type: row.targetType, id: row.targetId, jobId: row.jobId, title: row.jobTitle, company: row.company },
    outcome: row.outcome,
    errorCategory: row.errorCategory,
    returnedCount: row.returnedCount,
    durationMs: row.durationMs,
    undo: undo === undefined ? null : { state: undo },
  });
}

const TOOL_KINDS: ReadonlyMap<string, AgentActivityRow["toolKind"]> = new Map(CAPABILITIES.map((capability) => [capability.id, capability.kind]));

export interface AgentActivityData {
  query: AgentActivityQuery;
  range: AgentActivityRange;
  pageSize: number;
  retentionDays: number | null;
  connections: { id: number; name: string; revoked: boolean }[];
  tools: { id: string; permission: string }[];
  outcomes: readonly string[];
  rows: AgentActivityRow[];
  nextBefore: string | null;
  summary: { total: number; byOutcome: Record<string, number> };
  anyCalls: boolean;
  timeZone: string;
}

function retentionDays(): number | null {
  try {
    return liveMcpSettings().audit.retention_days;
  } catch {
    return null;
  }
}

/** Reads the filtered page, the summary and the connection list; throws when the database cannot be read (the page shows a banner). */
export async function loadAgentActivity(params: AgentActivitySearchParams, now: Date = new Date()): Promise<AgentActivityData> {
  const query = parseAgentActivityQuery(params);
  const ui = (() => {
    try {
      return loadConfig("ui").agent_activity;
    } catch {
      return AGENT_ACTIVITY_DEFAULTS;
    }
  })();
  const timeZone = (() => {
    try {
      return loadConfig("schedule").timezone;
    } catch {
      return "UTC";
    }
  })();
  const range = query.range ?? ui.default_range;
  const filter: AgentCallFilter = { connection: query.connection, capability: query.tool, outcome: query.result, since: rangeStart(range, now, timeZone) };
  const db = getDb();
  const [page, byOutcome, connections, anyPage] = await Promise.all([
    listAgentCalls(db, { filter, limit: ui.page_size, after: parseCursor(query.before) }),
    summarizeAgentCalls(db, filter),
    agentCallConnections(db),
    listAgentCalls(db, { filter: {}, limit: 1 }),
  ]);
  const states = undoLoader === null || page.rows.length === 0 ? new Map<number, UndoState>() : await undoLoader(page.rows.map((row) => row.id));
  const last = page.rows.at(-1);
  return {
    query,
    range,
    pageSize: ui.page_size,
    retentionDays: retentionDays(),
    connections,
    outcomes: AGENT_CALL_OUTCOMES,
    tools: CAPABILITIES.map((capability) => ({ id: capability.id, permission: capability.permission })),
    rows: page.rows.map((row) => toActivityRow(row, states.get(row.id))),
    nextBefore: page.hasMore && last ? cursorOf(last) : null,
    summary: { total: Object.values(byOutcome).reduce((sum, n) => sum + n, 0), byOutcome },
    anyCalls: anyPage.rows.length > 0,
    timeZone,
  };
}

/** The page URL for a query: only what differs from the defaults is written. */
export function activityHref(query: AgentActivityQuery, patch: Partial<AgentActivityQuery> = {}): string {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.connection !== undefined) params.set("connection", String(next.connection));
  if (next.tool !== undefined) params.set("tool", next.tool);
  if (next.result !== undefined) params.set("result", next.result);
  if (next.range !== undefined) params.set("range", next.range);
  if (next.before !== undefined) params.set("before", next.before);
  return `/settings/agents/activity${params.size ? `?${params}` : ""}`;
}
