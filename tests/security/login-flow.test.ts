// @vitest-environment node
/**
 * The optional web password end to end at the request level: the proxy gate (pages, Server Actions, RSC requests,
 * prefetches, API routes), the login and sign-out endpoints, the session cookie.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { proxy } from "@/proxy";
import { resetAllowlistCache } from "@/lib/security/allowed-hosts";
import { handleLogin, handleLogout, handleSignOutEverywhere, readCappedBody, resetLoginThrottle } from "@/lib/security/login";
import { readSessionGeneration, resetSessionSecretCache, SECURE_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/security/session";
import { resetSetupStateCache } from "@/lib/setup/state";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const PASSWORD = "a long test password";
const REMOTE = "box.example-tailnet.ts.net";
const remoteHeaders = { host: REMOTE, "x-forwarded-for": "100.64.0.2", "x-forwarded-proto": "https" } as const;

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  resetAllowlistCache();
  resetSetupStateCache();
  resetSessionSecretCache();
  resetLoginThrottle();
  vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "");
  vi.stubEnv("JOB_RADAR_WEB_PASSWORD", PASSWORD);
  // what compose (and pnpm start listening on loopback) pass to the web
  vi.stubEnv("JOB_RADAR_WEB_BIND", "127.0.0.1");
  vi.stubEnv("JOB_RADAR_WEB_LOCAL_LOGIN", "");
  vi.stubEnv("JOB_RADAR_SESSION_SECRET", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  tmp.cleanup();
  resetAllowlistCache();
  resetSetupStateCache();
  resetSessionSecretCache();
  resetLoginThrottle();
});

function request(pathname: string, headers: Record<string, string>, method = "GET", body?: string): NextRequest {
  const proto = headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return new NextRequest(`${proto}://${headers.host ?? "127.0.0.1:3000"}${pathname}`, { method, headers, body });
}

function loginRequest(form: Record<string, string>, extra: Record<string, string> = {}): NextRequest {
  return request("/api/auth/login", { ...remoteHeaders, "content-type": "application/x-www-form-urlencoded", ...extra }, "POST", new URLSearchParams(form).toString());
}

async function sessionCookie(): Promise<string> {
  const response = await handleLogin(loginRequest({ password: PASSWORD }));
  const value = response.cookies.get(SECURE_SESSION_COOKIE)?.value;
  if (value === undefined) throw new Error(`no session cookie (status ${response.status})`);
  return value;
}

describe("the gate in the proxy", () => {
  it("no password: nothing changes (no redirect to the login, no 401)", () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
    const page = proxy(request("/jobs", { ...remoteHeaders, accept: "text/html" }));
    expect(page.headers.get("location") ?? "").not.toContain("/login");
    expect(proxy(request("/api/search", { ...remoteHeaders, accept: "application/json" })).status).not.toBe(401);
  });

  it("a remote page navigation without a session goes to the login page, keeping the path", () => {
    const response = proxy(request("/jobs?view=table", { ...remoteHeaders, accept: "text/html" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://${REMOTE}/login?next=%2Fjobs%3Fview%3Dtable`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["an API route", "/api/search", "GET", { accept: "application/json" }],
    ["an API write", "/api/control/requests", "POST", { accept: "application/json", origin: `https://${REMOTE}` }],
    ["a Server Action on a page", "/settings", "POST", { accept: "text/x-component", "next-action": "abc123", origin: `https://${REMOTE}` }],
    ["a Server Action posted to the login page", "/login", "POST", { accept: "text/x-component", "next-action": "abc123", origin: `https://${REMOTE}` }],
    ["an RSC navigation", "/jobs", "GET", { accept: "text/x-component", rsc: "1" }],
    ["a prefetch", "/jobs", "GET", { accept: "*/*", rsc: "1", "next-router-prefetch": "1" }],
    ["the sign-out endpoint", "/api/auth/logout", "POST", { origin: `https://${REMOTE}` }],
    ["an encoded login path", "/%6cogin", "POST", { accept: "text/x-component", "next-action": "abc123", origin: `https://${REMOTE}` }],
    ["an encoded API path", "/api/%73earch", "GET", { accept: "application/json" }],
    ["an export", "/sources/registry/export", "GET", { accept: "*/*" }],
  ])("%s without a session gets 401 JSON", async (_name, pathname, method, extra) => {
    const response = proxy(request(pathname, { ...remoteHeaders, ...extra }, method));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "login_required" });
  });

  it("the health check, the login page and the login endpoint stay open", () => {
    expect(proxy(request("/api/health", remoteHeaders)).status).toBe(200);
    expect(proxy(request("/login", { ...remoteHeaders, accept: "text/html" })).status).toBe(200);
    expect(proxy(request("/api/auth/login", { ...remoteHeaders, origin: `https://${REMOTE}` }, "POST")).status).toBe(200);
  });

  it("a request from this machine passes without a session (loopback bind)", () => {
    expect(proxy(request("/api/search", { host: "127.0.0.1:3000", accept: "application/json" })).status).toBe(200);
  });

  it("a forged Host: localhost does not pass when the web listens beyond loopback, or with JOB_RADAR_WEB_LOCAL_LOGIN=1", () => {
    vi.stubEnv("JOB_RADAR_WEB_BIND", "0.0.0.0");
    expect(proxy(request("/api/search", { host: "localhost:3000", accept: "application/json" })).status).toBe(401);
    vi.stubEnv("JOB_RADAR_WEB_BIND", "127.0.0.1");
    vi.stubEnv("JOB_RADAR_WEB_LOCAL_LOGIN", "1");
    expect(proxy(request("/api/search", { host: "127.0.0.1:3000", accept: "application/json" })).status).toBe(401);
  });

  it("outside compose without JOB_RADAR_WEB_BIND, a forged Host and loopback X-Forwarded-For from the LAN do not pass", () => {
    // `next start` on every interface; the LAN client sends the headers a request from this machine would carry
    vi.stubEnv("JOB_RADAR_WEB_BIND", "");
    const spoofed = { host: "localhost:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http", origin: "http://localhost:3000", accept: "application/json" };
    expect(proxy(request("/api/search", spoofed)).status).toBe(401);
    expect(proxy(request("/settings", { ...spoofed, "next-action": "abc", accept: "text/x-component" }, "POST")).status).toBe(401);
    expect(proxy(request("/jobs", { ...spoofed, accept: "text/html" })).status).toBe(303);
  });

  it("the host allowlist still comes first", () => {
    expect(proxy(request("/api/health", { host: "x.evil.example" })).status).toBe(421);
  });

  it("with a valid session cookie every kind of request passes; a tampered one does not", async () => {
    const cookie = await sessionCookie();
    const withCookie = (value: string, extra: Record<string, string>, method = "GET", pathname = "/api/search") =>
      proxy(request(pathname, { ...remoteHeaders, cookie: `${SECURE_SESSION_COOKIE}=${value}`, ...extra }, method));
    expect(withCookie(cookie, { accept: "application/json" }).status).toBe(200);
    expect(withCookie(cookie, { accept: "text/x-component", "next-action": "abc", origin: `https://${REMOTE}` }, "POST", "/settings").status).toBe(200);
    // past the gate (a fresh install then goes on to the setup wizard)
    expect(withCookie(cookie, { accept: "text/x-component", rsc: "1" }, "GET", "/jobs").status).not.toBe(401);
    expect(withCookie(`${cookie.slice(0, -3)}AAA`, { accept: "application/json" }).status).toBe(401);
  });

  it("changing the password ends every session", async () => {
    const cookie = await sessionCookie();
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "another long password");
    expect(proxy(request("/api/search", { ...remoteHeaders, cookie: `${SECURE_SESSION_COOKIE}=${cookie}`, accept: "application/json" })).status).toBe(401);
  });

  it("over https only the __Host- cookie counts; the plain name is ignored there", async () => {
    const cookie = await sessionCookie();
    expect(proxy(request("/api/search", { ...remoteHeaders, cookie: `${SESSION_COOKIE}=${cookie}`, accept: "application/json" })).status).toBe(401);
  });

  it("sign out everywhere ends every existing session, on every device", async () => {
    const phone = await sessionCookie();
    const laptop = await sessionCookie();
    const withCookie = (value: string) => proxy(request("/api/search", { ...remoteHeaders, cookie: `${SECURE_SESSION_COOKIE}=${value}`, accept: "application/json" }));
    expect(withCookie(phone).status).toBe(200);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = handleSignOutEverywhere(request("/api/auth/logout-all", { ...remoteHeaders, cookie: `${SECURE_SESSION_COOKIE}=${laptop}`, origin: `https://${REMOTE}` }, "POST"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie") ?? "").toMatch(new RegExp(`${SECURE_SESSION_COOKIE}=;.*Max-Age=0`, "i"));
    expect(readSessionGeneration(tmp.configDir)).toBe(1);
    expect(withCookie(phone).status).toBe(401);
    expect(withCookie(laptop).status).toBe(401);
    // a new login works again
    expect(withCookie(await sessionCookie()).status).toBe(200);
  });

  it("sign out everywhere from this machine goes back to the settings page", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = handleSignOutEverywhere(request("/api/auth/logout-all", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }, "POST"));
    expect(response.headers.get("location")).toBe("/settings");
  });

  it("a malformed hash keeps the gate shut (never a silent no-password)", () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "not-a-hash");
    expect(proxy(request("/api/search", { ...remoteHeaders, accept: "application/json" })).status).toBe(401);
  });
});

describe("the login endpoint", () => {
  it("right password: an HttpOnly, SameSite=Lax, Secure (over https) session cookie and 303 to next", async () => {
    const response = await handleLogin(loginRequest({ password: PASSWORD, next: "/jobs?view=table" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/jobs?view=table");
    const header = response.headers.get("set-cookie") ?? "";
    // over https: the __Host- prefixed name (Secure, Path=/, no Domain)
    expect(header).toContain(`${SECURE_SESSION_COOKIE}=`);
    expect(header).not.toMatch(/Domain=/i);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=2592000/);
    expect(header).toMatch(/Secure/i);
    expect(header).not.toContain(PASSWORD.replaceAll(" ", "+"));
  });

  it("over plain http the cookie is not Secure; a JSON client gets {next}", async () => {
    const response = await handleLogin(loginRequest({ password: PASSWORD, next: "/settings" }, { "x-forwarded-proto": "http", accept: "application/json" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "/settings" });
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(header).not.toMatch(/Secure/i);
  });

  it("next is reduced to an internal path", async () => {
    for (const next of ["//evil.example", "https://evil.example", "/login", "/api/x", "/\\evil"]) {
      resetLoginThrottle();
      const response = await handleLogin(loginRequest({ password: PASSWORD, next }));
      expect(response.headers.get("location"), next).toBe("/");
    }
  });

  it("wrong password: 401 invalid_password and no cookie", async () => {
    const response = await handleLogin(loginRequest({ password: "wrong password!" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_password" });
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("a malformed body counts as a failed attempt", async () => {
    const response = await handleLogin(request("/api/auth/login", { ...remoteHeaders, "content-type": "application/json" }, "POST", JSON.stringify({ password: PASSWORD })));
    expect(response.status).toBe(401);
  });

  it("a body over 8 KiB is refused while streaming, even without a Content-Length", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode(`password=${"x".repeat(4096)}`));
      },
    });
    const response = await handleLogin(
      new NextRequest(new Request(`https://${REMOTE}/api/auth/login`, { method: "POST", headers: { ...remoteHeaders, "content-type": "application/x-www-form-urlencoded" }, body: endless, duplex: "half" } as RequestInit)),
    );
    expect(response.status).toBe(401);
    expect(pulled).toBeLessThan(10);
  });

  it("readCappedBody: the text up to the cap, null past it or for a larger declared length", async () => {
    expect(await readCappedBody(new Request("http://x/", { method: "POST", body: "a=1" }), 8)).toBe("a=1");
    expect(await readCappedBody(new Request("http://x/", { method: "POST", body: "a=123456789" }), 8)).toBeNull();
    expect(await readCappedBody(new Request("http://x/", { method: "POST", body: "a=1", headers: { "content-length": "9999" } }), 8)).toBeNull();
    expect(await readCappedBody(new Request("http://x/", { method: "POST" }), 8)).toBe("");
  });

  it("a locked-out source is answered before its body is read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 5; i++) await handleLogin(loginRequest({ password: `wrong ${i} attempt` }));
    const locked = loginRequest({ password: PASSWORD });
    expect((await handleLogin(locked)).status).toBe(429);
    expect(locked.bodyUsed).toBe(false);
  });

  it("too many failures: 429 with Retry-After, checked before any scrypt run, and logged without the address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 5; i++) expect((await handleLogin(loginRequest({ password: `wrong ${i} attempt` }))).status).toBe(401);
    const locked = await handleLogin(loginRequest({ password: PASSWORD }));
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await locked.json()).toMatchObject({ error: "too_many_attempts" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("100.64.0.2");
    // another source is not locked by these five
    expect((await handleLogin(loginRequest({ password: PASSWORD }, { "x-forwarded-for": "100.64.0.9" }))).status).toBe(303);
  });

  it("caps concurrent scrypt runs", async () => {
    const pending = Array.from({ length: 6 }, (_, i) => handleLogin(loginRequest({ password: PASSWORD }, { "x-forwarded-for": `100.64.1.${i}` })));
    const statuses = (await Promise.all(pending)).map((response) => response.status);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    expect(statuses.filter((status) => status === 303)).toHaveLength(4);
  });

  it("a malformed configured hash: 500 password_misconfigured, the log names only the variable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "scrypt:broken");
    const response = await handleLogin(loginRequest({ password: "scrypt:broken" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "password_misconfigured" });
    expect(String(error.mock.calls[0]?.[0])).toContain("JOB_RADAR_WEB_PASSWORD_HASH");
    expect(String(error.mock.calls[0]?.[0])).not.toContain("scrypt:broken");
  });

  it("no password configured: no cookie, straight to next", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
    const response = await handleLogin(loginRequest({ password: "", next: "/jobs" }));
    expect(response.status).toBe(303);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(response.cookies.get(SECURE_SESSION_COOKIE)).toBeUndefined();
  });

  it("the throttle key is the address the nearest hop saw: a forged first X-Forwarded-For entry does not get a fresh budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 5; i++) await handleLogin(loginRequest({ password: `wrong ${i} attempt` }, { "x-forwarded-for": `198.51.100.${i}, 100.64.0.2` }));
    expect((await handleLogin(loginRequest({ password: PASSWORD }, { "x-forwarded-for": "198.51.100.99, 100.64.0.2" }))).status).toBe(429);
  });

  it("past the global limit logins wait (logged), but not a request that already holds a valid session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cookie = await sessionCookie();
    // 30 failures from 30 sources (the default global limit)
    for (let i = 0; i < 30; i++) await handleLogin(loginRequest({ password: `wrong ${i} attempt` }, { "x-forwarded-for": `100.64.2.${i}` }));
    const stranger = await handleLogin(loginRequest({ password: PASSWORD }, { "x-forwarded-for": "100.64.3.1" }));
    expect(stranger.status).toBe(429);
    expect(warn.mock.calls.some((call) => /every login/i.test(String(call[0])))).toBe(true);
    const owner = await handleLogin(loginRequest({ password: PASSWORD }, { "x-forwarded-for": "100.64.3.2", cookie: `${SECURE_SESSION_COOKIE}=${cookie}` }));
    expect(owner.status).toBe(303);
  }, 120_000);
});

describe("the sign-out endpoint", () => {
  it("clears the cookie and goes to the login page", () => {
    const response = handleLogout(request("/api/auth/logout", remoteHeaders, "POST"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie") ?? "").toMatch(new RegExp(`${SECURE_SESSION_COOKIE}=;.*Max-Age=0`, "i"));
    const plain = handleLogout(request("/api/auth/logout", { host: "192.168.1.20:3000", "x-forwarded-for": "192.168.1.50" }, "POST"));
    expect(plain.headers.get("set-cookie") ?? "").toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`, "i"));
  });
});
