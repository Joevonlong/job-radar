// @vitest-environment node
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const RULE = "@typescript-eslint/no-restricted-imports";

async function restricted(file: string, code: string): Promise<number> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return (result?.messages ?? []).filter((message) => message.ruleId === RULE).length;
}

// The e2e guard against leaving a page mid Server Action lives in e2e/fixtures.ts; lint keeps specs on it.
describe("e2e specs import test from e2e/fixtures.ts", () => {
  it("rejects `test` (or expect) from @playwright/test in every e2e directory", async () => {
    for (const file of ["e2e/x.spec.ts", "e2e-setup/x.spec.ts", "e2e-demo/x.spec.ts", "e2e/helper.ts"]) {
      expect(await restricted(file, 'import { test } from "@playwright/test";\ntest("x", () => {});\n'), file).toBe(1);
    }
    expect(await restricted("e2e/x.spec.ts", 'import { expect } from "@playwright/test";\nexpect(1).toBe(1);\n')).toBe(1);
  });

  it("allows the fixture module, type-only imports and code outside the e2e directories", async () => {
    expect(await restricted("e2e/x.spec.ts", 'import { test } from "./fixtures";\ntest("x", () => {});\n')).toBe(0);
    expect(await restricted("e2e/x.spec.ts", 'import type { Page } from "@playwright/test";\nexport const p: Page | null = null;\n')).toBe(0);
    expect(await restricted("e2e/fixtures.ts", 'import { test } from "@playwright/test";\nexport const t = test;\n')).toBe(0);
    expect(await restricted("playwright.config.ts", 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({});\n')).toBe(0);
  });
});
