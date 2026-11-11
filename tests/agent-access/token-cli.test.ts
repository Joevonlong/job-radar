// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PERMISSION_PRESETS, PERMISSIONS } from "@/lib/agent-access/permissions";
import { endOfDayInZone, EXIT_FAILED, EXIT_OK, EXIT_USAGE, parsePermissionList, redact, runAgentToken, type AgentTokenCliInput } from "@/lib/agent-access/token-cli";
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

async function runWith(argv: string[], overrides: Partial<Pick<AgentTokenCliInput, "timezone" | "t" | "generate">> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAgentToken({
    db: {} as Executor, argv, now: () => NOW, timezone: () => "Europe/Berlin", t,
    out: (line) => out.push(line), err: (line) => err.push(line), generate: () => SENTINEL, ...overrides,
  });
  return { code, out, err };
}

const run = (...argv: string[]) => runWith(argv);

function expectNoSecret(lines: string[]) {
  const text = lines.join("\n");
  expect(text).not.toContain(SENTINEL.secret);
  expect(text).not.toContain(SENTINEL.secret.slice("jrat_".length));
  expect(text).not.toContain(SENTINEL.secret.slice(SENTINEL.prefix.length));
}

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.findUnrevokedAgentTokens.mockResolvedValue([]);
  repo.insertAgentToken.mockImplementation(async (_db, token) => summary({ name: token.name, tokenPrefix: token.tokenPrefix, permissions: [...(token.permissions ?? [])], expiresAt: token.expiresAt ?? null }));
});

describe("redact", () => {
  it("removes every token-shaped substring, including embedded tokens and long partial copies", () => {
    const partial = `jrat_${"A_-9".repeat(5)}`;
    expect(redact(`before (${SENTINEL.secret}) / ${partial} / ${SENTINEL.secret} after`)).toBe("before (<redacted>) / <redacted> / <redacted> after");
    expect(redact(SENTINEL.secret)).toBe("<redacted>");
  });

  it("preserves display prefixes and text below the token-shaped threshold", () => {
    const text = `laptop ${SENTINEL.prefix} jrat_${"a".repeat(19)}`;
    expect(redact(text)).toBe(text);
  });
});

describe("sensitive arguments", () => {
  it.each([
    ["revoke token", ["revoke", SENTINEL.secret]],
    ["revoke embedded token", ["revoke", `device (${SENTINEL.secret})`]],
    ["token name", ["create", "--name", SENTINEL.secret, "--permissions", "jobs:read"]],
    ["embedded token name", ["create", "--name", `old (${SENTINEL.secret})`, "--permissions", "jobs:read"]],
    ["token permission", ["create", "--name", "laptop", "--permissions", SENTINEL.secret]],
    ["mixed invalid permissions", ["create", "--name", "laptop", "--permissions", `foo,${SENTINEL.secret}`]],
    ["token expiry", ["create", "--name", "laptop", "--permissions", "jobs:read", "--expires", SENTINEL.secret]],
  ])("rejects %s without exposing it or accessing the repository", async (_label, argv) => {
    const { code, out, err } = await run(...argv);
    expectNoSecret([...out, ...err]);
    expect(code).toBe(EXIT_USAGE);
    expect(out).toEqual([]);
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["create", "--name", `jrat_${"a".repeat(20)}`, "--permissions", "jobs:read"],
    ["revoke", `device jrat_${"a".repeat(20)}`],
  ])("rejects long partial copies in %s before accessing the repository", async (...argv) => {
    const { code, out, err } = await run(...argv);
    expect(code).toBe(EXIT_USAGE);
    expect([...out, ...err].join("\n")).not.toContain(`jrat_${"a".repeat(20)}`);
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["create", `--${SENTINEL.secret}`],
    ["create", `--unknown=${SENTINEL.secret}`],
    ["create", "--name", `--${SENTINEL.secret}`],
    ["create", SENTINEL.secret],
    ["list", SENTINEL.secret],
    ["list", `--${SENTINEL.secret}`],
    ["revoke", `--${SENTINEL.secret}`],
    ["revoke", "laptop", SENTINEL.secret],
    [SENTINEL.secret],
  ])("prints only usage for malformed %s arguments", async (...argv) => {
    const result = await run(...argv);
    expectNoSecret([...result.out, ...result.err]);
    expect(result).toEqual({ code: EXIT_USAGE, out: [], err: [t("usage")] });
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });

  it("redacts invalid permission items while preserving useful error context on one line", async () => {
    const { code, out, err } = await run("create", "--name", "laptop", "--permissions", `foo,\n(${SENTINEL.secret})`);
    expect(code).toBe(EXIT_USAGE);
    expectNoSecret([...out, ...err]);
    expect(err[0]).toBe(t("permissionsInvalid", { invalid: "foo, (<redacted>)" }));
  });
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
    const { code, err } = await run("create", "--name", "phone", "--permissions", "read_only", "--expires", "2026-12-31");
    expect(code).toBe(EXIT_OK);
    expect(repo.insertAgentToken.mock.calls[0]?.[1].expiresAt).toEqual(new Date("2026-12-31T23:00:00Z"));
    expect(err[0]).toBe(t("created", { name: "phone", prefix: SENTINEL.prefix, permissions: PERMISSION_PRESETS.read_only.join(", "), expires: "2027-01-01 00:00", zone: "Europe/Berlin" }));
  });

  it.each(["en", "zh"] as const)("omits the timezone when a token never expires in %s", async (locale) => {
    const localT = translatorFor(locale, "cli.agentToken");
    const { code, err } = await runWith(["create", "--name", "laptop", "--permissions", "jobs:read"], { t: localT });
    expect(code).toBe(EXIT_OK);
    expect(err[0]).toBe(localT("createdNoExpiry", { name: "laptop", prefix: SENTINEL.prefix, permissions: "jobs:read" }));
    expect(err.join("\n")).not.toContain("Europe/Berlin");
  });

  it.each([{ expiryArgs: [] }, { expiryArgs: ["--expires", "2026-12-31"] }])("resolves the timezone once before generating or inserting with $expiryArgs", async ({ expiryArgs }) => {
    const timezone = vi.fn(() => "Europe/Berlin");
    const generate = vi.fn(() => {
      expect(timezone).toHaveBeenCalledExactlyOnceWith();
      expect(repo.insertAgentToken).not.toHaveBeenCalled();
      return SENTINEL;
    });
    const { code } = await runWith(["create", "--name", "laptop", "--permissions", "jobs:read", ...expiryArgs], { timezone, generate });
    expect(code).toBe(EXIT_OK);
    expect(timezone).toHaveBeenCalledExactlyOnceWith();
    expect(generate).toHaveBeenCalledExactlyOnceWith();
    expect(repo.insertAgentToken).toHaveBeenCalledTimes(1);
  });

  it("propagates a timezone failure before generating, inserting or printing a token", async () => {
    const failure = new Error("timezone unavailable");
    const generate = vi.fn(() => SENTINEL);
    const out = vi.fn();
    const err = vi.fn();
    await expect(runAgentToken({
      db: {} as Executor, argv: ["create", "--name", "laptop", "--permissions", "jobs:read"], now: () => NOW, t,
      timezone: () => { throw failure; }, generate, out, err,
    })).rejects.toBe(failure);
    expect(generate).not.toHaveBeenCalled();
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it("redacts and flattens the name returned by the repository in the creation message", async () => {
    repo.insertAgentToken.mockResolvedValue(summary({ name: `old\n(${SENTINEL.secret})` }));
    const { code, err } = await run("create", "--name", "laptop", "--permissions", "jobs:read");
    expect(code).toBe(EXIT_OK);
    expectNoSecret(err);
    expect(err[0]).toBe(t("createdNoExpiry", { name: "old (<redacted>)", prefix: "jrat_AAAAAAAA", permissions: "jobs:read" }));
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
  it.each(["en", "zh"] as const)("redacts stored names and distinguishes unused, no expiry and no permissions in %s", async (locale) => {
    const localT = translatorFor(locale, "cli.agentToken");
    repo.listAgentTokens.mockResolvedValue([summary({ name: `old\n(${SENTINEL.secret})`, permissions: [] })]);
    const { code, out, err } = await runWith(["list"], { t: localT });
    expect(code).toBe(EXIT_OK);
    expectNoSecret([...out, ...err]);
    expect(out).toEqual([localT("row", {
      prefix: "jrat_AAAAAAAA", name: "old (<redacted>)", state: localT("state.active"), created: "2026-11-11 13:00",
      used: locale === "zh" ? "从未" : "never", expires: locale === "zh" ? "永不" : "never", permissions: locale === "zh" ? "没有" : "none",
    })]);
  });

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
  it("accepts the display prefix while redacting a previously stored token-shaped name", async () => {
    repo.findUnrevokedAgentTokens.mockResolvedValue([summary({ name: `old\n(${SENTINEL.secret})`, tokenPrefix: SENTINEL.prefix })]);
    repo.revokeAgentToken.mockResolvedValue(true);
    const { code, out, err } = await run("revoke", SENTINEL.prefix);
    expect(code).toBe(EXIT_OK);
    expect(repo.findUnrevokedAgentTokens).toHaveBeenCalledWith(expect.anything(), SENTINEL.prefix);
    expect(repo.revokeAgentToken).toHaveBeenCalledWith(expect.anything(), 1, NOW);
    expectNoSecret([...out, ...err]);
    expect(err).toEqual([t("revoked", { name: "old (<redacted>)", prefix: SENTINEL.prefix })]);
  });

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
