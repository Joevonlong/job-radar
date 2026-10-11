// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hasLoginState, isLoggedInState, readAuthFileInfo, resolveAuthFile, writeAuthFile } from "@/lib/channels/linkedin/session/auth-file";
import { loginStateOf, readAuthFlag, type AuthFlag } from "@/lib/channels/linkedin/session/auth-state";

import { NOW, authFileIn, loggedInState, tempDir } from "./helpers";

describe("auth file", () => {
  it("reports a missing file, a file without LinkedIn's session cookie, and a malformed file as 'no login'", () => {
    const dir = tempDir();
    expect(readAuthFileInfo(path.join(dir, "none.json"))).toMatchObject({ exists: false, hasSessionCookie: false });

    const anonymous = path.join(dir, "anonymous.json");
    fs.writeFileSync(anonymous, JSON.stringify({ cookies: [{ name: "bcookie", value: "x", domain: ".linkedin.com", expires: -1 }], origins: [] }));
    expect(readAuthFileInfo(anonymous)).toMatchObject({ exists: true, hasSessionCookie: false });

    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    expect(readAuthFileInfo(broken)).toMatchObject({ exists: true, hasSessionCookie: false });
    expect(hasLoginState(broken)).toBe(false);
    expect(hasLoginState(dir)).toBe(false); // a directory is not a login
  });

  it("reads the cookie's expiry and the write time, and never returns a cookie value", () => {
    const file = authFileIn({ expires: Math.floor(NOW.getTime() / 1000) + 3600 });
    const info = readAuthFileInfo(file);
    expect(info).toMatchObject({ exists: true, hasSessionCookie: true });
    expect(info.sessionCookieExpiresAt?.toISOString()).toBe("2026-10-07T09:00:00.000Z");
    expect(JSON.stringify(info)).not.toContain("placeholder");
    expect(info.modifiedAt).toBeInstanceOf(Date);
  });

  it("writes the file with owner-only permissions (file 600, directory 700)", () => {
    const file = authFileIn();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    writeAuthFile(file, loggedInState()); // replaced atomically, still private
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["linkedin.json"]);
  });

  it("only a state that holds the session cookie is worth saving", () => {
    expect(isLoggedInState(loggedInState())).toBe(true);
    expect(isLoggedInState({ cookies: [{ name: "bcookie", domain: ".linkedin.com" }], origins: [] })).toBe(false);
    expect(isLoggedInState({ cookies: [{ name: "li_at", domain: ".example.com" }] })).toBe(false);
    expect(isLoggedInState("nonsense")).toBe(false);
  });

  it("resolves a relative path against the app root and keeps an absolute one", () => {
    expect(resolveAuthFile(".auth/linkedin.json", "/app")).toBe("/app/.auth/linkedin.json");
    expect(resolveAuthFile("/secrets/li.json", "/app")).toBe("/secrets/li.json");
  });
});

describe("loginStateOf", () => {
  const info = (overrides: Partial<ReturnType<typeof readAuthFileInfo>> = {}) => ({
    path: "/x",
    exists: true,
    hasSessionCookie: true,
    sessionCookieExpiresAt: new Date("2027-01-01T00:00:00Z"),
    modifiedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  });
  const expired = (at: string): AuthFlag => ({ status: "expired", reason: "checkpoint", at });

  it("is 未登录 (missing) without a file or without the session cookie", () => {
    expect(loginStateOf(info({ exists: false, hasSessionCookie: false, modifiedAt: null }), null, NOW)).toEqual({ status: "missing", reason: null });
    expect(loginStateOf(info({ hasSessionCookie: false }), null, NOW)).toEqual({ status: "missing", reason: null });
  });

  it("is valid with a file and no complaint", () => {
    expect(loginStateOf(info(), null, NOW)).toEqual({ status: "valid", reason: null });
    expect(loginStateOf(info(), { status: "valid", at: "2026-10-02T00:00:00Z" }, NOW).status).toBe("valid");
  });

  it("is expired when the cookie ran out, or when a channel was sent to a wall after the file was written", () => {
    expect(loginStateOf(info({ sessionCookieExpiresAt: new Date("2026-10-07T07:00:00Z") }), null, NOW)).toEqual({ status: "expired", reason: "cookie_expired" });
    expect(loginStateOf(info(), expired("2026-10-05T00:00:00Z"), NOW)).toEqual({ status: "expired", reason: "checkpoint" });
  });

  it("a login redone after the complaint (newer file) is valid again", () => {
    expect(loginStateOf(info({ modifiedAt: new Date("2026-10-06T00:00:00Z") }), expired("2026-10-05T00:00:00Z"), NOW).status).toBe("valid");
  });

  it("reads a stored flag defensively", () => {
    expect(readAuthFlag({ status: "valid", at: "2026-10-02T00:00:00.000Z" })).toEqual({ status: "valid", at: "2026-10-02T00:00:00.000Z" });
    expect(readAuthFlag({ status: "expired", reason: "login_required", at: "2026-10-02T00:00:00.000Z" })?.status).toBe("expired");
    expect(readAuthFlag({ status: "expired", reason: "nope", at: "x" })).toBeNull();
    expect(readAuthFlag(null)).toBeNull();
  });
});
