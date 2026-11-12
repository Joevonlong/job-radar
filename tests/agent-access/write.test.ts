// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditEntry, AuditRecorder } from "@/lib/agent-access/audit";
import { AgentWriteError, undoChange, valueFingerprint, writeWithUndo, type AgentWriteAccess, type UndoKind } from "@/lib/agent-access/write";
import type { Executor } from "@/lib/db/executor";
import { getAgentUndo, markAgentUndoDone, storeAgentUndo } from "@/lib/db/repos/agent-undo";
import type { AgentUndo } from "@/lib/db/repos/agent-undo";

vi.mock("@/lib/db/repos/agent-undo", () => ({ getAgentUndo: vi.fn(), markAgentUndoDone: vi.fn(), storeAgentUndo: vi.fn() }));
const tx = {} as Executor;
const db = { transaction: async (callback: (tx: Executor) => Promise<unknown>) => callback(tx) } as Executor;
const target = { type: "job", id: 9 } as const;
const entry: AuditEntry = { caller: "stdio", token_id: null, transport: "stdio", capability: "set_next_action", target, outcome: "ok", error_category: null, returned_count: 1, duration_ms: 0 };
const audit: AuditRecorder = { record: vi.fn(async () => undefined), inTransaction: vi.fn(async () => 31), close: vi.fn(async () => undefined) };
const access: AgentWriteAccess = { caller: "stdio", permissions: new Set(["tracking:write"]), audit, entry: () => entry };
let value: unknown;
const kind: UndoKind = {
  area: "tracking", field: "test_field",
  read: vi.fn(async () => ({ value, fingerprint: valueFingerprint(value) })),
  restore: vi.fn(async (_tx, _target, before) => { value = before; }),
};
const registry = new Map([["test_kind", kind]]);
const saved = (): AgentUndo => ({ auditId: 31, dataArea: "tracking", kind: "test_kind", targetType: "job", targetId: 9, beforeValue: "PRIVATE-NOTES-LIKE-SENTINEL", afterFingerprint: valueFingerprint("after"), undoneAt: null, caller: "stdio" });

beforeEach(() => {
  vi.clearAllMocks();
  value = "after";
  vi.mocked(getAgentUndo).mockResolvedValue(saved());
  vi.mocked(markAgentUndoDone).mockResolvedValue(true);
  vi.mocked(audit.inTransaction).mockResolvedValue(32);
});

describe("audited writes", () => {
  it("captures values around a write and links its undo to the transaction's returned audit id", async () => {
    value = "before";
    const result = await writeWithUndo(db, { access, registry, kind: "test_kind", target }, async (executor) => {
      expect(executor).toBe(tx); value = "after"; return "result";
    });
    expect(result).toEqual({ result: "result", auditId: 32, undoable: true });
    expect(storeAgentUndo).toHaveBeenCalledExactlyOnceWith(tx, { ...saved(), auditId: 32, beforeValue: "before", undoneAt: undefined });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("audits a no-op without making it undoable", async () => {
    const result = await writeWithUndo(db, { access, registry, kind: "test_kind", target }, async () => undefined);
    expect(result.undoable).toBe(false);
    expect(audit.inTransaction).toHaveBeenCalledTimes(1);
    expect(storeAgentUndo).not.toHaveBeenCalled();
  });

  it("checks write permission before reading or writing", async () => {
    const write = vi.fn();
    await expect(writeWithUndo(db, { access: { ...access, permissions: new Set() }, registry, kind: "test_kind", target }, write)).rejects.toMatchObject({ code: "not_permitted" });
    expect(kind.read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["audit", "undo"])("propagates a failed %s insert to the transaction", async (failure) => {
    const error = new Error("insert refused");
    if (failure === "audit") vi.mocked(audit.inTransaction).mockRejectedValueOnce(error);
    else vi.mocked(storeAgentUndo).mockRejectedValueOnce(error);
    await expect(writeWithUndo(db, { access, registry, kind: "test_kind", target }, async () => { value = "changed"; })).rejects.toBe(error);
  });
});

describe("generic undo", () => {
  it("restores through the registered service and returns only field metadata, even for private text", async () => {
    const result = await undoChange(db, access, 31, registry);
    expect(value).toBe("PRIVATE-NOTES-LIKE-SENTINEL");
    expect(kind.restore).toHaveBeenCalledWith(tx, target, value, "stdio");
    expect(result).toEqual({ auditId: 32, field: "test_field", target, research: null });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-NOTES-LIKE-SENTINEL");
    expect(markAgentUndoDone).toHaveBeenCalledWith(tx, 31);
    expect(audit.inTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({ target }));
    expect(storeAgentUndo).not.toHaveBeenCalled();
  });

  it("refuses a changed current value and preserves the owner's edit", async () => {
    value = "owner edited";
    await expect(undoChange(db, access, 31, registry)).rejects.toMatchObject({ code: "conflict" });
    expect(value).toBe("owner edited");
    expect(kind.restore).not.toHaveBeenCalled();
    expect(markAgentUndoDone).not.toHaveBeenCalled();
  });

  it.each([
    ["already_undone", { undoneAt: new Date() }],
    ["not_permitted", { caller: "token:5" }],
    ["not_permitted", { dataArea: "notes" }],
    ["not_undoable", { kind: "missing" }],
  ] as const)("refuses %s before restoring", async (code, override) => {
    vi.mocked(getAgentUndo).mockResolvedValue({ ...saved(), ...override });
    await expect(undoChange(db, access, 31, registry)).rejects.toMatchObject({ code });
    expect(kind.restore).not.toHaveBeenCalled();
  });

  it("refuses an undo's audit id, which has no undo row", async () => {
    vi.mocked(getAgentUndo).mockResolvedValue(null);
    await expect(undoChange(db, access, 32, registry)).rejects.toEqual(new AgentWriteError("not_undoable"));
  });

  it("checks the original data area rather than accepting an unrelated write grant", async () => {
    await expect(undoChange(db, { ...access, permissions: new Set(["notes:write"]) }, 31, registry)).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("propagates a lost atomic undo claim so the restoration rolls back", async () => {
    vi.mocked(markAgentUndoDone).mockResolvedValue(false);
    await expect(undoChange(db, access, 31, registry)).rejects.toMatchObject({ code: "already_undone" });
    expect(audit.inTransaction).not.toHaveBeenCalled();
  });

  it("fingerprints objects independently of property order, including date values", () => {
    expect(valueFingerprint({ a: 1, nested: { z: new Date("2026-01-01Z"), b: 2 } })).toBe(valueFingerprint({ nested: { b: 2, z: "2026-01-01T00:00:00.000Z" }, a: 1 }));
    expect(valueFingerprint([1, 2])).not.toBe(valueFingerprint([2, 1]));
  });
});
