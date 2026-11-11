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

function fixture() {
  const close = vi.fn(async () => undefined);
  const log = vi.fn();
  return { close, log, recorder: createAuditRecorder({ db, close }, { log, text: mcpTranslator("en") }) };
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
    expect(log).toHaveBeenCalledExactlyOnceWith(mcpTranslator("en")("serve.auditFailed", { category: "database" }));
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
    const { recorder, close } = fixture();
    const gate = Promise.withResolvers<void>();
    vi.mocked(insertAgentCall).mockReturnValueOnce(gate.promise);
    void recorder.record(entry);
    const closing = recorder.close();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    if (fails) gate.reject(new Error("private"));
    else gate.resolve();
    await closing;
    await recorder.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("waits for a running call to produce its audit before closing (call failure %s)", async (fails) => {
    const { recorder, close, log } = fixture();
    const gate = Promise.withResolvers<void>();
    const ctx = defaultContext({} as Db, mcpSchema.parse({}), { audit: recorder, log: () => undefined, text: mcpTranslator("en") });
    vi.mocked(insertAgentCall).mockImplementation(async () => { expect(close).not.toHaveBeenCalled(); });
    const call = runLogged(ctx, "get_job", async () => {
      await gate.promise;
      if (fails) throw new Error("private");
      return { result: "read", count: 1 };
    });
    const closing = recorder.close();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([call, closing]);
    expect(insertAgentCall).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});
