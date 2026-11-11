// @vitest-environment node
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleMcpHttpRequest, resetMcpThrottle } from "@/lib/mcp/http";

import { fakeDeps, grant, rpcRequest, settings, snapshot } from "./http-helpers";

beforeEach(() => resetMcpThrottle());

const inFlight = () => (globalThis as { __jobRadarMcpHttp?: { inFlight: number } }).__jobRadarMcpHttp!.inFlight;
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

function toolCall(protocol: string, id: number, signal?: AbortSignal) {
  const modern = protocol === "2026-07-28";
  const meta = { [PROTOCOL_VERSION_META_KEY]: protocol, [CLIENT_INFO_META_KEY]: { name: "test", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} };
  return rpcRequest({
    signal,
    headers: modern ? { "mcp-protocol-version": protocol, "mcp-method": "tools/call", "mcp-name": "get_job" } : { "mcp-protocol-version": protocol },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_job", arguments: { job_id: 1 }, ...modern ? { _meta: meta } : {} } }),
  });
}

describe.each(["2025-06-18", "2026-07-28"])("real SDK handler and server, protocol %s", (protocol) => {
  it("holds the slot until an aborted tool call settles and releases it exactly once", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
    let started = 0;
    let running = 0;
    let maximum = 0;
    const finish = Promise.withResolvers<void>();
    // The grant re-read inside every tools/call stands in for a database query that is still running.
    deps.readGrant.mockImplementation(() => vi.fn(async () => {
      started++;
      running++;
      maximum = Math.max(maximum, running);
      try { await finish.promise; } finally { running--; }
      return grant;
    }));

    const pending: Promise<unknown>[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const abort = new AbortController();
      pending.push(handleMcpHttpRequest(toolCall(protocol, i + 1, abort.signal), deps).then(async (response) => {
        statuses.push(response.status);
        await response.text().catch(() => "");
      }));
      await pause();
      abort.abort();
      await pause();
    }
    try {
      expect(started).toBe(1);
      expect(maximum).toBe(1);
      expect(inFlight()).toBe(1);
      expect(statuses.filter((status) => status === 503)).toHaveLength(4);
      expect(await snapshot(await handleMcpHttpRequest(toolCall(protocol, 9), deps))).toMatchObject({ status: 503, body: '{"error":"busy"}' });
    } finally { finish.resolve(); }
    await Promise.allSettled(pending);
    await pause();
    expect(running).toBe(0);
    expect(inFlight()).toBe(0);

    const next = await handleMcpHttpRequest(toolCall(protocol, 10), deps);
    expect(next.status).toBe(200);
    await next.text();
    await pause();
    expect(started).toBe(2);
    expect(inFlight()).toBe(0);
  });
});

describe("slot accounting with the real SDK handler", () => {
  it("returns to zero once on every path", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 }, max_body_bytes: 1024, throttle: { max_failures: 2 } }));
    const big = new TextEncoder().encode(" ".repeat(4096));
    const paths: [string, number, () => Request][] = [
      ["success", 200, () => rpcRequest()],
      ["tool call", 200, () => toolCall("2026-07-28", 1)],
      ["405", 405, () => new Request("http://mcp.example.test/api/mcp", { method: "GET" })],
      ["413 declared", 413, () => rpcRequest({ headers: { "content-length": "999999" } })],
      ["413 streamed", 413, () => rpcRequest({ body: new ReadableStream({ start(controller) { controller.enqueue(big); controller.enqueue(big); controller.close(); } }) })],
      ["503 verification", 503, () => { deps.verify.mockRejectedValueOnce(new Error("db down")); return rpcRequest(); }],
      ["401", 401, () => rpcRequest({ token: null })],
      ["401 again", 401, () => rpcRequest({ token: null })],
      ["429", 429, () => rpcRequest()],
    ];
    for (const [name, status, request] of paths) {
      const response = await handleMcpHttpRequest(request(), deps);
      expect(response.status, name).toBe(status);
      await response.text().catch(() => "");
      await new Promise(setImmediate);
      expect(inFlight(), name).toBe(0);
    }
  });
});
