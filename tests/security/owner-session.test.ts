// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ownerMayChange, ownerSessionState } from "@/lib/security/owner-session";
import { passwordVersion, readPasswordSetting } from "@/lib/security/password";
import { createSessionToken, resetSessionSecretCache, SECURE_SESSION_COOKIE, SESSION_COOKIE, sessionSecret } from "@/lib/security/session";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const PASSWORD = "a long test password";
const NOW = new Date("2026-11-11T10:00:00Z");
const LOCAL = { host: "127.0.0.1:3000" };
const REMOTE = { host: "box.example-tailnet.ts.net", "x-forwarded-for": "100.64.0.2", "x-forwarded-proto": "https" };
const BASE_ENV = { JOB_RADAR_WEB_BIND: "127.0.0.1", JOB_RADAR_SESSION_SECRET: "" };

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  resetSessionSecretCache();
});
afterEach(() => {
  tmp.cleanup();
  resetSessionSecretCache();
});

function cookies(values: Record<string, string>) {
  return { get: (name: string) => (name in values ? { value: values[name]! } : undefined) };
}

function token(env: Record<string, string>, maxAgeSeconds = 3600, issued = NOW): string {
  const setting = readPasswordSetting(env);
  if (setting === null) throw new Error("no password");
  const secret = sessionSecret(tmp.configDir, env);
  return createSessionToken(secret, passwordVersion(setting, secret), maxAgeSeconds, issued);
}

describe("ownerSessionState", () => {
  it("no password: nothing to log in to, changes are allowed", () => {
    const state = ownerSessionState(new Headers(LOCAL), cookies({}), BASE_ENV, NOW);
    expect(state).toBe("no_password");
    expect(ownerMayChange(state)).toBe(true);
  });

  it("a password and a local request without a session: login required, although the page itself needs no login", () => {
    const env = { ...BASE_ENV, JOB_RADAR_WEB_PASSWORD: PASSWORD };
    const state = ownerSessionState(new Headers(LOCAL), cookies({}), env, NOW);
    expect(state).toBe("login_required");
    expect(ownerMayChange(state)).toBe(false);
  });

  it("a valid session, local or from elsewhere: allowed", () => {
    const env = { ...BASE_ENV, JOB_RADAR_WEB_PASSWORD: PASSWORD };
    expect(ownerSessionState(new Headers(LOCAL), cookies({ [SESSION_COOKIE]: token(env) }), env, NOW)).toBe("ok");
    expect(ownerSessionState(new Headers(REMOTE), cookies({ [SECURE_SESSION_COOKIE]: token(env) }), env, NOW)).toBe("ok");
  });

  it("an expired session, a forged one or one for another password: login required", () => {
    const env = { ...BASE_ENV, JOB_RADAR_WEB_PASSWORD: PASSWORD };
    const expired = token(env, 60, new Date(NOW.getTime() - 3_600_000));
    expect(ownerSessionState(new Headers(LOCAL), cookies({ [SESSION_COOKIE]: expired }), env, NOW)).toBe("login_required");
    expect(ownerSessionState(new Headers(LOCAL), cookies({ [SESSION_COOKIE]: "forged.value" }), env, NOW)).toBe("login_required");
    const other = token({ ...env, JOB_RADAR_WEB_PASSWORD: "another long password" });
    expect(ownerSessionState(new Headers(LOCAL), cookies({ [SESSION_COOKIE]: other }), env, NOW)).toBe("login_required");
  });

  it("with the local exemption switched off the answer is the same", () => {
    const env = { ...BASE_ENV, JOB_RADAR_WEB_PASSWORD: PASSWORD, JOB_RADAR_WEB_LOCAL_LOGIN: "1" };
    expect(ownerSessionState(new Headers(LOCAL), cookies({}), env, NOW)).toBe("login_required");
    expect(ownerSessionState(new Headers(LOCAL), cookies({ [SESSION_COOKIE]: token(env) }), env, NOW)).toBe("ok");
  });
});
