// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { exportQueriesForTest, PARSED_POSTINGS_QUERY, STORED_JOBS_QUERY } from "@/lib/db/queries/dedupe-snapshot";
import { psqlInvocation } from "@/lib/db/readonly-psql";

const ROOT = path.resolve(import.meta.dirname, "../..");
const eslint = new ESLint({ cwd: ROOT });

async function restricted(file: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  expect(result?.fatalErrorCount, file).toBe(0);
  return (result?.messages ?? []).filter((message) => /readonly-psql/.test(message.message)).length;
}

describe("the read-only psql runner", () => {
  it("opens a session that cannot write, for a container or a compose project", () => {
    const container = psqlInvocation({ container: "demo-db" }, "select 1");
    expect(container.args.slice(0, 4)).toEqual(["exec", "-e", "PGOPTIONS=-c default_transaction_read_only=on", "demo-db"]);
    expect(container.args.at(-1)).toBe("select 1");
    const compose = psqlInvocation({ composeDir: "/some/project" }, "select 1");
    expect(compose.cwd).toBe("/some/project");
    expect(compose.args).toEqual(expect.arrayContaining(["compose", "exec", "-T", "PGOPTIONS=-c default_transaction_read_only=on", "db"]));
    for (const verb of ["up", "down", "build", "stop", "rm"]) expect(compose.args).not.toContain(verb);
  });

  it("only sends queries that read", () => {
    for (const query of [...exportQueriesForTest(), PARSED_POSTINGS_QUERY, STORED_JOBS_QUERY]) {
      expect(query.trimStart().toLowerCase().startsWith("select")).toBe(true);
      expect(query).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|create)\b/i);
    }
  });

  it("states it is for scripts in its file header", () => {
    expect(fs.readFileSync(path.join(ROOT, "src/lib/db/readonly-psql.ts"), "utf8").split("\n")[0]).toMatch(/^\/\/ Scripts only/);
  });

  it.each([
    ["src/lib/pipeline/x.ts", 'export { runReadonlyPsql } from "@/lib/db/readonly-psql";\n'],
    ["src/lib/pipeline/x.ts", 'export { runReadonlyPsql } from "../db/readonly-psql";\n'],
    ["src/lib/db/queries/x.ts", 'export { runReadonlyPsql } from "../readonly-psql";\n'],
    ["src/app/x.tsx", 'export { runReadonlyPsql } from "@/lib/db/readonly-psql";\n'],
    ["src/runner/x.ts", 'export const load = () => import("@/lib/db/readonly-psql");\n'],
    ["src/lib/x.ts", 'export const load = () => import("./db/readonly-psql.ts");\n'],
    ["tests/x.test.ts", 'export { runReadonlyPsql } from "@/lib/db/readonly-psql";\n'],
  ])("is refused in %s: %s", async (file, code) => {
    expect(await restricted(file, code)).toBeGreaterThan(0);
  });

  it("is allowed in scripts", async () => {
    expect(await restricted("scripts/x.ts", 'export { runReadonlyPsql } from "../src/lib/db/readonly-psql";\n')).toBe(0);
  });
});
