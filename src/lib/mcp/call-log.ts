/**
 * One stderr line per tool call: the tool, how many items it returned, how long it took and whether it worked. Never the arguments
 * or the result (they may hold search terms and job data); the MCP client shows the line in its log of this server.
 */
export type LogLine = (line: string) => void;

export interface CallRecord {
  tool: string;
  ok: boolean;
  /** Items returned (jobs, applications; 1 for one job); 0 on failure. */
  count: number;
  ms: number;
  /** Failure category (`invalid_input`, `not_found`, `database`, ...), never a message. */
  category?: string;
}

export function formatCallLine(record: CallRecord): string {
  const status = record.ok ? "ok" : `fail ${record.category ?? "error"}`;
  return `[mcp] ${record.tool} ${status} items=${record.count} ms=${Math.round(record.ms)}`;
}

/** Writes to stderr only: stdout belongs to the protocol. */
export const stderrLine: LogLine = (line) => {
  process.stderr.write(`${line}\n`);
};
