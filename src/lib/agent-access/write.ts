import { createHash } from "node:crypto";

import type { Executor } from "@/lib/db/executor";
import { getAgentUndo, markAgentUndoDone, storeAgentUndo } from "@/lib/db/repos/agent-undo";
import type { AutoResearchOutcome } from "@/lib/research/auto";

import type { AuditEntry, AuditRecorder, AuditTarget } from "./audit";
import { callerKey, type AgentCaller } from "./caller";
import { permissionSchema, type DATA_AREAS, type Permission } from "./permissions";

export interface UndoSnapshot {
  value: unknown;
  fingerprint: string;
}
export type WriteEffects = { research?: AutoResearchOutcome | null };

/** A reader holds the target's row lock through restoration; restore uses the same service as a normal write. */
export interface UndoKind {
  area: (typeof DATA_AREAS)[number];
  field: string;
  read(tx: Executor, target: AuditTarget): Promise<UndoSnapshot>;
  restore(tx: Executor, target: AuditTarget, value: unknown, caller: AgentCaller): Promise<WriteEffects | void>;
}
export type UndoRegistry = ReadonlyMap<string, UndoKind>;
export interface AgentWriteAccess {
  caller: AgentCaller;
  permissions: ReadonlySet<Permission>;
  audit: AuditRecorder;
  entry(count: number): AuditEntry;
}

export class AgentWriteError extends Error {
  constructor(readonly code: "not_permitted" | "not_undoable" | "already_undone" | "conflict") {
    super(code);
    this.name = "AgentWriteError";
  }
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function valueFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function requireWrite(access: AgentWriteAccess, area: string): void {
  const permission = permissionSchema.safeParse(`${area}:write`);
  if (!permission.success || !access.permissions.has(permission.data)) throw new AgentWriteError("not_permitted");
}

/** A no-op is audited but has nothing to undo. Business data, audit and restoration data commit together. */
export async function writeWithUndo<R>(db: Executor, input: {
  access: AgentWriteAccess; registry: UndoRegistry; kind: string; target: AuditTarget;
}, write: (tx: Executor) => Promise<R>): Promise<{ result: R; auditId: number; undoable: boolean }> {
  const kind = input.registry.get(input.kind);
  if (!kind) throw new AgentWriteError("not_undoable");
  requireWrite(input.access, kind.area);
  return db.transaction(async (tx) => {
    const before = await kind.read(tx, input.target);
    const result = await write(tx);
    const after = await kind.read(tx, input.target);
    const auditId = await input.access.audit.inTransaction(tx, { ...input.access.entry(1), target: input.target });
    const undoable = before.fingerprint !== after.fingerprint;
    if (undoable) await storeAgentUndo(tx, {
      auditId, dataArea: kind.area, kind: input.kind, targetType: input.target.type, targetId: input.target.id,
      beforeValue: before.value, afterFingerprint: after.fingerprint, caller: callerKey(input.access.caller),
    });
    return { result, auditId, undoable };
  });
}

/** Restoration never returns before-values, creates another undo record, or rewrites history. */
export async function undoChange(db: Executor, access: AgentWriteAccess, auditId: number, registry: UndoRegistry): Promise<{
  auditId: number; field: string; target: AuditTarget; research: AutoResearchOutcome | null;
}> {
  return db.transaction(async (tx) => {
    const saved = await getAgentUndo(tx, auditId);
    if (!saved) throw new AgentWriteError("not_undoable");
    if (saved.caller !== callerKey(access.caller)) throw new AgentWriteError("not_permitted");
    requireWrite(access, saved.dataArea);
    if (saved.undoneAt) throw new AgentWriteError("already_undone");
    const kind = registry.get(saved.kind);
    if (!kind || kind.area !== saved.dataArea) throw new AgentWriteError("not_undoable");
    const target = { type: saved.targetType, id: saved.targetId };
    const current = await kind.read(tx, target);
    if (current.fingerprint !== saved.afterFingerprint) throw new AgentWriteError("conflict");
    const effects = await kind.restore(tx, target, saved.beforeValue, access.caller);
    if (!(await markAgentUndoDone(tx, auditId))) throw new AgentWriteError("already_undone");
    const undoAuditId = await access.audit.inTransaction(tx, { ...access.entry(1), target });
    return { auditId: undoAuditId, field: kind.field, target, research: effects?.research ?? null };
  });
}
