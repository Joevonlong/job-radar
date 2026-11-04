// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentConfigVersion, inspectConfigLayers, inspectOverlayFiles } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

/**
 * The reporting code (`config:check`, the doctor's `config.layers`, the release's default-value change list) never writes a
 * configuration file, so reverting it alone is safe. A static scan, like `write-scan.test.ts`: none of these files calls a
 * filesystem write, a function that writes the user's config or profile, or anything but `git show` / `git rev-parse` as a child process.
 */
const REPO = path.resolve(import.meta.dirname, "../..");

const REPORT_FILES = [
  "src/lib/config/overlay-report.ts",
  "src/lib/config/layers.ts",
  "src/lib/ops/doctor/checks/config.ts",
  "scripts/config-check.ts",
  "scripts/release/changed-defaults.ts",
];

const FS_WRITES = new Set([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync",
  "unlink", "unlinkSync", "copyFile", "copyFileSync", "cp", "cpSync", "link", "linkSync", "symlink", "symlinkSync", "truncate",
  "truncateSync", "createWriteStream", "open", "openSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "chmod", "chmodSync", "utimes", "utimesSync",
]);

/** Functions of the config library that write (or take the write lock). */
const CONFIG_WRITERS = new Set([
  "writeConfig", "writeConfigText", "writeConfigRepair", "mutateConfig", "resetConfigToDefault", "commitConfigFile", "publishNoReplace",
  "applyConfigMigrations", "applyToFull", "restoreConfigBackup", "withConfigWriteLock", "withFileLock", "ensureConfigFiles", "ensureProfileFiles",
  "pruneConfigBackups", "backupConfigText", "atomicWrite", "writeModelsOverlay", "exportFullModels",
]);

const READ_ONLY_GIT = new Set(["show", "rev-parse"]);

interface Finding {
  file: string;
  what: string;
}

const FORBIDDEN_MODULE = /(^|\/)(write|atomic|write-lock|editor-backup|migrations\/rollback|migrations\/backups|models-overlay-write|init)$/;
const isForbiddenModule = (specifier: string): boolean => FORBIDDEN_MODULE.test(specifier) || /^(node:)?(fs|fs\/promises|child_process)$/.test(specifier);

function scan(source: string, file: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name !== null && FS_WRITES.has(name)) found.push({ file, what: `fs write ${name}` });
      if (name !== null && CONFIG_WRITERS.has(name)) found.push({ file, what: `config writer ${name}` });
      if (name === "execFileSync" || name === "spawnSync" || name === "execSync" || name === "exec" || name === "spawn" || name === "execFile") {
        const [command, args] = node.arguments;
        const first = args !== undefined && ts.isArrayLiteralExpression(args) ? args.elements[0] : undefined;
        const ok = name === "execFileSync" && command !== undefined && ts.isStringLiteral(command) && command.text === "git" && first !== undefined && ts.isStringLiteral(first) && READ_ONLY_GIT.has(first.text);
        if (!ok) found.push({ file, what: `child process ${name}` });
      }
    }
    // import("x"): the module must be a literal that is not a writer, node:fs or child_process; a computed specifier is refused
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier === undefined || !ts.isStringLiteralLike(specifier)) found.push({ file, what: "dynamic import with a computed specifier" });
      else if (isForbiddenModule(specifier.text)) found.push({ file, what: `dynamic import of ${specifier.text}` });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") found.push({ file, what: "require" });
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // aliased names from node:fs: `import { writeFileSync as w }` is caught by the name it is imported under
      if (/^(node:)?fs(\/promises)?$/.test(node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (FS_WRITES.has((element.propertyName ?? element.name).text)) found.push({ file, what: `imports fs ${(element.propertyName ?? element.name).text}` });
        }
      }
      const clause = node.importClause?.namedBindings;
      if (clause !== undefined && ts.isNamedImports(clause)) {
        for (const element of clause.elements) {
          if (CONFIG_WRITERS.has((element.propertyName ?? element.name).text)) found.push({ file, what: `imports config writer ${(element.propertyName ?? element.name).text}` });
        }
      }
      if (FORBIDDEN_MODULE.test(node.moduleSpecifier.text)) found.push({ file, what: `imports ${node.moduleSpecifier.text}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("the reporting code writes no config file", () => {
  it("the report files contain no write call, writer import or child process but a read-only git", () => {
    const findings = REPORT_FILES.flatMap((file) => scan(fs.readFileSync(path.join(REPO, file), "utf8"), file));
    expect(findings).toEqual([]);
  });

  it("the scan notices each kind of write (it would pass on nothing otherwise)", () => {
    const bad = `
      import fs from "node:fs";
      import { writeConfig } from "@/lib/config";
      import { commitConfigFile } from "./atomic";
      fs.writeFileSync("a", "b");
      execFileSync("git", ["commit"]);
      spawnSync("rm", ["-rf", "x"]);
    `;
    const what = scan(bad, "x.ts").map((f) => f.what);
    expect(what).toEqual(expect.arrayContaining(["fs write writeFileSync", "imports config writer writeConfig", "imports ./atomic", "child process execFileSync", "child process spawnSync"]));
    expect(scan(`execFileSync("git", ["show", "a:b"]);`, "x.ts")).toEqual([]);
  });

  it("the scan notices aliased fs imports, openSync and dynamic imports", () => {
    const what = scan(
      `import { writeFileSync as put } from "node:fs";
       import * as f from "fs";
       f.openSync("a", "w");
       await import("./write");
       await import(name);
       await import("node:fs");`,
      "x.ts",
    ).map((finding) => finding.what);
    expect(what).toEqual(expect.arrayContaining(["imports fs writeFileSync", "fs write openSync", "dynamic import of ./write", "dynamic import with a computed specifier", "dynamic import of node:fs"]));
    expect(scan(`await import("yaml");`, "x.ts")).toEqual([]);
  });

  describe("at run time", () => {
    let tmp: TempConfig;
    beforeEach(() => {
      tmp = makeTempConfig({ user: "empty" });
      fs.writeFileSync(path.join(tmp.configDir, "ui.yaml"), `config_version: ${currentConfigVersion("ui")}\ntrend_cycles: 7\nnot_a_key: !unset\n`);
    });
    afterEach(() => tmp.cleanup());

    /** Every file under the directories, with its content and modification time. */
    const snapshot = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const dir of [tmp.configDir, tmp.defaultsDir, tmp.profileDir]) {
        if (!fs.existsSync(dir)) {
          out[`${dir}/`] = "(missing)";
          continue;
        }
        for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const file = path.join(entry.parentPath, entry.name);
          out[file] = `${fs.statSync(file).mtimeMs}:${fs.readFileSync(file, "utf8")}`;
        }
        out[`${dir}/`] = fs.readdirSync(dir).sort().join(",");
      }
      return out;
    };

    it("the inspection functions and the release script leave both directories as they were", () => {
      const before = snapshot();
      expect(inspectOverlayFiles().length).toBeGreaterThan(0);
      void inspectConfigLayers();
      const repo = path.resolve(import.meta.dirname, "../..");
      const run = runConfigScript(tmp, "release/changed-defaults.ts", ["HEAD", "HEAD"], {}, repo);
      expect(run.status, run.out).toBe(0);
      expect(run.out).toContain("(none)");
      runConfigScript(tmp, "config-check.ts", ["--overrides"]);
      expect(snapshot()).toEqual(before);
    });
  });

  it("every report file exists", () => {
    for (const file of REPORT_FILES) expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
  });
});
