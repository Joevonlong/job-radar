// @vitest-environment node
import { Client, StreamableHTTPClientTransport, PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import type { AuthInfo, McpRequestContext } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mcpSchema } from "@/lib/config/schemas/mcp";
import { handleMcpHttpRequest, resetMcpThrottle, type McpHttpDependencies } from "@/lib/mcp/http";

import { fakeDeps, rpcRequest, SECRET, settings, snapshot } from "./http-helpers";

const clients: Client[] = [];
beforeEach(() => resetMcpThrottle());
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

describe("installed MCP SDK HTTP protocols", () => {
  it.each(["2025-06-18", "2026-07-28"])("builds a silent handler per request with isolated concurrent token contexts in %s", async (protocol) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deps = fakeDeps();
      const otherSecret = `jrat_${"b".repeat(43)}`;
      deps.verify.mockImplementation(async (_db, secret) => ({ ok: true, grant: {
        kind: "token", tokenId: secret === SECRET ? 42 : 43, permissions: [secret === SECRET ? "jobs:read" : "tracking:read"],
      } }));
      const passed = new Set<AuthInfo>();
      const contexts: McpRequestContext[] = [];
      const servers = new Set<object>();
      const bothEntered = Promise.withResolvers<void>();
      const createHandler = vi.fn<McpHttpDependencies["createHandler"]>((factory, options) => {
        const real = deps.createHandler((context) => {
          expect(passed.has(context.authInfo!)).toBe(true);
          contexts.push(context);
          const server = factory(context);
          servers.add(server);
          return server;
        }, options);
        return { ...real, fetch: async (request, input) => {
          passed.add(input!.authInfo!);
          if (passed.size === 2) bothEntered.resolve();
          await bothEntered.promise;
          return real.fetch(request, input);
        } };
      });
      const dependencies = { ...deps, createHandler };
      const modern = protocol === "2026-07-28";
      const request = (token: string) => rpcRequest({ token,
        headers: modern ? { "mcp-protocol-version": protocol, "mcp-method": "tools/list" } : { "mcp-protocol-version": protocol },
        body: JSON.stringify({ jsonrpc: "2.0", id: token === SECRET ? 1 : 2, method: "tools/list", params: modern ? {
          _meta: { [PROTOCOL_VERSION_META_KEY]: protocol, [CLIENT_INFO_META_KEY]: { name: "test", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} },
        } : {} }),
      });
      const results = await Promise.all([SECRET, otherSecret].map(async (token) => {
        const result = await snapshot(await handleMcpHttpRequest(request(token), dependencies));
        expect(result.status).toBe(200);
        const json = result.headers["content-type"]?.includes("text/event-stream")
          ? result.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : result.body;
        return JSON.parse(json).result.tools.map((tool: { name: string }) => tool.name) as string[];
      }));
      expect(results[0]).toContain("get_job");
      expect(results[0]).not.toContain("list_applications");
      expect(results[1]).toContain("list_applications");
      expect(results[1]).not.toContain("get_job");
      expect(createHandler).toHaveBeenCalledTimes(2);
      expect(createHandler.mock.results[0]!.value).not.toBe(createHandler.mock.results[1]!.value);
      expect(servers.size).toBe(2);
      expect(contexts[0]!.authInfo).not.toBe(contexts[1]!.authInfo);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("builds and closes every handler with the current request body limit without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deps = fakeDeps();
      const close = vi.fn();
      const createHandler = vi.fn<McpHttpDependencies["createHandler"]>((factory, options) => {
        const real = deps.createHandler(factory, options);
        return { ...real, close: async () => { close(); await real.close(); } };
      });
      const dependencies = { ...deps, createHandler };
      for (const max_body_bytes of [1024, 1024, 2048, 1024]) {
        deps.readSettings.mockReturnValue(settings({ max_body_bytes }));
        expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), dependencies))).status).toBe(200);
        expect(warn).not.toHaveBeenCalled();
      }
      expect(createHandler.mock.calls.map((call) => call[1]?.maxRequestBodySize)).toEqual([1024, 1024, 2048, 1024]);
      expect(close).toHaveBeenCalledTimes(4);
    } finally { warn.mockRestore(); }
  });

  it("drops only the SDK json-mode notice during construction and restores console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deps = fakeDeps();
      const createHandler = vi.fn<McpHttpDependencies["createHandler"]>((factory, options) => {
        console.warn("unrelated construction warning");
        return deps.createHandler(factory, options);
      });
      expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), { ...deps, createHandler }))).status).toBe(200);
      expect(createHandler.mock.calls[0]![1]).toMatchObject({ responseMode: "json" });
      expect(warn.mock.calls).toEqual([["unrelated construction warning"]]);
      expect(console.warn).toBe(warn);
      console.warn("after construction");
      expect(warn).toHaveBeenLastCalledWith("after construction");
    } finally { warn.mockRestore(); }
  });

  it("negotiates the modern protocol with the real client, lists only effective tools and answers a tool call with plain JSON", async () => {
    const deps = fakeDeps();
    const responses: Awaited<ReturnType<typeof snapshot>>[] = [];
    const transport = new StreamableHTTPClientTransport(new URL("http://mcp.example.test/api/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const response = await handleMcpHttpRequest(request, deps);
        const result = await snapshot(response);
        responses.push(result);
        return new Response(result.body, { status: result.status, headers: result.headers });
      },
    });
    const client = new Client({ name: "unit-http", version: "1" }, { versionNegotiation: { mode: "auto" } });
    clients.push(client);
    await client.connect(transport);
    expect(transport.protocolVersion).toBe("2026-07-28");
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("get_job");
    expect(tools).not.toContain("list_applications");
    await client.callTool({ name: "get_job", arguments: { job_id: 1 } });
    const call = responses.at(-1)!;
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body)).toMatchObject({ jsonrpc: "2.0", result: { content: expect.any(Array) } });
    expect(responses.every((response) => response.headers["content-type"]?.includes("application/json"))).toBe(true);
    expect(JSON.stringify(responses)).not.toContain(SECRET);
  });

  it("refuses persistent subscriptions without holding the concurrency slot open", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
    const response = await handleMcpHttpRequest(rpcRequest({
      headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: {
        notifications: { toolsListChanged: true },
        _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "test", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} },
      } }),
    }), deps);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: -32603, message: "Subscription limit reached" } });
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
  });

  it.each([
    { permissions: ["jobs:read", "tracking:read", "tracking:write"], listed: true, writeConnections: 2 },
    { permissions: ["jobs:read", "tracking:read"], listed: false, writeConnections: 1 },
  ] as const)("offers tracking writes to a token granted tracking:write ($listed) without the writer switch", async ({ permissions, listed, writeConnections }) => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(mcpSchema.parse({ enabled: true, permissions: ["jobs:read", "tracking:read", "tracking:write"], http: { enabled: true } }));
    deps.verify.mockImplementation(async () => ({ ok: true, grant: { kind: "token", tokenId: 7, permissions: [...permissions] } }));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const result = await snapshot(await handleMcpHttpRequest(rpcRequest({ headers: { "mcp-protocol-version": "2025-06-18" }, body }), deps));
    const json = result.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    const tools = (JSON.parse(json).result.tools as { name: string }[]).map((tool) => tool.name);
    for (const id of ["set_application_status", "mark_applied", "set_next_action", "set_interview_rounds", "undo_change"]) expect(tools.includes(id)).toBe(listed);
    expect(tools).not.toContain("save_application_answer");
    expect(deps.writerEnabled).not.toHaveBeenCalled();
    expect(deps.writeDb).toHaveBeenCalledTimes(writeConnections);
  });

  it("refuses a tracking write per call for a token without tracking:write, even when the matrix allows it", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(mcpSchema.parse({ enabled: true, permissions: ["jobs:read", "tracking:read", "tracking:write"], http: { enabled: true } }));
    const tokenGrant = { kind: "token", tokenId: 7, permissions: ["jobs:read", "tracking:read"] } as const;
    deps.verify.mockImplementation(async () => ({ ok: true, grant: { ...tokenGrant, permissions: [...tokenGrant.permissions] } }));
    deps.readGrant.mockReturnValue(vi.fn(async () => ({ ...tokenGrant, permissions: [...tokenGrant.permissions] })));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mark_applied", arguments: { job_id: 1 } } });
    const result = await snapshot(await handleMcpHttpRequest(rpcRequest({ headers: { "mcp-protocol-version": "2025-06-18" }, body }), deps));
    const json = result.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    const call = JSON.parse(json).result as { isError: boolean; content: { text: string }[] };
    expect(call.isError).toBe(true);
    expect(call.content[0]!.text).toContain("tracking:write");
    expect(deps.writeDb).toHaveBeenCalledTimes(1);
    const audit = deps.audit.mock.results[0]!.value as { record: { mock: { calls: unknown[][] } }; inTransaction: { mock: { calls: unknown[][] } } };
    expect(audit.inTransaction.mock.calls).toEqual([]);
    expect(audit.record.mock.calls).toEqual([[expect.objectContaining({ capability: "mark_applied", outcome: "not_permitted", token_id: 7 })]]);
  });

  it.each([
    { global: ["jobs:read", "actions:run"], permissions: ["jobs:read", "actions:run"], listed: true, writeConnections: 2 },
    { global: ["jobs:read", "actions:run"], permissions: ["jobs:read"], listed: false, writeConnections: 1 },
    { global: ["jobs:read"], permissions: ["jobs:read", "actions:run"], listed: false, writeConnections: 1 },
  ] as const)("offers action tools only when both the matrix and the token grant actions:run ($global, $permissions)", async ({ global, permissions, listed, writeConnections }) => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(mcpSchema.parse({ enabled: true, permissions: [...global], http: { enabled: true } }));
    deps.verify.mockImplementation(async () => ({ ok: true, grant: { kind: "token", tokenId: 7, permissions: [...permissions] } }));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const result = await snapshot(await handleMcpHttpRequest(rpcRequest({ headers: { "mcp-protocol-version": "2025-06-18" }, body }), deps));
    const json = result.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    const tools = (JSON.parse(json).result.tools as { name: string }[]).map((tool) => tool.name);
    for (const id of ["run_collection", "translate_job", "get_request_status"]) expect(tools.includes(id)).toBe(listed);
    expect(deps.writeDb).toHaveBeenCalledTimes(writeConnections);
  });

  it("refuses an action trigger per call for a token without actions:run, even when the matrix allows it", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(mcpSchema.parse({ enabled: true, permissions: ["jobs:read", "actions:run"], http: { enabled: true } }));
    const tokenGrant = { kind: "token", tokenId: 7, permissions: ["jobs:read"] } as const;
    deps.verify.mockImplementation(async () => ({ ok: true, grant: { ...tokenGrant, permissions: [...tokenGrant.permissions] } }));
    deps.readGrant.mockReturnValue(vi.fn(async () => ({ ...tokenGrant, permissions: [...tokenGrant.permissions] })));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_collection", arguments: {} } });
    const result = await snapshot(await handleMcpHttpRequest(rpcRequest({ headers: { "mcp-protocol-version": "2025-06-18" }, body }), deps));
    const json = result.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    const call = JSON.parse(json).result as { isError: boolean; content: { text: string }[] };
    expect(call.isError).toBe(true);
    expect(call.content[0]!.text).toContain("actions:run");
    expect(deps.writeDb).toHaveBeenCalledTimes(1);
    const audit = deps.audit.mock.results[0]!.value as { record: { mock: { calls: unknown[][] } }; inTransaction: { mock: { calls: unknown[][] } } };
    expect(audit.inTransaction.mock.calls).toEqual([]);
    expect(audit.record.mock.calls).toEqual([[expect.objectContaining({ capability: "run_collection", outcome: "not_permitted", token_id: 7 })]]);
  });

  it("negotiates the raw 2025 protocol without a modern envelope", async () => {
    const response = await handleMcpHttpRequest(rpcRequest({ headers: { "mcp-protocol-version": "2025-06-18" } }), fakeDeps());
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(data!.slice(6)).result.protocolVersion).toBe("2025-06-18");
  });
});
