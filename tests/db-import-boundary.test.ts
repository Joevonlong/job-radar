// @vitest-environment node
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: ROOT });
const RULES = ["@typescript-eslint/no-restricted-imports", "no-restricted-syntax"];
const MODULES = [
  { source: "drizzle-orm", value: "sql", type: "SQL" },
  { source: "drizzle-orm/pg-core", value: "pgTable", type: "PgColumn" },
  { source: "postgres", value: "default", type: "Sql" },
];

function imports(source: string, value: string, type: string): string[] {
  return [
    `import { ${value} as database } from "${source}";\nexport { database };\n`,
    `import type { ${type} } from "${source}";\nexport type Connection = ${type};\n`,
    `import { type ${type} } from "${source}";\nexport type Connection = ${type};\n`,
    `export const load = () => import("${source}");\n`,
  ];
}

async function restricted(file: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  expect(result?.fatalErrorCount, file).toBe(0);
  return (result?.messages ?? []).filter((message) => message.ruleId !== null && RULES.includes(message.ruleId)).length;
}

describe("database packages stay inside src/lib/db", () => {
  it.each(MODULES)("rejects static, type-only and dynamic imports of $source outside db", async ({ source, value, type }) => {
    for (const code of imports(source, value, type)) {
      expect(await restricted("src/lib/x.ts", code), code).toBe(1);
    }
  });

  it.each(["src/app/x.tsx", "src/runner/x.ts", "src/ai-worker/x.mts", "src/lib/x.js"])("covers source entry points and extensions: %s", async (file) => {
    expect(await restricted(file, 'export { sql } from "drizzle-orm";\n')).toBe(1);
    expect(await restricted(file, 'export const load = () => import("postgres");\n')).toBe(1);
  });

  it("rejects nested ORM subpaths and dynamic driver subpaths", async () => {
    expect(await restricted("src/lib/x.ts", 'export { PgColumn } from "drizzle-orm/pg-core/columns/common";\n')).toBe(1);
    expect(await restricted("src/lib/x.ts", 'export const load = () => import("drizzle-orm/pg-core/columns/common");\n')).toBe(1);
    expect(await restricted("src/lib/x.ts", 'export const load = () => import("postgres/types");\n')).toBe(1);
  });

  it.each(MODULES)("allows $source throughout the database layer", async ({ source, value, type }) => {
    for (const file of ["src/lib/db/x.ts", "src/lib/db/queries/x.ts"]) {
      for (const code of imports(source, value, type)) expect(await restricted(file, code), `${file}: ${code}`).toBe(0);
    }
  });

  it.each(["tests/x.ts", "scripts/x.ts", "e2e/x.spec.ts", "e2e-setup/x.spec.ts", "e2e-demo/x.spec.ts"])("leaves non-source files unrestricted: %s", async (file) => {
    for (const { source, value, type } of MODULES) {
      for (const code of imports(source, value, type)) expect(await restricted(file, code), code).toBe(0);
    }
  });

  it("allows database helpers and similarly named packages", async () => {
    for (const source of ["@/lib/db", "drizzle-orm-tools", "postgresql"]) {
      expect(await restricted("src/lib/x.ts", `export * from "${source}";\n`)).toBe(0);
      expect(await restricted("src/lib/x.ts", `export const load = () => import("${source}");\n`)).toBe(0);
    }
  });
});
