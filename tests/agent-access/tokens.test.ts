// @vitest-environment node
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_TOKEN_PREFIX,
  agentTokenDisplayPrefix,
  agentTokenGrantReader,
  agentTokenState,
  bearerAgentToken,
  generateAgentToken,
  hashAgentToken,
  isAgentTokenFormat,
  sameTokenHash,
  storedPermissions,
  verifyAgentToken,
} from "@/lib/agent-access/tokens";
import type { Executor } from "@/lib/db/executor";
import type { AgentTokenCredential, AgentTokenGrantRow } from "@/lib/db/repos/agent-tokens";

const repo = vi.hoisted(() => ({
  findAgentTokenCredentials: vi.fn<(db: unknown, prefix: string) => Promise<AgentTokenCredential[]>>(),
  getAgentTokenGrant: vi.fn<(db: unknown, id: number) => Promise<AgentTokenGrantRow | null>>(),
}));
vi.mock("@/lib/db/repos/agent-tokens", () => repo);

const db = {} as Executor;
const NOW = new Date("2026-11-11T12:00:00Z");
const fixed = (byte: number) => () => Buffer.alloc(32, byte);

function credential(secret: string, overrides: Partial<AgentTokenCredential> = {}): AgentTokenCredential {
  return { id: 7, tokenHash: hashAgentToken(secret), permissions: ["jobs:read", "tracking:read"], expiresAt: null, revokedAt: null, ...overrides };
}

beforeEach(() => {
  repo.findAgentTokenCredentials.mockReset();
  repo.getAgentTokenGrant.mockReset();
});

describe("generateAgentToken", () => {
  it("is the prefix and 256 random bits in base64url, with its SHA-256 hash and display prefix", () => {
    const token = generateAgentToken(fixed(0xab));
    expect(token.secret).toBe(AGENT_TOKEN_PREFIX + Buffer.alloc(32, 0xab).toString("base64url"));
    expect(token.secret).toHaveLength(AGENT_TOKEN_PREFIX.length + 43);
    expect(isAgentTokenFormat(token.secret)).toBe(true);
    expect(token.hash).toBe(createHash("sha256").update(token.secret).digest("hex"));
    expect(token.prefix).toBe(token.secret.slice(0, AGENT_TOKEN_PREFIX.length + 8));
    expect(token.secret.startsWith(token.prefix)).toBe(true);
  });

  it("draws fresh randomness each time", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateAgentToken().secret));
    expect(secrets.size).toBe(50);
  });
});

describe("token format", () => {
  const good = generateAgentToken(fixed(1)).secret;
  it.each([
    ["the wrong prefix", good.replace(AGENT_TOKEN_PREFIX, "jrx_")],
    ["one character short", good.slice(0, -1)],
    ["one character long", `${good}A`],
    ["a character outside base64url", `${good.slice(0, -1)}+`],
    ["surrounding space", ` ${good}`],
    ["empty", ""],
  ])("refuses %s", (_case, value) => {
    expect(isAgentTokenFormat(value)).toBe(false);
  });
});

describe("bearerAgentToken", () => {
  const secret = generateAgentToken(fixed(2)).secret;
  it("reads the token of a Bearer header, the scheme in any case", () => {
    expect(bearerAgentToken(`Bearer ${secret}`)).toBe(secret);
    expect(bearerAgentToken(`bearer ${secret}`)).toBe(secret);
  });
  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["another scheme", `Basic ${secret}`],
    ["the token alone", secret],
    ["two spaces", `Bearer  ${secret}`],
    ["a trailing value", `Bearer ${secret} extra`],
    ["a value that is not a token", "Bearer abc"],
  ])("returns null for %s", (_case, header) => {
    expect(bearerAgentToken(header)).toBeNull();
  });
});

describe("sameTokenHash", () => {
  const a = hashAgentToken("a");
  it("compares digests", () => {
    expect(sameTokenHash(a, hashAgentToken("a"))).toBe(true);
    expect(sameTokenHash(a, hashAgentToken("b"))).toBe(false);
  });
  it("is false for anything that is not a SHA-256 hex digest, without throwing", () => {
    expect(sameTokenHash(a, a.slice(0, 32))).toBe(false);
    expect(sameTokenHash("zz", "zz")).toBe(false);
    expect(sameTokenHash("", "")).toBe(false);
  });
});

describe("agentTokenState", () => {
  it("is revoked before expired, and expired from the expiry instant on", () => {
    expect(agentTokenState({ expiresAt: null, revokedAt: null }, NOW)).toBe("active");
    expect(agentTokenState({ expiresAt: new Date(NOW.getTime() + 1), revokedAt: null }, NOW)).toBe("active");
    expect(agentTokenState({ expiresAt: NOW, revokedAt: null }, NOW)).toBe("expired");
    expect(agentTokenState({ expiresAt: new Date(NOW.getTime() - 1), revokedAt: NOW }, NOW)).toBe("revoked");
  });
});

it("a stored permission this version does not know grants nothing", () => {
  expect(storedPermissions(["jobs:read", "jobs:delete", "TRACKING:READ", "tracking:read"])).toEqual(["jobs:read", "tracking:read"]);
});

describe("verifyAgentToken", () => {
  const secret = generateAgentToken(fixed(3)).secret;

  it("refuses a value that is not a token without touching the database", async () => {
    await expect(verifyAgentToken(db, "jrat_short", NOW)).resolves.toEqual({ ok: false, reason: "malformed" });
    expect(repo.findAgentTokenCredentials).not.toHaveBeenCalled();
  });

  it("looks rows up by display prefix only, never by the token or its hash", async () => {
    repo.findAgentTokenCredentials.mockResolvedValue([credential(secret)]);
    await verifyAgentToken(db, secret, NOW);
    expect(repo.findAgentTokenCredentials).toHaveBeenCalledWith(db, agentTokenDisplayPrefix(secret));
  });

  it("grants the matching row's permissions, dropping names it does not know", async () => {
    repo.findAgentTokenCredentials.mockResolvedValue([credential(secret, { permissions: ["jobs:read", "jobs:delete"] })]);
    await expect(verifyAgentToken(db, secret, NOW)).resolves.toEqual({ ok: true, grant: { kind: "token", tokenId: 7, permissions: ["jobs:read"] } });
  });

  it("picks the row whose hash matches when another token shares the prefix", async () => {
    repo.findAgentTokenCredentials.mockResolvedValue([credential("other", { id: 3 }), credential(secret, { id: 9 })]);
    await expect(verifyAgentToken(db, secret, NOW)).resolves.toMatchObject({ ok: true, grant: { tokenId: 9 } });
  });

  it.each([
    ["unknown", []],
    ["unknown", [credential(`${secret.slice(0, -1)}A`)]],
    ["revoked", [credential(secret, { revokedAt: new Date(NOW.getTime() - 1000) })]],
    ["expired", [credential(secret, { expiresAt: NOW })]],
  ])("refuses a token that is %s", async (reason, rows) => {
    repo.findAgentTokenCredentials.mockResolvedValue(rows);
    await expect(verifyAgentToken(db, secret, NOW)).resolves.toEqual({ ok: false, reason });
  });
});

describe("agentTokenGrantReader", () => {
  const row: AgentTokenGrantRow = { id: 4, permissions: ["tracking:read"], expiresAt: null, revokedAt: null };
  it("reads the row by id on every call and returns its current list", async () => {
    repo.getAgentTokenGrant.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, permissions: ["jobs:read"] });
    const read = agentTokenGrantReader(db, () => NOW);
    await expect(read(4)).resolves.toEqual({ kind: "token", tokenId: 4, permissions: ["tracking:read"] });
    await expect(read(4)).resolves.toEqual({ kind: "token", tokenId: 4, permissions: ["jobs:read"] });
    expect(repo.getAgentTokenGrant).toHaveBeenNthCalledWith(2, db, 4);
  });
  it.each([
    ["gone", null],
    ["revoked", { ...row, revokedAt: NOW }],
    ["expired", { ...row, expiresAt: NOW }],
  ])("returns null once the token is %s", async (_case, current) => {
    repo.getAgentTokenGrant.mockResolvedValue(current);
    await expect(agentTokenGrantReader(db, () => NOW)(4)).resolves.toBeNull();
  });
});
