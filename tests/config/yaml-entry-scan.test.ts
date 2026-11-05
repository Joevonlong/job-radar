// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../..");

/** Files that parse YAML with the library directly, and why they may. Everything else goes through `config/yaml-options.ts`. */
const ALLOWED: Record<string, string> = {
  "src/lib/config/yaml-options.ts": "the one way config YAML is parsed",
  "src/lib/config/commented-defaults.ts": "reads a commented block out of a shipped file; never a user's value",
  "src/lib/setup/cli.ts": "the setup CLI's answers file, not a config file",
  "src/lib/market/load.ts": "market packs have their own schema and no overlay",
  "src/lib/db/queries/job-detail.ts": "profile text stored in the database",
  "src/lib/resume/export.ts": "writes a resume, does not read config",
  "src/lib/career/engine/render.ts": "a resume document, not a config file",
  "src/lib/career/engine/jd.ts": "a job description's front matter, not a config file",
  "src/lib/sources/registry/service.ts": "salvages proxies from a broken file: lenient on purpose, with the shared options",
  "src/ai-worker/version-guard.ts": "a compose file, not a config file",
  "scripts/check-ci-docs.ts": "workflow files, not config files",
};
/** Importing these is parsing (or writing a whole document) behind the shared options. */
const PARSERS = /\b(parse|parseDocument|parseAllDocuments|stringify)\b/;
const IMPORT = /import\s+(?!type\b)\{([^}]*)\}\s+from\s+"yaml"/g;

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(REPO, dir), { recursive: true }).map(String).filter((file) => /\.tsx?$/.test(file)).map((file) => path.join(dir, file));
}

describe("YAML entry points", () => {
  const offenders = [...sources("src"), ...sources("scripts")].filter((file) => {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    return [...text.matchAll(IMPORT)].some((match) => PARSERS.test(match[1] ?? ""));
  });

  it("every direct use of the parser is known, with a reason", () => {
    expect(offenders.filter((file) => !(file in ALLOWED))).toEqual([]);
  });

  it("the list has nothing left in it that no longer uses the parser", () => {
    expect(Object.keys(ALLOWED).filter((file) => !offenders.includes(file))).toEqual([]);
  });
});
