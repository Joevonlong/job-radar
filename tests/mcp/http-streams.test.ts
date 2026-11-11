// @vitest-environment node
import { createMcpHandler } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleMcpHttpRequest, resetMcpThrottle, type McpHttpDependencies } from "@/lib/mcp/http";

import { expectHygiene, fakeDeps, rpcRequest, SECRET, settings, snapshot } from "./http-helpers";

beforeEach(() => resetMcpThrottle());

function responseDeps(response: () => Response) {
  const deps = fakeDeps();
  deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
  const createHandler: McpHttpDependencies["createHandler"] = (factory, options) => ({ ...deps.createHandler(factory, options), fetch: async () => response() });
  return { ...deps, createHandler };
}

describe("HTTP streaming limits", () => {
  it.each(["1025", "9".repeat(400)])("rejects declared oversize %s without reading the body or recording last-use", async (declared) => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ max_body_bytes: 1024 }));
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await snapshot(await handleMcpHttpRequest(rpcRequest({ body, headers: { "content-length": declared } }), deps));
    expect(response).toMatchObject({ status: 413, body: '{"error":"payload_too_large"}' });
    expect(pull).not.toHaveBeenCalled();
    expect(deps.markUsed).not.toHaveBeenCalled();
  });
  it("lets the SDK cap a chunked body before it is fully read", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ max_body_bytes: 1024 }));
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(512));
      if (chunks === 100) controller.close();
    } }, { highWaterMark: 0 });
    expect(await snapshot(await handleMcpHttpRequest(rpcRequest({ body }), deps))).toMatchObject({ status: 413, body: '{"error":"payload_too_large"}' });
    expect(chunks).toBeLessThan(100);
  });
  it.each(["read", "cancel"])("keeps the slot until a legacy SSE response is consumed via %s", async (mode) => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
    const first = await handleMcpHttpRequest(rpcRequest(), deps);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    expect(await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).toMatchObject({ status: 503, headers: { "retry-after": "1" }, body: '{"error":"busy"}' });
    expect(deps.verify).toHaveBeenCalledTimes(1);
    if (mode === "read") await first.text();
    else await first.body!.cancel();
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
  });
  it("releases a slot after an exception and reports only its category", async () => {
    let fail = true;
    const deps = responseDeps(() => { if (fail) throw new Error(SECRET); return Response.json({ ok: true }); });
    expect(await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).toMatchObject({ status: 500, body: '{"error":"internal"}' });
    fail = false;
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("[mcp] http error: internal");
  });
  it("releases a slot after a stream error without exposing its message", async () => {
    let fail = true;
    const deps = responseDeps(() => new Response(new ReadableStream({ pull(controller) {
      if (fail) controller.error(new Error(SECRET)); else controller.close();
    } })));
    const response = await handleMcpHttpRequest(rpcRequest(), deps);
    await expect(response.text()).rejects.toThrow("internal");
    fail = false;
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
  });
  it.each(["during verification", "after response", "before handling"])("releases disconnected clients %s even when nobody reads the response", async (when) => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
    const abort = new AbortController();
    const verified = Promise.withResolvers<Awaited<ReturnType<typeof deps.verify>>>();
    const entered = Promise.withResolvers<void>();
    if (when === "during verification") deps.verify.mockImplementationOnce(() => { entered.resolve(); return verified.promise; });
    if (when === "before handling") abort.abort();
    const handling = handleMcpHttpRequest(rpcRequest({ signal: abort.signal }), deps);
    if (when === "during verification") {
      await entered.promise;
      abort.abort();
      verified.resolve({ ok: true, grant: { kind: "token", tokenId: 42, permissions: ["jobs:read"] } });
    }
    const response = await handling;
    if (when === "after response") abort.abort();
    else expect(deps.markUsed).not.toHaveBeenCalled();
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
    if (response.body && !response.body.locked) await response.body.cancel();
  });

  it("normalizes exceptions the real SDK converts into an HTTP error", async () => {
    const deps = fakeDeps();
    const createHandler: McpHttpDependencies["createHandler"] = (_factory, options) => createMcpHandler(() => { throw new Error(SECRET); }, options);
    expect(await snapshot(await handleMcpHttpRequest(rpcRequest(), { ...deps, createHandler }))).toMatchObject({ status: 500, body: '{"error":"internal"}' });
    expect(deps.log.mock.calls.flat().join()).not.toContain(SECRET);
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
  });

  it("strips all CORS headers from SDK responses", async () => {
    const deps = responseDeps(() => new Response("ok", { headers: { "access-control-allow-origin": "*", "Access-Control-Allow-Credentials": "true", "access-control-custom": "value" } }));
    const response = await handleMcpHttpRequest(rpcRequest(), deps);
    expectHygiene(response);
    expect(await response.text()).toBe("ok");
  });
  it("never leaks the unique bearer sentinel through responses, logs or audit entries", async () => {
    const consoleSpies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const deps = fakeDeps();
      const results = [await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))];
      deps.verify.mockRejectedValue(new Error(SECRET));
      results.push(await snapshot(await handleMcpHttpRequest(rpcRequest(), deps)));
      deps.verify.mockResolvedValue({ ok: false, reason: "unknown" });
      results.push(await snapshot(await handleMcpHttpRequest(rpcRequest(), deps)));
      expect(JSON.stringify([results, deps.log.mock.calls, consoleSpies.map((spy) => spy.mock.calls), deps.audit.mock.results.map((result) => result.value.record.mock.calls)])).not.toContain(SECRET);
    } finally { for (const spy of consoleSpies) spy.mockRestore(); }
  });
});
