// @vitest-environment node
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DISPOSABLE_POSTGRES_HELP, requireTestAdminDatabaseUrl } from "../../scripts/test-database";

const root = path.resolve(import.meta.dirname, "../..");

describe("requireTestAdminDatabaseUrl", () => {
  it("returns the first name that is set, in the order given", () => {
    const env = { E2E_ADMIN_DATABASE_URL: "postgres://a/x", DATABASE_URL: "postgres://b/x" };
    expect(requireTestAdminDatabaseUrl(env, ["E2E_ADMIN_DATABASE_URL", "DATABASE_URL"], "e2e")).toBe("postgres://a/x");
    expect(requireTestAdminDatabaseUrl({ DATABASE_URL: "postgres://b/x" }, ["E2E_ADMIN_DATABASE_URL", "DATABASE_URL"], "e2e")).toBe("postgres://b/x");
  });

  it("skips blank values", () => {
    expect(requireTestAdminDatabaseUrl({ E2E_ADMIN_DATABASE_URL: "  ", DATABASE_URL: "postgres://b/x" }, ["E2E_ADMIN_DATABASE_URL", "DATABASE_URL"], "e2e")).toBe("postgres://b/x");
  });

  it("has no default: nothing set is an error that names the runner and prints the disposable container commands", () => {
    expect(() => requireTestAdminDatabaseUrl({}, ["DATABASE_URL"], "integration tests")).toThrow(/integration tests: no test database is configured \(set DATABASE_URL\)/);
    expect(() => requireTestAdminDatabaseUrl({ DATABASE_URL: "" }, ["DATABASE_URL"], "x")).toThrow(DISPOSABLE_POSTGRES_HELP);
    expect(DISPOSABLE_POSTGRES_HELP).toContain("docker run --rm -d");
    expect(DISPOSABLE_POSTGRES_HELP).toContain("export DATABASE_URL=");
  });
});

describe("scripts/e2e-prepare.ts", () => {
  function prepare(databaseName: string, ...args: string[]): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-prepare.ts", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      // the server address is unreachable on purpose: a refused name must exit before any connection is made
      env: { ...process.env, E2E_ADMIN_DATABASE_URL: "postgres://u:p@127.0.0.1:1/postgres", DATABASE_URL: `postgres://u:p@127.0.0.1:1/${databaseName}` },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it("refuses a database whose name does not start with jobradar_e2e, with or without --fresh", () => {
    for (const args of [[], ["--fresh"]]) {
      const r = prepare("jobradar", ...args);
      expect(r.status).toBe(2);
      expect(r.out).toContain("must start with jobradar_e2e");
    }
    expect(prepare("jobradar_test_abc").status).toBe(2);
  });
});
