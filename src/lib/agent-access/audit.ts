import type { Executor } from "@/lib/db/executor";
import { insertAgentCall, type AgentCallRow } from "@/lib/db/repos/agent-calls";
import type { LogLine } from "@/lib/mcp/call-log";
import { errorCategory } from "@/lib/mcp/context";
import type { McpTranslator } from "@/lib/mcp/text";
import { TimeoutError, withTimeout } from "@/lib/ops/timeout";

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
  inTransaction(tx: Executor, entry: AuditEntry): Promise<number>;
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

/** The dedicated audit session; `end({ timeout: 0 })` destroys it at once, cutting off a query that is still waiting. */
export interface AuditConnection {
  db: Executor;
  end(options: { timeout: number }): Promise<void>;
}

class AuditClosedError extends Error {
  constructor() {
    super("audit recorder closed");
    this.name = "AuditClosedError";
  }
}

/**
 * Reads tolerate audit failure; a write transaction must persist its audit row before it can commit. Rows outside a
 * transaction go one at a time over a connection opened on first use. Each row has a client deadline (`writeTimeoutMs`)
 * from the moment it is recorded, covering its wait in line and the database's reply. When it passes, the call goes on with
 * one stderr line (`timeout`), the connection is destroyed and the next row opens a new one; the row is never retried,
 * because its insert may already have committed. `close()` waits for running calls and their rows up to the same deadline,
 * then destroys the connection; later rows are not written.
 */
export function createAuditRecorder(open: () => AuditConnection, options: { log: LogLine; text: McpTranslator; writeTimeoutMs: number }): AuditRecorder {
  const pending = new Set<Promise<void>>();
  let connection: AuditConnection | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let closed = false;
  const report = (category: string) => {
    try { options.log(options.text("serve.auditFailed", { category })); } catch {}
  };
  const destroy = (stale: AuditConnection | undefined) => {
    if (!stale) return;
    if (connection === stale) connection = undefined;
    void stale.end({ timeout: 0 }).catch(() => undefined);
  };
  const track = (promise: Promise<void>) => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise));
  };
  return {
    beginCall() {
      const { promise, resolve } = Promise.withResolvers<void>();
      pending.add(promise);
      return () => { pending.delete(promise); resolve(); };
    },
    record(entry) {
      let expired = false;
      let used: AuditConnection | undefined;
      const turn = tail.then(async () => {
        if (expired) return;
        if (closed) throw new AuditClosedError();
        used = connection ??= open();
        await insertAgentCall(used.db, rowOf(entry));
      });
      const write = withTimeout(turn, options.writeTimeoutMs, "audit row").catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          expired = true;
          destroy(used);
        }
        report(error instanceof TimeoutError ? "timeout" : error instanceof AuditClosedError ? "closed" : errorCategory(error));
      });
      tail = write;
      track(write);
      return write;
    },
    inTransaction: (tx, entry) => insertAgentCall(tx, rowOf(entry)),
    close() {
      closing ??= (async () => {
        const drained = (async () => {
          while (pending.size > 0) await Promise.all(pending);
        })();
        await withTimeout(drained, options.writeTimeoutMs, "audit drain").catch(() => undefined);
        closed = true;
        const last = connection;
        connection = undefined;
        await last?.end({ timeout: 0 }).catch(() => undefined);
      })();
      return closing;
    },
  };
}
