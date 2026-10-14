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
    files: ["e2e/**/*.ts", "e2e-setup/**/*.ts", "e2e-demo/**/*.ts"],
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
          ],
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts", "playwright-report/**", "test-results/**", ".local-demo/**", "data/**"]),
]);

export default eslintConfig;
