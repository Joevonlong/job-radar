// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuditRecorder, type AuditEntry } from "@/lib/agent-access/audit";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { insertAgentCall } from "@/lib/db/repos/agent-calls";
import { mcpTranslator } from "@/lib/mcp/text";
import { runLogged } from "@/lib/mcp/context";
import { defaultContext } from "@/lib/mcp/server";

vi.mock("@/lib/db/repos/agent-calls", () => ({ insertAgentCall: vi.fn(async () => undefined) }));
afterEach(() => vi.resetAllMocks());

const entry: AuditEntry = {
  caller: "stdio", token_id: null, transport: "stdio", capability: "get_job", target: { type: "job", id: 42 },
  outcome: "ok", error_category: null, returned_count: 1, duration_ms: 7,
};
const db = {} as Executor;
const WRITE_TIMEOUT_MS = 1000;
const text = mcpTranslator("en");

function fixture() {
  const opened: Array<{ db: Executor; end: ReturnType<typeof vi.fn<(options: { timeout: number }) => Promise<void>>> }> = [];
  const open = vi.fn(() => {
    const connection = { db: opened.length === 0 ? db : ({ connection: opened.length } as unknown as Executor), end: vi.fn<(options: { timeout: number }) => Promise<void>>(async () => undefined) };
    opened.push(connection);
    return connection;
  });
  const log = vi.fn();
  return { open, opened, log, recorder: createAuditRecorder(open, { log, text, writeTimeoutMs: WRITE_TIMEOUT_MS }) };
}

describe("audit recorder", () => {
  it("inserts only explicit metadata fields, even if the entry carries extra data", async () => {
    const { recorder } = fixture();
    await recorder.record({ ...entry, arguments: "SENTINEL-ARG-private", result: "SENTINEL-OUT-private" } as AuditEntry);
    expect(insertAgentCall).toHaveBeenCalledExactlyOnceWith(db, {
      caller: "stdio", tokenId: null, transport: "stdio", capability: "get_job", targetType: "job", targetId: 42,
      outcome: "ok", errorCategory: null, returnedCount: 1, durationMs: 7,
    });
    await recorder.close();
  });

  it("never throws on a failing insert and logs one line with the category only", async () => {
    const { recorder, log } = fixture();
    vi.mocked(insertAgentCall).mockRejectedValueOnce(Object.assign(new Error("SENTINEL-ARG-private"), { code: "08006" }));
    await expect(recorder.record(entry)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith(text("serve.auditFailed", { category: "database" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SENTINEL");
    await recorder.close();
  });

  it("contains a throwing logger too", async () => {
    const { recorder, log } = fixture();
    vi.mocked(insertAgentCall).mockRejectedValueOnce(new Error("private"));
    log.mockImplementation(() => { throw new Error("stderr closed"); });
    await expect(recorder.record(entry)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    await recorder.close();
  });

  it("throws in a transaction so the caller can roll back, without logging a second failure", async () => {
    const { recorder, log } = fixture();
    const tx = {} as Executor;
    const error = new Error("private insert failure");
    vi.mocked(insertAgentCall).mockRejectedValueOnce(error);
    await expect(recorder.inTransaction(tx, entry)).rejects.toBe(error);
    expect(insertAgentCall).toHaveBeenCalledWith(tx, expect.objectContaining({ targetId: 42 }));
    expect(log).not.toHaveBeenCalled();
    await recorder.close();
  });

  it.each([false, true])("drains pending fire-and-forget inserts before closing exactly once (failure %s)", async (fails) => {
    const { recorder, opened } = fixture();
    const gate = Promise.withResolvers<void>();
    vi.mocked(insertAgentCall).mockReturnValueOnce(gate.promise);
    void recorder.record(entry);
    const closing = recorder.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.end).not.toHaveBeenCalled();
    if (fails) gate.reject(new Error("private"));
    else gate.resolve();
    await closing;
    await recorder.close();
    expect(opened[0]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
  });

  it("opens no connection until a row is written and closes cleanly without one", async () => {
    const { recorder, open } = fixture();
    await recorder.close();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([false, true])("waits for a running call to produce its audit before closing (call failure %s)", async (fails) => {
    const { recorder, opened, log } = fixture();
    const gate = Promise.withResolvers<void>();
    const ctx = defaultContext({} as Db, mcpSchema.parse({}), { audit: recorder, log: () => undefined, text });
    vi.mocked(insertAgentCall).mockImplementation(async () => { expect(opened[0]!.end).not.toHaveBeenCalled(); });
    const call = runLogged(ctx, "get_job", async () => {
      await gate.promise;
      if (fails) throw new Error("private");
      return { result: "read", count: 1 };
    });
    const closing = recorder.close();
    await Promise.resolve();
    expect(opened).toHaveLength(0);
    gate.resolve();
    await Promise.all([call, closing]);
    expect(insertAgentCall).toHaveBeenCalledTimes(1);
    expect(opened[0]!.end).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("audit recorder deadlines", () => {
  afterEach(() => vi.useRealTimers());
  const never = () => new Promise<void>(() => undefined);

  it("returns a read on time when its row stalls, logs one timeout line and destroys the stalled connection", async () => {
    vi.useFakeTimers();
    const { recorder, opened, log } = fixture();
    vi.mocked(insertAgentCall).mockImplementationOnce(never);
    const ctx = defaultContext({} as Db, mcpSchema.parse({}), { audit: recorder, log: () => undefined, text });
    let answered = false;
    const call = runLogged(ctx, "get_job", async () => ({ result: "read", count: 1 })).then((result) => { answered = true; return result; });
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(call).resolves.toBe("read");
    expect(log).toHaveBeenCalledExactlyOnceWith(text("serve.auditFailed", { category: "timeout" }));
    expect(opened[0]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
  });

  it("writes the next row once on a new connection and never repeats the stalled insert", async () => {
    vi.useFakeTimers();
    const { recorder, opened, log } = fixture();
    vi.mocked(insertAgentCall).mockImplementationOnce(never).mockResolvedValue(undefined);
    const stalled = recorder.record(entry);
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    await stalled;
    await recorder.record({ ...entry, target: { type: "job", id: 43 } });
    expect(opened).toHaveLength(2);
    expect(insertAgentCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(insertAgentCall).mock.calls.map(([executor, row]) => [executor, row.targetId])).toEqual([[opened[0]!.db, 42], [opened[1]!.db, 43]]);
    expect(opened[1]!.end).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("counts the wait in line against each row's deadline", async () => {
    vi.useFakeTimers();
    const { recorder, opened, log } = fixture();
    vi.mocked(insertAgentCall).mockImplementation(never);
    const first = recorder.record(entry);
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS / 2);
    let queuedDone = false;
    const queued = recorder.record({ ...entry, target: { type: "job", id: 43 } }).then(() => { queuedDone = true; });
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS / 2);
    await first;
    expect(opened).toHaveLength(2);
    expect(insertAgentCall).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS / 2 - 1);
    expect(queuedDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await queued;
    expect(opened[1]!.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(log.mock.calls).toEqual([[text("serve.auditFailed", { category: "timeout" })], [text("serve.auditFailed", { category: "timeout" })]]);
  });

  it("closes within the deadline when a call never ends and a row never answers, and writes nothing afterwards", async () => {
    vi.useFakeTimers();
    const { recorder, opened, log } = fixture();
    vi.mocked(insertAgentCall).mockImplementationOnce(never).mockResolvedValue(undefined);
    const ctx = defaultContext({} as Db, mcpSchema.parse({}), { audit: recorder, log: () => undefined, text });
    const hanging = runLogged(ctx, "get_job", () => new Promise<never>(() => undefined));
    void recorder.record(entry);
    let closed = false;
    const closing = recorder.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    await closing;
    expect(closed).toBe(true);
    expect(opened[0]!.end).toHaveBeenCalledWith({ timeout: 0 });
    void hanging;
    await recorder.record({ ...entry, target: { type: "job", id: 45 } });
    expect(insertAgentCall).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
    expect(log).toHaveBeenLastCalledWith(text("serve.auditFailed", { category: "closed" }));
  });
});
