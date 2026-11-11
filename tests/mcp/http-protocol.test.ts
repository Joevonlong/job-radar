// @vitest-environment node
import { Client, StreamableHTTPClientTransport, PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleMcpHttpRequest, mcpMethodNotAllowed, resetMcpThrottle } from "@/lib/mcp/http";

import { fakeDeps, rpcRequest, SECRET, settings, snapshot } from "./http-helpers";

const clients: Client[] = [];
beforeEach(() => resetMcpThrottle());
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

describe("installed MCP SDK HTTP protocols", () => {
  it("negotiates the modern protocol with the real client and lists only effective tools", async () => {
    const deps = fakeDeps();
    const responses: Awaited<ReturnType<typeof snapshot>>[] = [];
    const transport = new StreamableHTTPClientTransport(new URL("http://mcp.example.test/api/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${SECRET}` } },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const response = request.method === "POST" ? await handleMcpHttpRequest(request, deps) : mcpMethodNotAllowed();
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

  it("negotiates the raw 2025 protocol without a modern envelope", async () => {
    const response = await handleMcpHttpRequest(rpcRequest({ headers: { "mcp-protocol-version": "2025-06-18" } }), fakeDeps());
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(data!.slice(6)).result.protocolVersion).toBe("2025-06-18");
  });
});
