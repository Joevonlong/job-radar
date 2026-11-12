// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as route from "@/app/api/mcp/route";
import { resetMcpThrottle } from "@/lib/mcp/http";

import { fakeDeps, rpcRequest, settings, snapshot } from "./http-helpers";

let deps: ReturnType<typeof fakeDeps>;
vi.mock("@/lib/mcp/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/mcp/http")>();
  return { ...original, handleMcpHttpRequest: (request: Request) => original.handleMcpHttpRequest(request, deps) };
});

beforeEach(() => { deps = fakeDeps(); resetMcpThrottle(); });

const methods = ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const requestFor = (method: string) => new Request("http://mcp.example.test/api/mcp", { method });
const expectNoWork = () => {
  for (const spy of [deps.verify, deps.readDb, deps.writeDb, deps.markUsed, deps.audit, deps.writerEnabled, deps.readGrant]) expect(spy).not.toHaveBeenCalled();
};

describe.each(methods)("HTTP %s route", (method) => {
  it.each(["disabled", "http-disabled", "unreadable"])("keeps the %s precondition ahead of method refusal", async (mode) => {
    deps.readSettings.mockImplementation(() => {
      if (mode === "unreadable") throw new Error("unreadable");
      return { ...settings({ enabled: mode !== "http-disabled" }), enabled: mode !== "disabled" };
    });
    expect(await snapshot(await route[method](requestFor(method)))).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    expect(deps.password).not.toHaveBeenCalled();
    expectNoWork();
  });

  it.each([null, { kind: "hash" as const, hash: "invalid", parsed: null }])("keeps the password precondition ahead of method refusal: %j", async (password) => {
    deps.password.mockReturnValue(password);
    expect(await snapshot(await route[method](requestFor(method)))).toMatchObject({ status: 503, body: '{"error":"web_password_required"}' });
    expectNoWork();
  });

  it("returns only a static refusal and Allow header without authentication or database work", async () => {
    expect(await snapshot(await route[method](requestFor(method)))).toMatchObject({
      status: 405, body: '{"error":"method_not_allowed"}', headers: { allow: "POST" },
    });
    expectNoWork();
  });

  it("does not consult or update the authentication throttle", async () => {
    deps.readSettings.mockReturnValue(settings({ throttle: { max_failures: 1 } }));
    await snapshot(await route[method](requestFor(method)));
    expect((await snapshot(await route.POST(rpcRequest({ token: null })))).status).toBe(401);
    expect((await snapshot(await route.POST(rpcRequest()))).status).toBe(429);
    expect((await snapshot(await route[method](requestFor(method)))).status).toBe(405);
    expectNoWork();
  });

  it("does not reserve a concurrency slot or wait for an occupied one", async () => {
    deps.readSettings.mockReturnValue(settings({ pool: { max_concurrent: 1 } }));
    const first = await route.POST(rpcRequest());
    expect(first.status).toBe(200);
    expect((await snapshot(await route[method](requestFor(method)))).status).toBe(405);
    expect((await snapshot(await route.POST(rpcRequest()))).status).toBe(503);
    await first.body!.cancel();
    expect((await snapshot(await route.POST(rpcRequest()))).status).toBe(200);
  });
});
