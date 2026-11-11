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

export const CORE_IMPORTING_CAREER = {
  "src/lib/capabilities/career/check-career-document.ts": [
    "src/lib/career/render/preview.ts",
    "src/lib/career/schema/contact.ts",
  ],
  "src/lib/capabilities/career/get-career-document.ts": [
    "src/lib/career/document/redact.ts",
    "src/lib/career/document/resolve.ts",
    "src/lib/career/store/documents.ts",
    "src/lib/career/store/profile.ts",
    "src/lib/career/tailor/proposals.ts",
  ],
  "src/lib/capabilities/career/get-career-profile.ts": [
    "src/lib/career/contact/redact-profile.ts",
    "src/lib/career/store/history.ts",
    "src/lib/career/store/images.ts",
    "src/lib/career/store/profile.ts",
  ],
  "src/lib/capabilities/career/list-career-documents.ts": [
    "src/lib/career/store/documents.ts",
  ],
  "src/lib/capabilities/career/shared.ts": [
    "src/lib/career/contact/errors.ts",
    "src/lib/career/contact/scrub.ts",
    "src/lib/career/schema/document.ts",
    "src/lib/career/store/documents.ts",
    "src/lib/career/store/history.ts",
  ],
  "src/lib/mcp/dto/career.ts": [
    "src/lib/career/contact/redact-profile.ts",
    "src/lib/career/document/redact.ts",
    "src/lib/career/tailor/proposal-schema.ts",
  ],
  "src/app/jobs/[id]/page.tsx": ["src/components/career/job-entry.tsx"],
  "src/app/me/page.tsx": ["src/components/career/career-card.tsx"],
  "src/lib/control/ai-handlers.ts": ["src/lib/career/extract/handler.ts", "src/lib/career/tailor/handler.ts"],
};
export const ENGINE_FORBIDDEN_GLOBALS = [
  "Buffer", "process", "__dirname", "__filename", "require", "fetch", "XMLHttpRequest", "WebSocket",
];

const ENGINE_PATTERN = {
  regex: "(^|/)engine(/|$)", allowTypeImports: false, message: "Import the engine only from career render, print modules or routes.",
};
const ENGINE_DYNAMIC = {
  selector: "ImportExpression[source.value=/(^|\\/)engine(\\/|$)/]", message: ENGINE_PATTERN.message,
};
const PRINT_PATTERN = {
  regex: "(^|/)print(/|$)", allowTypeImports: false, message: "Printing belongs to the PDF entry point.",
};
const PRINT_DYNAMIC = {
  selector: "ImportExpression[source.value=/(^|\\/)print(\\/|$)/]", message: PRINT_PATTERN.message,
};
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
  ...Object.entries(CORE_IMPORTING_CAREER).map(([file, targets]) => {
    const allowed = targets.map((target) => target.replace(/^src\//, "@/").replace(/\.tsx?$/, ""));
    const except = allowed.map((target) => target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const regex = `^(?!(?:${except})$)@/(?:lib/career|components/career|app/career|app/api/career|career-pdf)(?:/|$)`;
    const forbidden = { regex, message: CAREER_PATTERN.message, allowTypeImports: false };
    return {
      files: [file.replace(/[\[\]]/g, "\\$&")],
      rules: {
        "@typescript-eslint/no-restricted-imports": [
          "error",
          { paths: DATABASE_PATHS, patterns: [DATABASE_PATTERN, READONLY_PSQL_PATTERN, PRINT_PATTERN, ENGINE_PATTERN, forbidden] },
        ],
        "no-restricted-syntax": [
          "error",
          DATABASE_DYNAMIC,
          READONLY_PSQL_DYNAMIC,
          PRINT_DYNAMIC,
          ENGINE_DYNAMIC,
          { selector: `ImportExpression[source.value=/${new RegExp(regex).source}/]`, message: CAREER_PATTERN.message },
        ],
      },
    };
  }),
  {
    files: ["src/lib/career/{schema,store,contact,ai,extract,tailor,document}/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: DATABASE_PATHS,
          patterns: [
            DATABASE_PATTERN,
            READONLY_PSQL_PATTERN,
            {
              group: [
                "@/lib/career/engine",
                "@/lib/career/engine/*",
                "**/engine",
                "**/engine/**",
                "**/print",
                "**/print/**",
                "@/lib/career/print",
                "@/lib/career/print/*",
                "@fontsource/*",
                "@fontsource-variable/*",
                "**/fonts/*",
              ],
              message: "Career storage and schema modules must not load the rendering engine, printer or fonts.",
              allowTypeImports: false,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        DATABASE_DYNAMIC,
        READONLY_PSQL_DYNAMIC,
        {
          selector: "ImportExpression[source.value=/((^|\\/)(engine|print)(\\/|$)|@fontsource|\\/fonts\\/)/]",
          message: "Career storage and schema modules must not load rendering dependencies.",
        },
      ],
    },
  },
  {
    files: ["src/lib/career/{ai,extract,tailor}/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: DATABASE_PATHS, patterns: [DATABASE_PATTERN, READONLY_PSQL_PATTERN, { group: ["@/lib/career/contact/store", "**/contact/store", "@/lib/career/engine", "@/lib/career/engine/*", "@/lib/career/print/*", "@/lib/career/print", "**/engine", "**/engine/**", "**/print", "**/print/**", "@fontsource/*", "@fontsource-variable/*", "**/fonts/*"], allowTypeImports: false, message: "AI modules must use the scrub boundary and must not load rendering dependencies." }] }],
      "no-restricted-syntax": ["error", DATABASE_DYNAMIC, READONLY_PSQL_DYNAMIC, { selector: "ImportExpression[source.value=/(contact\\/store|(^|\\/)(engine|print)(\\/|$)|@fontsource|\\/fonts\\/)/]", message: "AI modules must use the scrub boundary." }, { selector: "Identifier[name='NO_STORED_VALUES']", message: "Career AI must scrub stored contact values." }],
    },
  },
  {
    // These blocks replace import rules, so database restrictions must be repeated.
    files: ["src/lib/career/**", "src/components/career/**"],
    ignores: ["src/lib/career/{schema,store,contact,ai,extract,tailor,document,render,engine,print,import}/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: DATABASE_PATHS, patterns: [DATABASE_PATTERN, READONLY_PSQL_PATTERN, {
        regex: "(^|/)(engine|print)(/|$)", allowTypeImports: false,
        message: "Only career render, print modules and routes may consume the rendering engine.",
      }] }],
      "no-restricted-syntax": ["error", DATABASE_DYNAMIC, READONLY_PSQL_DYNAMIC, {
        selector: "ImportExpression[source.value=/(^|\\/)(engine|print)(\\/|$)/]",
        message: "Only career render, print modules and routes may consume the rendering engine.",
      }],
    },
  },
  {
    // Rendering consumers retain database restrictions and cannot load the PDF process.
    files: ["src/lib/career/render/**", "src/lib/career/import/**", "src/app/career/**", "src/app/api/career/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: DATABASE_PATHS, patterns: [DATABASE_PATTERN, READONLY_PSQL_PATTERN, {
        regex: "(^|/)print(/|$)", allowTypeImports: false, message: "Printing belongs to the PDF entry point.",
      }] }],
      "no-restricted-syntax": ["error", DATABASE_DYNAMIC, READONLY_PSQL_DYNAMIC, {
        selector: "ImportExpression[source.value=/(^|\\/)print(\\/|$)/]", message: "Printing belongs to the PDF entry point.",
      }],
    },
  },
  {
    // Core app rules also cover relative engine and print imports; whitelisted files keep their scoped rules.
    files: ["src/app/**"],
    ignores: ["src/app/career/**", "src/app/api/career/**", ...Object.keys(CORE_IMPORTING_CAREER).map((file) => file.replace(/[\[\]]/g, "\\$&"))],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: DATABASE_PATHS, patterns: [DATABASE_PATTERN, READONLY_PSQL_PATTERN, CAREER_PATTERN, PRINT_PATTERN, ENGINE_PATTERN] }],
      "no-restricted-syntax": ["error", DATABASE_DYNAMIC, READONLY_PSQL_DYNAMIC, CAREER_DYNAMIC, PRINT_DYNAMIC, ENGINE_DYNAMIC],
    },
  },
  {
    files: ["src/career-pdf/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: DATABASE_PATHS, patterns: [DATABASE_PATTERN, READONLY_PSQL_PATTERN, ENGINE_PATTERN] }],
      "no-restricted-syntax": ["error", DATABASE_DYNAMIC, READONLY_PSQL_DYNAMIC, ENGINE_DYNAMIC],
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
        { selector: "MemberExpression[object.name='Date']:matches([computed=false][property.name='now'], [computed=true][property.value='now'])", message: "The engine receives dates from its caller." },
        { selector: "MemberExpression[object.name='globalThis']:matches([computed=false][property.name='Date'], [computed=true][property.value='Date'])", message: "The engine receives dates from its caller." },
        { selector: "VariableDeclarator[init.type='Identifier'][init.name='Date']", message: "The engine receives dates from its caller." },
        { selector: "AssignmentExpression[right.type='Identifier'][right.name='Date']", message: "The engine receives dates from its caller." },
      ],
      "no-restricted-globals": ["error", ...ENGINE_FORBIDDEN_GLOBALS],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts", "playwright-report/**", "test-results/**", ".local-demo/**", "data/**"]),
]);

export default eslintConfig;
