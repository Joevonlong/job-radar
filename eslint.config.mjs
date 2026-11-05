import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The read-only psql runner shells out to docker: only scripts may import it (nothing in the web or runner builds).
const READONLY_PSQL_PATTERN = {
  group: ["@/lib/db/readonly-psql", "@/lib/db/readonly-psql.ts", "**/readonly-psql", "**/readonly-psql.ts"],
  message: "src/lib/db/readonly-psql.ts is for scripts/ only: it runs docker, and must not reach the web or runner builds.",
};
const READONLY_PSQL_DYNAMIC = {
  selector: "ImportExpression[source.value=/readonly-psql(\\.ts)?$/]",
  message: "src/lib/db/readonly-psql.ts is for scripts/ only: it runs docker, and must not reach the web or runner builds.",
};

export const CORE_IMPORTING_CAREER = {};
export const ENGINE_FORBIDDEN_GLOBALS = [
  "Buffer", "process", "__dirname", "__filename", "require", "fetch", "XMLHttpRequest", "WebSocket",
];

const CAREER_PATTERN = {
  group: ["@/lib/career", "@/lib/career/*", "@/components/career", "@/components/career/*", "@/app/career", "@/app/career/*", "@/app/api/career", "@/app/api/career/*", "@/career-pdf", "@/career-pdf/*"],
  message: "Core code must not import the career module; keep its consumers inside the module.",
  allowTypeImports: false,
};
const CAREER_DYNAMIC = {
  selector: "ImportExpression[source.value=/^@\\/(lib\\/career|components\\/career|app\\/career|app\\/api\\/career|career-pdf)(\\/|$)/]",
  message: CAREER_PATTERN.message,
};
const DATABASE_PATHS = [
  { name: "drizzle-orm", message: "Import database packages only in src/lib/db/; use its queries or repos elsewhere.", allowTypeImports: false },
  { name: "postgres", message: "Import database packages only in src/lib/db/; use its queries or repos elsewhere.", allowTypeImports: false },
];
const DATABASE_PATTERN = {
  group: ["drizzle-orm/*"],
  message: DATABASE_PATHS[0].message,
  allowTypeImports: false,
};
const DATABASE_DYNAMIC = {
  selector: "ImportExpression[source.value=/^(drizzle-orm|postgres)(\\/.*)?$/]",
  message: DATABASE_PATHS[0].message,
};
/** @param {Record<string, unknown>} coreFiles */
export function careerFiles(coreFiles) {
  return [
    "src/lib/career/**",
    "src/components/career/**",
    "src/app/career/**",
    "src/app/api/career/**",
    "src/career-pdf/**",
    ...Object.keys(coreFiles).map((file) => file.replace(/[\[\]]/g, "\\$&")),
  ];
}

const CAREER_FILES = careerFiles(CORE_IMPORTING_CAREER);

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
          patterns: [READONLY_PSQL_PATTERN],
        },
      ],
      // import("@playwright/test") is an ImportExpression, which no-restricted-imports does not see
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^(@playwright\\/test|playwright|playwright-core)$/]",
          message: "Import Playwright through e2e/fixtures.ts, not with a dynamic import (the guarded `test` waits for in-flight Server Actions).",
        },
        READONLY_PSQL_DYNAMIC,
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
          paths: DATABASE_PATHS,
          patterns: [
            DATABASE_PATTERN,
            READONLY_PSQL_PATTERN,
            CAREER_PATTERN,
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        DATABASE_DYNAMIC,
        READONLY_PSQL_DYNAMIC,
        CAREER_DYNAMIC,
      ],
    },
  },
  {
    // the rest of the repository except scripts/ (e2e/ and src/ outside src/lib/db/ have it in their blocks above)
    files: ["**/*.{ts,tsx,mts,js,mjs}"],
    ignores: ["scripts/**", "src/**", "e2e/**", "e2e-setup/**", "e2e-demo/**", "tests/pipeline/readonly-psql.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [READONLY_PSQL_PATTERN] }],
      "no-restricted-syntax": ["error", READONLY_PSQL_DYNAMIC],
    },
  },
  {
    files: ["src/lib/db/**/*.{ts,tsx,mts,js}"],
    ignores: ["src/lib/db/readonly-psql.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [READONLY_PSQL_PATTERN, CAREER_PATTERN] }],
      "no-restricted-syntax": ["error", READONLY_PSQL_DYNAMIC, CAREER_DYNAMIC],
    },
  },
  {
    files: CAREER_FILES,
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: DATABASE_PATHS, patterns: [DATABASE_PATTERN, READONLY_PSQL_PATTERN] }],
      "no-restricted-syntax": ["error", DATABASE_DYNAMIC, READONLY_PSQL_DYNAMIC],
    },
  },
  {
    files: ["src/lib/career/engine/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: DATABASE_PATHS,
        patterns: [DATABASE_PATTERN, READONLY_PSQL_PATTERN, {
          regex: "^(?!(?:yaml|zod|unpdf)$|\\.{1,2}/|@/lib/career/engine/)",
          message: "The engine may import only its own modules, yaml, zod and unpdf.",
          allowTypeImports: false,
        }],
      }],
      "no-restricted-syntax": ["error", DATABASE_DYNAMIC, READONLY_PSQL_DYNAMIC,
        { selector: "ImportExpression", message: "The engine uses static imports only." },
        { selector: "MetaProperty", message: "The engine must not depend on its runtime location." },
        { selector: "CallExpression[callee.name='require']", message: "The engine uses static imports only." },
        { selector: "TSImportEqualsDeclaration", message: "The engine uses static imports only." },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "The engine receives dates from its caller." },
        { selector: "CallExpression[callee.name='Date']", message: "The engine receives dates from its caller." },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: "The engine receives dates from its caller." },
      ],
      "no-restricted-globals": ["error", ...ENGINE_FORBIDDEN_GLOBALS],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts", "playwright-report/**", "test-results/**", ".local-demo/**", "data/**"]),
]);

export default eslintConfig;
