// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config, proxy } from "@/proxy";
import { currentAllowlist, resetAllowlistCache } from "@/lib/security/allowed-hosts";
import { isAllowedHost } from "@/lib/security/host-allowlist";
import { createSessionToken, sessionCookieName } from "@/lib/security/session";
import { passwordVersion } from "@/lib/security/password";
import { resetSetupStateCache } from "@/lib/setup/state";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  resetAllowlistCache();
  resetSetupStateCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  tmp.cleanup();
  resetAllowlistCache();
  resetSetupStateCache();
});

function request(url: string, headers: Record<string, string>, method = "GET"): NextRequest {
  return new NextRequest(url, { method, headers });
}

describe("proxy host check", () => {
  it("refuses a request addressed to a foreign name with 421 and a plain-text explanation", async () => {
    const response = proxy(request("http://x.evil.example:3000/settings", { host: "x.evil.example:3000", origin: "http://x.evil.example:3000" }, "POST"));
    expect(response.status).toBe(421);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("JOB_RADAR_ALLOWED_HOSTS");
  });

  it("refuses an API request with a foreign Origin", () => {
    expect(proxy(request("http://127.0.0.1:3000/api/search", { host: "127.0.0.1:3000", origin: "https://evil.example" })).status).toBe(421);
  });

  it("passes the dashboard's own requests on (health check, Tailscale)", () => {
    expect(proxy(request("http://127.0.0.1:3000/api/health", { host: "127.0.0.1:3000" })).status).toBe(200);
    // a fresh install: the page navigation goes on to the setup wizard (a redirect, not a refusal)
    const page = proxy(request("https://box.example-tailnet.ts.net/jobs", { host: "box.example-tailnet.ts.net", accept: "text/html" }));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/setup?step=");
  });

  it("adds JOB_RADAR_ALLOWED_HOSTS but never notify.yaml public_base_url", () => {
    const file = path.join(tmp.configDir, "notify.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("public_base_url: null", "public_base_url: https://radar.example.org"));
    vi.stubEnv("JOB_RADAR_ALLOWED_HOSTS", "jobs.example.com");
    const allowlist = currentAllowlist();
    expect(isAllowedHost("radar.example.org", allowlist.hosts)).toBe(false);
    expect(isAllowedHost("jobs.example.com", allowlist.hosts)).toBe(true);
    expect(isAllowedHost("other.example.com", allowlist.hosts)).toBe(false);
  });

  it("refuses a Server Action POST from another Tailscale machine", () => {
    expect(proxy(request("http://localhost:3000/settings", { host: "localhost:3000", origin: "https://evil.example-other.ts.net" }, "POST")).status).toBe(421);
  });

  it("runs on every route but Next's static build output", () => {
    const matcher = new RegExp(`^${config.matcher[0]?.replace("/((?!", "/(?!").replace(").*)", ").*")}$`);
    for (const pathname of ["/", "/setup", "/api/health", "/sources/registry/export", "/jobs/1", "/favicon.ico"]) expect(matcher.test(pathname), pathname).toBe(true);
    expect(matcher.test("/_next/static/chunks/a.js")).toBe(false);
  });
});


describe("MCP proxy boundary", () => {
  beforeEach(() => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "");
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "test-password");
    vi.stubEnv("JOB_RADAR_WEB_LOCAL_LOGIN", "1");
    vi.stubEnv("JOB_RADAR_SESSION_SECRET", "test-session-secret-with-at-least-thirty-two-characters");
  });
  const remote = { host: "127.0.0.1:3000", "x-forwarded-for": "192.0.2.1", accept: "application/json" };

  it("keeps Host and Origin checks ahead of token routing", () => {
    expect(proxy(request("http://evil.example/api/mcp", { ...remote, host: "evil.example" }, "POST")).status).toBe(421);
    expect(proxy(request("http://127.0.0.1:3000/api/mcp", { ...remote, origin: "https://evil.example" }, "POST")).status).toBe(421);
    expect(proxy(request("http://127.0.0.1:3000/api/mcp", remote, "POST")).status).toBe(200);
  });

  it("requires a session for every spelling, method and Server Action variant", () => {
    for (const pathname of ["/api/mcp/", "/api/mcp/x", "/api/mcpx", "/API/mcp", "/api/mcp%2F"]) {
      expect(proxy(request(`http://127.0.0.1:3000${pathname}`, remote, "POST")).status, pathname).toBe(401);
      expect(proxy(request(`http://127.0.0.1:3000${pathname}`, { ...remote, accept: "text/html" })).status).toBe(303);
    }
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"]) expect(proxy(request("http://127.0.0.1:3000/api/mcp", remote, method)).status).toBe(401);
    for (const pathname of ["/api/mcp", "/settings"]) expect(proxy(request(`http://127.0.0.1:3000${pathname}`, { ...remote, "next-action": "" }, "POST")).status).toBe(401);
  });

  it("still accepts the owner's signed session on protected requests", () => {
    const secret = Buffer.from(process.env.JOB_RADAR_SESSION_SECRET!);
    const token = createSessionToken(secret, passwordVersion({ kind: "plain", plain: "test-password" }, secret), 3600, new Date());
    const headers = { ...remote, cookie: `${sessionCookieName(false)}=${token}`, "next-action": "action" };
    for (const pathname of ["/settings", "/api/mcp", "/api/control/requests", "/api/mcp/"]) expect(proxy(request(`http://127.0.0.1:3000${pathname}`, headers, "POST")).status).toBe(200);
  });
});
