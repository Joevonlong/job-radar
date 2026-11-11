// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PERMISSION_PRESETS, PERMISSIONS } from "@/lib/agent-access/permissions";
import { endOfDayInZone, EXIT_FAILED, EXIT_OK, EXIT_USAGE, parsePermissionList, runAgentToken } from "@/lib/agent-access/token-cli";
import { generateAgentToken } from "@/lib/agent-access/tokens";
import type { Executor } from "@/lib/db/executor";
import type { AgentTokenSummary, NewAgentToken } from "@/lib/db/repos/agent-tokens";
import { translatorFor } from "@/lib/i18n/node";

const repo = vi.hoisted(() => ({
  insertAgentToken: vi.fn<(db: unknown, token: NewAgentToken) => Promise<AgentTokenSummary | null>>(),
  listAgentTokens: vi.fn<(db: unknown) => Promise<AgentTokenSummary[]>>(),
  findUnrevokedAgentTokens: vi.fn<(db: unknown, key: string) => Promise<AgentTokenSummary[]>>(),
  revokeAgentToken: vi.fn<(db: unknown, id: number, at: Date) => Promise<boolean>>(),
}));
vi.mock("@/lib/db/repos/agent-tokens", () => repo);

const NOW = new Date("2026-11-11T12:00:00Z");
const SENTINEL = generateAgentToken(() => Buffer.alloc(32, 0x5e));
const t = translatorFor("en", "cli.agentToken");

function summary(overrides: Partial<AgentTokenSummary> = {}): AgentTokenSummary {
  return {
    id: 1, name: "laptop", tokenPrefix: "jrat_AAAAAAAA", permissions: ["jobs:read"], autoApprove: false,
    expiresAt: null, createdAt: NOW, lastUsedAt: null, revokedAt: null, ...overrides,
  };
}

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAgentToken({
    db: {} as Executor, argv, now: () => NOW, timezone: () => "Europe/Berlin", t,
    out: (line) => out.push(line), err: (line) => err.push(line), generate: () => SENTINEL,
  });
  return { code, out, err };
}

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.insertAgentToken.mockImplementation(async (_db, token) => summary({ name: token.name, tokenPrefix: token.tokenPrefix, permissions: [...(token.permissions ?? [])], expiresAt: token.expiresAt ?? null }));
});

describe("parsePermissionList", () => {
  it("takes permission and preset names, comma-separated or repeated, in the order of the permission list", () => {
    expect(parsePermissionList(["tracking:read,jobs:read", " notes:write "])).toEqual({ ok: true, permissions: ["jobs:read", "tracking:read", "notes:write"] });
    expect(parsePermissionList(["read_only"])).toEqual({ ok: true, permissions: [...PERMISSION_PRESETS.read_only] });
    expect(parsePermissionList(["all"])).toEqual({ ok: true, permissions: [...PERMISSIONS] });
    expect(parsePermissionList(["read_only,raw:read"])).toMatchObject({ ok: true, permissions: expect.arrayContaining(["raw:read", "jobs:read"]) });
  });
  it("names every value it does not know, and refuses an empty list", () => {
    expect(parsePermissionList(["jobs:read,jobs:delete", "everything"])).toEqual({ ok: false, invalid: ["jobs:delete", "everything"] });
    expect(parsePermissionList([" , "])).toEqual({ ok: false, invalid: [] });
  });
});

describe("endOfDayInZone", () => {
  it.each([
    ["2026-12-31", "Europe/Berlin", "2026-12-31T23:00:00.000Z"],
    ["2026-07-01", "Europe/Berlin", "2026-07-01T22:00:00.000Z"],
    ["2026-03-28", "Europe/Berlin", "2026-03-28T23:00:00.000Z"],
    ["2026-03-29", "Europe/Berlin", "2026-03-29T22:00:00.000Z"],
    ["2026-12-31", "UTC", "2027-01-01T00:00:00.000Z"],
    ["2026-12-31", "Asia/Shanghai", "2026-12-31T16:00:00.000Z"],
    ["2026-12-31", "America/New_York", "2027-01-01T05:00:00.000Z"],
  ])("%s in %s ends at %s", (day, zone, instant) => {
    expect(endOfDayInZone(day, zone).toISOString()).toBe(instant);
  });
});

describe("create", () => {
  it("prints the token alone on standard output, once, and stores only its hash and prefix", async () => {
    const { code, out, err } = await run("create", "--name", "laptop", "--permissions", "tracking:read,jobs:read");
    expect(code).toBe(EXIT_OK);
    expect(out).toEqual([SENTINEL.secret]);
    expect(err.join("\n")).not.toContain(SENTINEL.secret);
    expect(err.join("\n")).not.toContain(SENTINEL.hash);
    expect(err.join("\n")).toContain(SENTINEL.prefix);
    expect(repo.insertAgentToken).toHaveBeenCalledWith(expect.anything(), {
      name: "laptop", tokenHash: SENTINEL.hash, tokenPrefix: SENTINEL.prefix, permissions: ["jobs:read", "tracking:read"], expiresAt: null,
    });
    expect(JSON.stringify(repo.insertAgentToken.mock.calls)).not.toContain(SENTINEL.secret);
  });

  it("stores the end of the expiry day in the installation's time zone", async () => {
    const { code } = await run("create", "--name", "phone", "--permissions", "read_only", "--expires", "2026-12-31");
    expect(code).toBe(EXIT_OK);
    expect(repo.insertAgentToken.mock.calls[0]?.[1].expiresAt).toEqual(new Date("2026-12-31T23:00:00Z"));
  });

  it("lists the valid permissions and presets for an unknown one, creating nothing", async () => {
    const { code, out, err } = await run("create", "--name", "x", "--permissions", "jobs:read,jobs:delete");
    expect(code).toBe(EXIT_USAGE);
    expect(out).toEqual([]);
    expect(err[0]).toContain("jobs:delete");
    expect(err[1]).toContain("read_only, assistant, all");
    expect(err[1]).toContain(PERMISSIONS.join(", "));
    expect(repo.insertAgentToken).not.toHaveBeenCalled();
  });

  it.each([
    [["create", "--permissions", "jobs:read"], "nameInvalid"],
    [["create", "--name", "   ", "--permissions", "jobs:read"], "nameInvalid"],
    [["create", "--name", "a\u0007b", "--permissions", "jobs:read"], "nameInvalid"],
    [["create", "--name", "x".repeat(65), "--permissions", "jobs:read"], "nameInvalid"],
    [["create", "--name", "x"], "permissionsMissing"],
    [["create", "--name", "x", "--permissions", "jobs:read", "--expires", "31.12.2026"], "expiresInvalid"],
    [["create", "--name", "x", "--permissions", "jobs:read", "--expires", "2026-02-30"], "expiresInvalid"],
    [["create", "--name", "x", "--permissions", "jobs:read", "--expires", "2026-11-10"], "expiresPast"],
    [["create", "--name", "x", "--permissions", "jobs:read", "--auto-approve"], "usage"],
    [["create", "extra", "--name", "x", "--permissions", "jobs:read"], "usage"],
  ] as const)("refuses %j with %s", async (argv, key) => {
    const { code, out, err } = await run(...argv);
    expect(code).toBe(EXIT_USAGE);
    expect(out).toEqual([]);
    expect(err[0]).toBe(t(key, { max: 64 }));
    expect(repo.insertAgentToken).not.toHaveBeenCalled();
  });

  it("refuses a name that a token not yet revoked has, printing no token", async () => {
    repo.insertAgentToken.mockResolvedValue(null);
    const { code, out, err } = await run("create", "--name", "laptop", "--permissions", "jobs:read");
    expect(code).toBe(EXIT_FAILED);
    expect(out).toEqual([]);
    expect(err).toEqual([t("nameTaken", { name: "laptop" })]);
  });
});

describe("list", () => {
  it("shows prefix, name, state, times and permissions, never a hash", async () => {
    repo.listAgentTokens.mockResolvedValue([
      summary(),
      summary({ id: 2, name: "old", tokenPrefix: "jrat_BBBBBBBB", revokedAt: NOW, lastUsedAt: new Date("2026-11-10T08:30:00Z") }),
      summary({ id: 3, name: "tmp", tokenPrefix: "jrat_CCCCCCCC", expiresAt: new Date("2026-11-01T00:00:00Z"), permissions: ["jobs:read", "gone:read"] }),
    ]);
    const { code, out, err } = await run("list");
    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([t("listHeader", { zone: "Europe/Berlin" })]);
    expect(out).toEqual([
      "jrat_AAAAAAAA  laptop  active  created 2026-11-11 13:00  last used never  expires never  permissions: jobs:read",
      "jrat_BBBBBBBB  old  revoked  created 2026-11-11 13:00  last used 2026-11-10 09:30  expires never  permissions: jobs:read",
      "jrat_CCCCCCCC  tmp  expired  created 2026-11-11 13:00  last used never  expires 2026-11-01 01:00  permissions: jobs:read",
    ]);
  });

  it("says when there are none", async () => {
    repo.listAgentTokens.mockResolvedValue([]);
    expect(await run("list")).toEqual({ code: EXIT_OK, out: [], err: [t("empty")] });
  });
});

describe("revoke", () => {
  it("revokes the one token not yet revoked with that name or prefix", async () => {
    repo.findUnrevokedAgentTokens.mockResolvedValue([summary({ id: 4 })]);
    repo.revokeAgentToken.mockResolvedValue(true);
    const { code, err } = await run("revoke", " laptop ");
    expect(code).toBe(EXIT_OK);
    expect(repo.findUnrevokedAgentTokens).toHaveBeenCalledWith(expect.anything(), "laptop");
    expect(repo.revokeAgentToken).toHaveBeenCalledWith(expect.anything(), 4, NOW);
    expect(err).toEqual([t("revoked", { name: "laptop", prefix: "jrat_AAAAAAAA" })]);
  });

  it("refuses when nothing or more than one token matches", async () => {
    repo.findUnrevokedAgentTokens.mockResolvedValueOnce([]);
    expect((await run("revoke", "nope")).code).toBe(EXIT_FAILED);
    repo.findUnrevokedAgentTokens.mockResolvedValueOnce([summary(), summary({ id: 2, tokenPrefix: "jrat_BBBBBBBB" })]);
    const ambiguous = await run("revoke", "laptop");
    expect(ambiguous.code).toBe(EXIT_FAILED);
    expect(ambiguous.err[0]).toContain("jrat_AAAAAAAA, jrat_BBBBBBBB");
    expect(repo.revokeAgentToken).not.toHaveBeenCalled();
  });

  it.each([[["revoke"]], [["revoke", "a", "b"]], [["rotate"]], [[]]])("prints the usage for %j", async (argv) => {
    expect(await run(...argv)).toEqual({ code: EXIT_USAGE, out: [], err: [t("usage")] });
  });
});
