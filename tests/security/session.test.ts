// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bumpSessionGeneration,
  createSessionToken,
  isHttpsRequest,
  readSessionGeneration,
  resetSessionSecretCache,
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_GENERATION_FILE,
  SESSION_SECRET_FILE,
  sessionCookieName,
  sessionSecret,
  sessionSecretTooShort,
  verifySessionToken,
} from "@/lib/security/session";

const NOW = new Date("2026-10-10T12:00:00Z");
const secret = randomBytes(32);

describe("session tokens", () => {
  it("accepts its own token until it expires", () => {
    const token = createSessionToken(secret, "pwv-1", 3600, NOW);
    expect(verifySessionToken(token, secret, "pwv-1", NOW)).toBe(true);
    expect(verifySessionToken(token, secret, "pwv-1", new Date(NOW.getTime() + 3599_000))).toBe(true);
    expect(verifySessionToken(token, secret, "pwv-1", new Date(NOW.getTime() + 3600_000))).toBe(false);
  });

  it("refuses a token after the password changed, under another secret, or tampered with", () => {
    const token = createSessionToken(secret, "pwv-1", 3600, NOW);
    expect(verifySessionToken(token, secret, "pwv-2", NOW)).toBe(false);
    expect(verifySessionToken(token, randomBytes(32), "pwv-1", NOW)).toBe(false);
    const [body, mac] = token.split(".") as [string, string];
    const longer = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: 9_999_999_999, pwv: "pwv-1" })).toString("base64url");
    expect(verifySessionToken(`${longer}.${mac}`, secret, "pwv-1", NOW)).toBe(false);
    expect(verifySessionToken(`${body}.${mac.slice(0, -2)}AA`, secret, "pwv-1", NOW)).toBe(false);
    for (const bad of ["", "x", "a.b.c", `${body}.`, `.${mac}`, `${body}.${mac}!`, "a".repeat(600)]) expect(verifySessionToken(bad, secret, "pwv-1", NOW)).toBe(false);
    expect(verifySessionToken(null, secret, "pwv-1", NOW)).toBe(false);
  });

  it("refuses a token issued in the future", () => {
    const token = createSessionToken(secret, "pwv-1", 3600, new Date(NOW.getTime() + 3600_000));
    expect(verifySessionToken(token, secret, "pwv-1", NOW)).toBe(false);
  });
});

describe("session generation (sign out everywhere)", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jr-session-gen-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a token is valid for the generation it was issued in only", () => {
    const token = createSessionToken(secret, "pwv-1", 3600, NOW, 3);
    expect(verifySessionToken(token, secret, "pwv-1", NOW, 3)).toBe(true);
    expect(verifySessionToken(token, secret, "pwv-1", NOW, 4)).toBe(false);
  });

  it("a token from before generations existed counts as generation 0 (no forced sign-out on upgrade)", () => {
    const legacy = createSessionToken(secret, "pwv-1", 3600, NOW);
    expect(verifySessionToken(legacy, secret, "pwv-1", NOW, 0)).toBe(true);
    expect(verifySessionToken(legacy, secret, "pwv-1", NOW, 1)).toBe(false);
  });

  it("starts at 0 without a file; a bump writes the next one (mode 0600) and ends older sessions", () => {
    expect(readSessionGeneration(dir)).toBe(0);
    const before = createSessionToken(secret, "pwv-1", 3600, NOW, readSessionGeneration(dir));
    expect(bumpSessionGeneration(dir)).toBe(1);
    expect(readSessionGeneration(dir)).toBe(1);
    const file = path.join(dir, SESSION_GENERATION_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(verifySessionToken(before, secret, "pwv-1", NOW, readSessionGeneration(dir))).toBe(false);
    expect(bumpSessionGeneration(dir)).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([SESSION_GENERATION_FILE]);
  });

  it("an unreadable generation file fails closed (no session is valid)", () => {
    fs.writeFileSync(path.join(dir, SESSION_GENERATION_FILE), "not a number\n");
    expect(() => readSessionGeneration(dir)).toThrow();
  });

  it("a bump over a corrupt file never restarts the count low: it jumps past anything the file held and past now", () => {
    const file = path.join(dir, SESSION_GENERATION_FILE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // a half-written or hand-edited file that had reached generation 7
    fs.writeFileSync(file, "7x\n");
    const tokenOfSeven = createSessionToken(secret, "pwv-1", 3600, NOW, 7);
    const before = Date.now();
    const next = bumpSessionGeneration(dir);
    expect(next).toBeGreaterThan(7);
    expect(next).toBeGreaterThanOrEqual(before);
    expect(readSessionGeneration(dir)).toBe(next);
    expect(verifySessionToken(tokenOfSeven, secret, "pwv-1", NOW, readSessionGeneration(dir))).toBe(false);
    // a recognisable number above the clock wins
    fs.writeFileSync(file, "garbage 900000000000000");
    expect(bumpSessionGeneration(dir)).toBe(900000000000001);
    expect(bumpSessionGeneration(dir)).toBe(900000000000002);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a generation file that cannot be read at all: the bump refuses instead of guessing", () => {
    const file = path.join(dir, SESSION_GENERATION_FILE);
    fs.mkdirSync(file);
    expect(() => bumpSessionGeneration(dir)).toThrow();
  });
});

describe("cookie name", () => {
  it("__Host- prefixed over https, the plain name over http", () => {
    expect(sessionCookieName(true)).toBe(SECURE_SESSION_COOKIE);
    expect(SECURE_SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    expect(sessionCookieName(false)).toBe(SESSION_COOKIE);
    expect(isHttpsRequest(new Headers({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(isHttpsRequest(new Headers({ "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(isHttpsRequest(new Headers({ "x-forwarded-proto": "http" }))).toBe(false);
    expect(isHttpsRequest(new Headers({}))).toBe(false);
  });
});

describe("session secret", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jr-session-"));
    resetSessionSecretCache();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resetSessionSecretCache();
  });

  it("creates the secret file on first use with mode 0600 and reuses it", () => {
    const first = sessionSecret(dir, {});
    const file = path.join(dir, SESSION_SECRET_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // 32 random bytes, base64url
    expect(fs.readFileSync(file, "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    resetSessionSecretCache();
    expect(sessionSecret(dir, {}).equals(first)).toBe(true);
  });

  it("keeps the file another process created first (one file, one secret)", () => {
    fs.writeFileSync(path.join(dir, SESSION_SECRET_FILE), `${"k".repeat(43)}\n`, { mode: 0o600 });
    expect(sessionSecret(dir, {}).toString("utf8")).toBe("k".repeat(43));
  });

  it.each([
    ["empty", ""],
    ["too short", "abc\n"],
  ])("replaces an %s secret file with a new one (mode 0600) and leaves no temporary file", (_label, content) => {
    const file = path.join(dir, SESSION_SECRET_FILE);
    fs.writeFileSync(file, content, { mode: 0o644 });
    const secret = sessionSecret(dir, {}).toString("utf8");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.readFileSync(file, "utf8").trim()).toBe(secret);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([SESSION_SECRET_FILE]);
  });

  it("a new secret leaves no temporary file behind", () => {
    sessionSecret(dir, {});
    expect(fs.readdirSync(dir)).toEqual([SESSION_SECRET_FILE]);
  });

  it("uses JOB_RADAR_SESSION_SECRET when it is long enough, and ignores a short one", () => {
    const long = "s".repeat(40);
    expect(sessionSecret(dir, { JOB_RADAR_SESSION_SECRET: long }).toString("utf8")).toBe(long);
    expect(fs.existsSync(path.join(dir, SESSION_SECRET_FILE))).toBe(false);
    expect(sessionSecretTooShort({ JOB_RADAR_SESSION_SECRET: "short" })).toBe(true);
    expect(sessionSecretTooShort({ JOB_RADAR_SESSION_SECRET: long })).toBe(false);
    expect(sessionSecret(dir, { JOB_RADAR_SESSION_SECRET: "short" }).toString("utf8")).not.toBe("short");
  });
});
