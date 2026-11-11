import type { Executor } from "@/lib/db/executor";
import { insertAgentCall, type AgentCallRow } from "@/lib/db/repos/agent-calls";
import type { LogLine } from "@/lib/mcp/call-log";
import { errorCategory } from "@/lib/mcp/context";
import type { McpTranslator } from "@/lib/mcp/text";

export type AuditTarget = { type: "job" | "application" | "question"; id: number };
export type AuditOutcome = { outcome: "ok" | "not_permitted" | "invalid_input"; error_category: null } | { outcome: "error"; error_category: string };
export type AuditEntry = AuditOutcome & {
  caller: string;
  token_id: number | null;
  transport: string;
  capability: string;
  target: AuditTarget | null;
  returned_count: number;
  duration_ms: number;
};

export interface AuditRecorder {
  beginCall?(): () => void;
  record(entry: AuditEntry): Promise<void>;
  inTransaction(tx: Executor, entry: AuditEntry): Promise<void>;
  close(): Promise<void>;
}

function rowOf(entry: AuditEntry): AgentCallRow {
  return {
    caller: entry.caller,
    tokenId: entry.token_id,
    transport: entry.transport,
    capability: entry.capability,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    outcome: entry.outcome,
    errorCategory: entry.error_category,
    returnedCount: entry.returned_count,
    durationMs: entry.duration_ms,
  };
}

/** Reads tolerate audit failure; a write transaction must persist its audit row before it can commit. */
export function createAuditRecorder(connection: { db: Executor; close: () => Promise<void> }, options: { log: LogLine; text: McpTranslator }): AuditRecorder {
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  return {
    beginCall() {
      const { promise, resolve } = Promise.withResolvers<void>();
      pending.add(promise);
      return () => { pending.delete(promise); resolve(); };
    },
    record(entry) {
      const write = Promise.resolve().then(() => insertAgentCall(connection.db, rowOf(entry))).catch((error: unknown) => {
        try { options.log(options.text("serve.auditFailed", { category: errorCategory(error) })); } catch {}
      });
      pending.add(write);
      void write.then(() => pending.delete(write));
      return write;
    },
    inTransaction: (tx, entry) => insertAgentCall(tx, rowOf(entry)),
    close() {
      closing ??= (async () => {
        while (pending.size > 0) await Promise.all(pending);
        await connection.close();
      })();
      return closing;
    },
  };
}
