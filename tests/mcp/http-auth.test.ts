// @vitest-environment node
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleMcpHttpRequest, resetMcpThrottle, type McpHttpDependencies } from "@/lib/mcp/http";
import { readPasswordSetting } from "@/lib/security/password";

import { fakeDeps, grant, rpcRequest, SECRET, settings, snapshot } from "./http-helpers";

beforeEach(() => resetMcpThrottle());

describe("HTTP preconditions", () => {
  it.each(["disabled", "http-disabled", "unreadable"])("%s returns before password, token or database access", async (mode) => {
    const deps = fakeDeps();
    deps.readSettings.mockImplementation(() => {
      if (mode === "unreadable") throw new Error(SECRET);
      return { ...settings({ enabled: mode !== "http-disabled" }), enabled: mode !== "disabled" };
    });
    const response = await snapshot(await handleMcpHttpRequest(rpcRequest(), deps));
    expect(response).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    for (const spy of [deps.password, deps.readDb, deps.writeDb, deps.verify, deps.markUsed, deps.audit]) expect(spy).not.toHaveBeenCalled();
  });
  it.each([{}, { JOB_RADAR_WEB_PASSWORD_HASH: "invalid" }])("requires a usable password: %j", async (env) => {
    const deps = fakeDeps();
    const response = await snapshot(await handleMcpHttpRequest(rpcRequest(), { ...deps, password: () => readPasswordSetting(env) }));
    expect(response).toMatchObject({ status: 503, body: '{"error":"web_password_required"}' });
    for (const spy of [deps.readDb, deps.writeDb, deps.verify, deps.markUsed, deps.audit]) expect(spy).not.toHaveBeenCalled();
  });

});

describe("HTTP bearer verification", () => {
  it("logs a stable keyed source tag within the process without exposing the source or credentials", async () => {
    const deps = fakeDeps();
    const sources = ["192.0.2.1", "192.0.2.1", "192.0.2.2"];
    for (const source of sources) {
      await snapshot(await handleMcpHttpRequest(rpcRequest({ token: null, headers: { "x-forwarded-for": source } }), deps));
    }
    const lines = deps.log.mock.calls.map(([line]) => line);
    expect(lines[0]).toBe(lines[1]);
    expect(lines[0]).not.toBe(lines[2]);
    for (const [index, source] of sources.entries()) {
      expect(lines[index]).toMatch(/^\[mcp\] http request refused \(401\) source [a-f0-9]{8}$/);
      expect(lines[index]).not.toContain(source);
      expect(lines[index]).not.toContain(createHash("sha256").update(source).digest("hex").slice(0, 8));
      expect(lines[index]).not.toContain(SECRET);
    }
  });

  it("gives byte-identical refusals for every credential failure and ignores query strings and cookies", async () => {
    let reference: Awaited<ReturnType<typeof snapshot>> | undefined;
    for (const mode of ["absent", "scheme", "query", "cookie", "malformed", "unknown", "revoked", "expired"]) {
      resetMcpThrottle();
      const deps = fakeDeps();
      deps.verify.mockResolvedValue({ ok: false, reason: mode === "revoked" ? "revoked" : mode === "expired" ? "expired" : "unknown" });
      const request = rpcRequest({ token: null, url: `http://mcp.example.test/api/mcp${mode === "query" ? `?token=${SECRET}` : ""}` });
      if (mode === "cookie") request.headers.set("cookie", `token=${SECRET}`);
      if (mode === "scheme") request.headers.set("authorization", `Basic ${SECRET}`);
      if (mode === "malformed") request.headers.set("authorization", "Bearer wrong");
      if (["unknown", "revoked", "expired"].includes(mode)) request.headers.set("authorization", `Bearer ${SECRET}`);
      const result = await snapshot(await handleMcpHttpRequest(request, deps));
      reference ??= result;
      expect(result).toEqual(reference);
      expect(result).toMatchObject({ status: 401, body: '{"error":"unauthorized"}', headers: { "www-authenticate": "Bearer" } });
      expect(deps.verify).toHaveBeenCalledTimes(["unknown", "revoked", "expired"].includes(mode) ? 1 : 0);
      expect(deps.audit).not.toHaveBeenCalled();
      expect(deps.writeDb).not.toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\[mcp\] http request refused \(401\) source [a-f0-9]{8}$/));
    }
  });
  it("does not count database errors as token failures or expose error contents", async () => {
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ throttle: { max_failures: 1 } }));
    deps.verify.mockRejectedValue(Object.assign(new Error(SECRET), { code: "08006" }));
    for (let i = 0; i < 2; i++) expect(await snapshot(await handleMcpHttpRequest(rpcRequest(), deps))).toMatchObject({ status: 503, body: '{"error":"unavailable"}' });
    expect(deps.verify).toHaveBeenCalledTimes(2);
    expect(deps.log.mock.calls.flat().join()).toBe("[mcp] http verification failed: database,[mcp] http verification failed: database");
  });
  it("passes credential-free AuthInfo and tolerates last-use update failure", async () => {
    const deps = fakeDeps();
    deps.markUsed.mockRejectedValue(new Error(SECRET));
    const createHandler = vi.fn<McpHttpDependencies["createHandler"]>((factory, options) => {
      expect(options).toMatchObject({ responseMode: "json", maxRequestBodySize: settings().http.max_body_bytes });
      const real = deps.createHandler(factory, options);
      return { ...real, fetch: async (request, input) => {
        expect(input?.authInfo).toEqual({ token: "", clientId: String(grant.tokenId), scopes: ["jobs:read"], expiresAt: 253402300799 });
        return real.fetch(request, input);
      } };
    });
    expect((await snapshot(await handleMcpHttpRequest(rpcRequest(), { ...deps, createHandler }))).status).toBe(200);
    expect(deps.markUsed).toHaveBeenCalledWith(deps.writeDb.mock.results[0]?.value, grant.tokenId, deps.now());
    expect(deps.log).toHaveBeenCalledWith("[mcp] http last use failed: internal");
  });
});

describe("independent HTTP throttle", () => {
  it("locks a source before verification, respects global waits and resets a successful source", async () => {
    let now = 0;
    resetMcpThrottle(() => now);
    const deps = fakeDeps();
    deps.readSettings.mockReturnValue(settings({ throttle: { max_failures: 2, global_max_failures: 3, global_delay_seconds: 2, lockout_minutes: 1 } }));
    const send = async (source: string, valid = false) => snapshot(await handleMcpHttpRequest(rpcRequest({ token: valid ? SECRET : null, headers: { "x-forwarded-for": source } }), deps));
    expect((await send("source-a")).status).toBe(401);
    expect((await send("source-a")).status).toBe(401);
    expect(await send("source-a", true)).toMatchObject({ status: 429, headers: { "retry-after": "60" } });
    expect(deps.verify).not.toHaveBeenCalled();
    expect((await send("source-b", true)).status).toBe(200);
    expect((await send("source-b")).status).toBe(401);
    const calls = deps.verify.mock.calls.length;
    expect(await send("source-c", true)).toMatchObject({ status: 429, headers: { "retry-after": "2" } });
    expect(deps.verify).toHaveBeenCalledTimes(calls);
    now = 600001;
    expect((await send("source-b", true)).status).toBe(200);
    expect((await send("source-b")).status).toBe(401);
    expect((await send("source-b", true)).status).toBe(200);
  });
});
