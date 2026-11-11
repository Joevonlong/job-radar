// @vitest-environment node
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AuditRecorder } from "@/lib/agent-access/audit";
import { defineCapability, READ_ONLY } from "@/lib/capabilities/types";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { auditFailure, runLogged, ToolFailure } from "@/lib/mcp/context";
import { buildServer, defaultContext, observeInvalidInput } from "@/lib/mcp/server";
import { mcpTranslator } from "@/lib/mcp/text";

afterEach(() => vi.restoreAllMocks());
const tx = {} as Executor;

function fixture() {
  const audit = { record: vi.fn<AuditRecorder["record"]>(async () => undefined), inTransaction: vi.fn<AuditRecorder["inTransaction"]>(async () => 1), close: vi.fn(async () => undefined) };
  const settings = mcpSchema.parse({ enabled: true });
  const log = vi.fn();
  const ctx = defaultContext({} as Db, settings, { audit, log, text: mcpTranslator("en"), readSettings: () => settings });
  return { audit, ctx, log };
}

describe("call audit outcomes", () => {
  it.each(["not_found", "version_limit", "disabled", "settings_unreadable"])("keeps %s as an error category", (category) => {
    expect(auditFailure(new ToolFailure(category, "SENTINEL-message"))).toEqual({ outcome: "error", error_category: category });
  });
  it("separates permission denials and unexpected failures", () => {
    expect(auditFailure(new ToolFailure("not_permitted", "private"))).toEqual({ outcome: "not_permitted", error_category: null });
    expect(auditFailure(new Error("private"))).toEqual({ outcome: "error", error_category: "internal" });
    expect(auditFailure(new Error("private", { cause: { code: "25006" } }))).toEqual({ outcome: "error", error_category: "database" });
  });
});

describe("runLogged audit", () => {
  it("awaits success recording with caller, target, count and measured duration", async () => {
    const { ctx, audit, log } = fixture();
    ctx.caller = { caller: "stdio", transport: "stdio", tokenId: 12 };
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(107);
    const gate = Promise.withResolvers<void>();
    audit.record.mockReturnValueOnce(gate.promise);
    let returned = false;
    const call = runLogged(ctx, "get_job", async () => ({ result: "SENTINEL-OUT-private", count: 3 }), { type: "job", id: 42 }).then((result) => { returned = true; return result; });
    await vi.waitFor(() => expect(audit.record).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    expect(audit.record).toHaveBeenCalledWith({ caller: "stdio", token_id: 12, transport: "stdio", capability: "get_job", target: { type: "job", id: 42 }, outcome: "ok", error_category: null, returned_count: 3, duration_ms: 7 });
    gate.resolve();
    expect(await call).toBe("SENTINEL-OUT-private");
    expect(log).toHaveBeenCalledExactlyOnceWith("[mcp] get_job ok items=3 ms=7");
  });

  it.each([
    { error: new ToolFailure("not_permitted", "private"), outcome: "not_permitted", category: null },
    { error: new ToolFailure("not_found", "private"), outcome: "error", category: "not_found" },
    { error: Object.assign(new Error("private"), { code: "08006" }), outcome: "error", category: "database" },
    { error: new Error("private"), outcome: "error", category: "internal" },
  ])("records $outcome / $category once with the validated target", async ({ error, outcome, category }) => {
    const { ctx, audit } = fixture();
    const result = await runLogged(ctx, "get_job", async () => { throw error; }, { type: "job", id: 42 });
    expect(result).toMatchObject({ isError: true });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ caller: "stdio", token_id: null, transport: "stdio", capability: "get_job", target: { type: "job", id: 42 }, outcome, error_category: category, returned_count: 0, duration_ms: expect.any(Number) });
  });

  it("does not duplicate an audit row committed with a write", async () => {
    const { ctx, audit } = fixture();
    await runLogged(ctx, "save_application_answer", async (current) => {
      if (!current.auditCall) throw new Error("missing call");
      await current.audit?.inTransaction(tx, current.auditCall.success(1));
      current.auditCall.committed = true;
      return { result: "saved", count: 1 };
    }, { type: "question", id: 8 });
    expect(audit.inTransaction).toHaveBeenCalledExactlyOnceWith(tx, expect.objectContaining({ outcome: "ok", target: { type: "question", id: 8 } }));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("records an error after transaction audit failure and keeps simultaneous calls independent", async () => {
    const { ctx, audit } = fixture();
    audit.inTransaction.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "23514" }));
    await Promise.all([
      runLogged(ctx, "save_application_answer", async (current) => {
        if (!current.auditCall || !current.audit) throw new Error("missing call");
        await current.audit.inTransaction(tx, current.auditCall.success(1));
        current.auditCall.committed = true;
        return { result: "saved", count: 1 };
      }, { type: "question", id: 8 }),
      runLogged(ctx, "get_job", async () => ({ result: "read", count: 1 }), { type: "job", id: 42 }),
    ]);
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ capability: "save_application_answer", outcome: "error", error_category: "database" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ capability: "get_job", outcome: "ok" }));
  });
});

describe("SDK input observation", () => {
  it.each([false, true])("records rejected input without a target (async validation %s)", async (asynchronous) => {
    const { ctx, audit, log } = fixture();
    const schema = z.strictObject({ id: z.number() });
    const base = schema["~standard"];
    const observed = observeInvalidInput(asynchronous ? { "~standard": { ...base, validate: async () => ({ issues: [{ message: "SENTINEL-private" }] }) } } : schema, "get_job", log, ctx);
    await observed["~standard"].validate({ id: "SENTINEL-ARG-private" });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ capability: "get_job", target: null, outcome: "invalid_input", error_category: null, returned_count: 0, duration_ms: expect.any(Number) }));
  });

  it("audits calls through the SDK and leaves tools/list unaudited", async () => {
    const { ctx, audit } = fixture();
    const cap = defineCapability({
      id: "audit_probe", kind: "read", permission: "jobs:read", input: () => z.strictObject({ job_id: z.number() }),
      output: z.strictObject({ notices: z.array(z.string()) }), handler: async () => ({ notices: [] }), count: () => 1,
      target: (args) => ({ type: "job", id: args.job_id }), annotations: READ_ONLY, text: { title: "tools.get_job.title", description: "tools.get_job.description" },
    });
    const server = buildServer(ctx, { capabilities: [cap] });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();
      expect(audit.record).not.toHaveBeenCalled();
      await client.callTool({ name: cap.id, arguments: { job_id: "SENTINEL-ARG-private" } });
      await client.callTool({ name: cap.id, arguments: { job_id: 42 } });
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(audit.record.mock.calls.map(([entry]) => ({ outcome: entry.outcome, target: entry.target }))).toEqual([
        { outcome: "invalid_input", target: null }, { outcome: "ok", target: { type: "job", id: 42 } },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
