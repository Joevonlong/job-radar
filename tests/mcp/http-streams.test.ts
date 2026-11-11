// @vitest-environment node
import { createMcpHandler } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleMcpHttpRequest, resetMcpThrottle, type McpHttpDependencies } from "@/lib/mcp/http";

import { expectHygiene, fakeDeps, grant, rpcRequest, SECRET, settings, snapshot } from "./http-helpers";

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
    if (when === "after response") { abort.abort(); await new Promise(setImmediate); }
    else expect(deps.markUsed).not.toHaveBeenCalled();
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
    if (response.body && !response.body.locked) await response.body.cancel();
  });

  it.each(["verification", "last-use update", "tool call"])("retains the slot for five disconnects during pending %s and releases it exactly once", async (stage) => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
    let running = 0;
    let maximum = 0;
    let entered = Promise.withResolvers<void>();
    let settled = Promise.withResolvers<void>();
    const work = async () => {
      running++;
      maximum = Math.max(maximum, running);
      entered.resolve();
      try { await settled.promise; }
      finally { running--; }
    };
    if (stage === "verification") deps.verify.mockImplementation(async () => { await work(); return { ok: true, grant }; });
    if (stage === "last-use update") deps.markUsed.mockImplementation(work);
    const createHandler: McpHttpDependencies["createHandler"] = (factory, options) => ({
      ...deps.createHandler(factory, options),
      fetch: async () => { if (stage === "tool call") await work(); return Response.json({ ok: true }); },
    });
    const dependencies = { ...deps, createHandler };
    for (let round = 0; round < 5; round++) {
      entered = Promise.withResolvers<void>();
      settled = Promise.withResolvers<void>();
      const abort = new AbortController();
      const pending = handleMcpHttpRequest(rpcRequest({ signal: abort.signal }), dependencies);
      await entered.promise;
      try {
        abort.abort();
        for (let attempt = 0; attempt < 5; attempt++) {
          const retryAbort = new AbortController();
          const retry = handleMcpHttpRequest(rpcRequest({ signal: retryAbort.signal }), dependencies);
          retryAbort.abort();
          expect(await snapshot(await retry)).toMatchObject({ status: 503, body: '{"error":"busy"}' });
        }
        expect(running).toBe(1);
        expect(maximum).toBe(1);
      } finally { settled.resolve(); }
      const response = await pending;
      expect(running).toBe(0);
      await response.body?.cancel();
      abort.abort();
    }
    const first = await handleMcpHttpRequest(rpcRequest(), dependencies);
    expect(first.status).toBe(200);
    expect(await snapshot(await handleMcpHttpRequest(rpcRequest(), dependencies))).toMatchObject({ status: 503, body: '{"error":"busy"}' });
    await first.body!.cancel();
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), dependencies))).status).toBe(200);
  });

  it("cancels an unread request body on disconnect while verification retains the slot", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
    const entered = Promise.withResolvers<void>();
    const verification = Promise.withResolvers<Awaited<ReturnType<typeof deps.verify>>>();
    deps.verify.mockImplementationOnce(() => { entered.resolve(); return verification.promise; });
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const abort = new AbortController();
    const pending = handleMcpHttpRequest(rpcRequest({ body, signal: abort.signal }), deps);
    await entered.promise;
    abort.abort();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(503);
    verification.resolve({ ok: true, grant });
    await snapshot(await pending);
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
  });

  it("stops a body read already locked by the SDK on disconnect", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
    const reading = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel }, { highWaterMark: 0 });
    const abort = new AbortController();
    const pending = handleMcpHttpRequest(rpcRequest({ body, signal: abort.signal }), deps);
    await reading.promise;
    abort.abort();
    await snapshot(await pending);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(200);
  });

  it("cancels a locked response reader on disconnect and releases the slot once", async () => {
    const reading = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const deps = responseDeps(() => new Response(new ReadableStream({ pull() { reading.resolve(); }, cancel }, { highWaterMark: 0 })));
    const abort = new AbortController();
    const response = await handleMcpHttpRequest(rpcRequest({ signal: abort.signal }), deps);
    const reader = response.body!.getReader();
    const pending = reader.read();
    await reading.promise;
    abort.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    await reader.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    const next = await handleMcpHttpRequest(rpcRequest(), deps);
    expect(next.status).toBe(200);
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).status).toBe(503);
    await next.body!.cancel();
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
