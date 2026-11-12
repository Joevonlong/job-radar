// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentTokenAction, revokeAgentTokenAction } from "@/app/settings/agents/actions";
import { createAgentTokenFromWeb, revokeAgentTokenFromWeb, type TokenServiceDeps } from "@/lib/agent-access/token-service";
import { generateAgentToken, hashAgentToken } from "@/lib/agent-access/tokens";
import type { Executor } from "@/lib/db/executor";
import type { AgentTokenSummary, NewAgentToken } from "@/lib/db/repos/agent-tokens";
import { passwordVersion, readPasswordSetting } from "@/lib/security/password";
import { createSessionToken, resetSessionSecretCache, SESSION_COOKIE, sessionSecret } from "@/lib/security/session";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const request = vi.hoisted(() => ({ headers: new Headers(), cookies: new Map<string, string>() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/cache", () => cache);
vi.mock("next/headers", () => ({
  headers: async () => request.headers,
  cookies: async () => ({ get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined) }),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
const repo = vi.hoisted(() => ({
  insertAgentToken: vi.fn<(db: unknown, token: NewAgentToken) => Promise<AgentTokenSummary | null>>(),
  revokeAgentToken: vi.fn<(db: unknown, id: number, at: Date) => Promise<boolean>>(),
}));
vi.mock("@/lib/db/repos/agent-tokens", async (original) => ({ ...(await original<object>()), ...repo }));

const PASSWORD = "a long test password";
const NOW = new Date("2026-11-12T12:00:00Z");
const SENTINEL = generateAgentToken(() => Buffer.alloc(32, 0x7a));

let tmp: TempConfig;
const mcpFile = () => path.join(tmp.configDir, "mcp.yaml");

function signedIn() {
  const setting = readPasswordSetting(process.env);
  if (setting === null) throw new Error("no password");
  const secret = sessionSecret(tmp.configDir);
  request.cookies.set(SESSION_COOKIE, createSessionToken(secret, passwordVersion(setting, secret), 3600, new Date()));
}

function stored(token: NewAgentToken): AgentTokenSummary {
  return { id: 7, name: token.name, tokenPrefix: token.tokenPrefix, permissions: [...(token.permissions ?? [])], autoApprove: false, expiresAt: token.expiresAt ?? null, createdAt: NOW, lastUsedAt: null, revokedAt: null };
}

const deps = (overrides: Partial<TokenServiceDeps> = {}): TokenServiceDeps => ({
  db: () => ({}) as Executor,
  now: () => NOW,
  timezone: () => "Europe/Berlin",
  matrix: () => ["jobs:read", "tracking:read"],
  generate: () => SENTINEL,
  ...overrides,
});

const valid = { name: "laptop", permissions: ["jobs:read"], expires: null };

beforeEach(() => {
  tmp = makeTempConfig();
  fs.writeFileSync(mcpFile(), "config_version: 3\nenabled: true\npermissions:\n  - jobs:read\n  - tracking:read\n");
  request.headers = new Headers({ host: "127.0.0.1:3000" });
  request.cookies = new Map();
  vi.stubEnv("JOB_RADAR_WEB_BIND", "127.0.0.1");
  vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "");
  vi.stubEnv("JOB_RADAR_SESSION_SECRET", "");
  resetSessionSecretCache();
  repo.insertAgentToken.mockReset().mockImplementation(async (_db, token) => stored(token));
  repo.revokeAgentToken.mockReset().mockResolvedValue(true);
  cache.revalidatePath.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetSessionSecretCache();
  tmp.cleanup();
});

describe("the token actions and the owner session", () => {
  it("with a password set, a local request without a session can neither create nor revoke", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", PASSWORD);
    expect(await createAgentTokenAction(valid)).toEqual({ status: "session_required" });
    expect(await revokeAgentTokenAction({ id: 7 })).toEqual({ status: "session_required" });
    expect(repo.insertAgentToken).not.toHaveBeenCalled();
    expect(repo.revokeAgentToken).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("with a session, creating returns the token once and stores only its hash and prefix; revoking works", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", PASSWORD);
    signedIn();
    const result = await createAgentTokenAction(valid);
    if (result.status !== "created") throw new Error(result.status);
    expect(result.secret).toMatch(/^jrat_[A-Za-z0-9_-]{43}$/);
    expect(result.token).toEqual({ id: 7, name: "laptop", prefix: result.secret.slice(0, 13) });
    const [, row] = repo.insertAgentToken.mock.calls[0]!;
    expect(row).toEqual({ name: "laptop", tokenHash: hashAgentToken(result.secret), tokenPrefix: result.secret.slice(0, 13), permissions: ["jobs:read"], expiresAt: null });
    expect(JSON.stringify(row)).not.toContain(result.secret.slice(13));
    expect(cache.revalidatePath).toHaveBeenCalledWith("/settings/agents");
    expect(await revokeAgentTokenAction({ id: 7 })).toEqual({ status: "revoked" });
    expect(repo.revokeAgentToken).toHaveBeenCalledWith({}, 7, expect.any(Date));
  });

  it("without a password, creating is refused (tokens are for HTTP) and revoking still works", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
    expect(await createAgentTokenAction(valid)).toEqual({ status: "password_required" });
    expect(repo.insertAgentToken).not.toHaveBeenCalled();
    expect(await revokeAgentTokenAction({ id: 7 })).toEqual({ status: "revoked" });
  });

  it("revoking works while MCP and HTTP are off and while mcp.yaml cannot be read", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", PASSWORD);
    signedIn();
    fs.writeFileSync(mcpFile(), "permissions: [unterminated\n");
    expect(await revokeAgentTokenAction({ id: 7 })).toEqual({ status: "revoked" });
    expect(await createAgentTokenAction(valid)).toEqual({ status: "unreadable" });
  });

  it("refuses authorization smuggled in the arguments", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", PASSWORD);
    expect(await createAgentTokenAction({ ...valid, session: "ok" })).toEqual({ status: "invalid" });
    expect(await revokeAgentTokenAction({ id: 7, session: "ok" })).toEqual({ status: "invalid" });
    expect(repo.revokeAgentToken).not.toHaveBeenCalled();
  });
});

describe("createAgentTokenFromWeb", () => {
  it("applies the command line's name, permission and expiry rules", async () => {
    const run = (input: object) => createAgentTokenFromWeb({ ...valid, ...input }, "ok", deps());
    expect(await run({ name: "  " })).toEqual({ status: "name_invalid" });
    expect(await run({ name: "x".repeat(65) })).toEqual({ status: "name_invalid" });
    expect(await run({ name: SENTINEL.secret })).toEqual({ status: "name_invalid" });
    expect(await run({ permissions: [] })).toEqual({ status: "permissions_missing" });
    expect(await run({ permissions: ["nope"] })).toEqual({ status: "invalid" });
    expect(await run({ expires: "2026-13-01" })).toEqual({ status: "expires_invalid" });
    expect(await run({ expires: "2026-11-11" })).toEqual({ status: "expires_past" });
    expect(repo.insertAgentToken).not.toHaveBeenCalled();
    expect((await run({ expires: "2026-12-31" })).status).toBe("created");
    expect(repo.insertAgentToken.mock.calls[0]![1].expiresAt).toEqual(new Date("2026-12-31T23:00:00Z"));
  });

  it("refuses a permission the global matrix does not allow", async () => {
    expect(await createAgentTokenFromWeb({ ...valid, permissions: ["jobs:read", "config:write"] }, "ok", deps())).toEqual({ status: "not_in_matrix" });
    expect(repo.insertAgentToken).not.toHaveBeenCalled();
  });

  it("refuses a name a token that is not revoked already has", async () => {
    repo.insertAgentToken.mockResolvedValueOnce(null);
    expect(await createAgentTokenFromWeb(valid, "ok", deps())).toEqual({ status: "name_taken" });
  });

  it("a database failure is logged without the token, its hash or the request", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const spies = [vi.spyOn(console, "log").mockImplementation(capture), vi.spyOn(console, "warn").mockImplementation(capture), vi.spyOn(console, "error").mockImplementation(capture)];
    try {
      repo.insertAgentToken.mockRejectedValueOnce(Object.assign(new Error(`insert failed: ${SENTINEL.secret} ${SENTINEL.hash}`), { code: "XX000" }));
      const result = await createAgentTokenFromWeb(valid, "ok", deps());
      expect(result).toEqual({ status: "failed" });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const text = lines.join("\n");
    expect(text).toContain("createAgentToken");
    expect(text).not.toContain(SENTINEL.secret);
    expect(text).not.toContain(SENTINEL.secret.slice(13));
    expect(text).not.toContain(SENTINEL.hash);
    expect(text).not.toContain("laptop");
  });

  it("revoking an unknown or already revoked token says so", async () => {
    repo.revokeAgentToken.mockResolvedValueOnce(false);
    expect(await revokeAgentTokenFromWeb({ id: 9 }, "no_password", deps())).toEqual({ status: "not_found" });
    expect(await revokeAgentTokenFromWeb({ id: -1 }, "ok", deps())).toEqual({ status: "invalid" });
  });
});
