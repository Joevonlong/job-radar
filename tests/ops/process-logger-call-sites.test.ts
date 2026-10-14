// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Which loggers follow the configured log level. The entry points create their logger inline in `main()` (and the web
 * modules at module level), so these are structural checks of the source: going back to a fixed-level `createLogger`
 * fails here.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");

/** The source without comments, so a call that is only mentioned in a comment does not count. */
function code(relative: string): string {
  return fs
    .readFileSync(path.join(ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(relative) : /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

describe("process logger call sites", () => {
  it.each(["src/ai-worker/index.ts", "src/runner/index.ts"])("%s: the main logger is the process logger", (file) => {
    const source = code(file);
    expect(source).toContain("const logger = createProcessLogger();");
    expect(source).not.toMatch(/\bcreateLogger\(/);
  });

  it.each(["src/lib/control/service.ts", "src/lib/control/salary-request.ts", "src/lib/control/breakdown-request.ts"])("%s: the module logger is the process logger", (file) => {
    const source = code(file);
    expect(source).toContain('const log = createProcessLogger({ fields: { component: "control" } });');
    expect(source).not.toMatch(/\bcreateLogger\(/);
  });

  it("pnpm cycle:run uses the same resolution (it has no level option of its own)", () => {
    const source = code("scripts/cycle-run.ts");
    expect(source).toContain("const logger = createProcessLogger();");
    expect(source).not.toMatch(/\bcreateLogger\(/);
  });

  it("the AI test button and the request router hand their logger to the providers", () => {
    expect(code("src/lib/control/test-ai.ts")).toContain("createDefaultProviders(config, { logger: context.logger })");
    expect(code("src/lib/translation/router.ts")).toContain("createDefaultProviders(config, logger ? { logger } : {})");
  });
});

describe("log level modules stay out of the config import chain", () => {
  it("the level list is a leaf", () => {
    expect(code("src/lib/logging/levels.ts")).not.toMatch(/^\s*import\b/m);
  });

  it("the logger imports neither the config modules, the environment nor node:fs", () => {
    const source = code("src/lib/channels/logger.ts");
    expect(source).not.toMatch(/from "@\/lib\/config|from "\.\.\/config|from "node:fs"|from "@\/lib\/env"|process-logger/);
  });

  it("no config module imports the resolver", () => {
    for (const file of walk("src/lib/config")) expect(code(file), file).not.toContain("process-logger");
  });
});
