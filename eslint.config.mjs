import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
    },
  },
  {
    // e2e specs take `test` from e2e/fixtures.ts: its pages never leave while a Server Action is still in flight
    files: ["e2e/**/*.{ts,tsx,mts,js}", "e2e-setup/**/*.{ts,tsx,mts,js}", "e2e-demo/**/*.{ts,tsx,mts,js}"],
    ignores: ["e2e/fixtures.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@playwright/test",
              message: "Import from e2e/fixtures.ts (same exports; its `test` waits for in-flight Server Actions before a reload or navigation).",
              allowTypeImports: true,
            },
            {
              name: "playwright",
              message: "Import from e2e/fixtures.ts (the guarded `test`); the raw Playwright API skips the Server Action wait.",
              allowTypeImports: true,
            },
            {
              name: "playwright-core",
              message: "Import from e2e/fixtures.ts (the guarded `test`); the raw Playwright API skips the Server Action wait.",
              allowTypeImports: true,
            },
          ],
        },
      ],
      // import("@playwright/test") is an ImportExpression, which no-restricted-imports does not see
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^(@playwright\\/test|playwright|playwright-core)$/]",
          message: "Import Playwright through e2e/fixtures.ts, not with a dynamic import (the guarded `test` waits for in-flight Server Actions).",
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx,mts,js}"],
    ignores: ["src/lib/db/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "drizzle-orm",
              message: "Import database packages only in src/lib/db/; use its queries or repos elsewhere.",
              allowTypeImports: false,
            },
            {
              name: "postgres",
              message: "Import database packages only in src/lib/db/; use its queries or repos elsewhere.",
              allowTypeImports: false,
            },
          ],
          patterns: [
            {
              group: ["drizzle-orm/*"],
              message: "Import database packages only in src/lib/db/; use its queries or repos elsewhere.",
              allowTypeImports: false,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^(drizzle-orm|postgres)(\\/.*)?$/]",
          message: "Import database packages only in src/lib/db/; use its queries or repos elsewhere.",
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts", "playwright-report/**", "test-results/**", ".local-demo/**", "data/**"]),
]);

export default eslintConfig;
