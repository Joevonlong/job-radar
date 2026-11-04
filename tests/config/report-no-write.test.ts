import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

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
  "truncateSync", "createWriteStream", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "chmod", "chmodSync", "utimes", "utimesSync",
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
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause?.namedBindings;
      if (clause !== undefined && ts.isNamedImports(clause)) {
        for (const element of clause.elements) {
          if (CONFIG_WRITERS.has((element.propertyName ?? element.name).text)) found.push({ file, what: `imports config writer ${(element.propertyName ?? element.name).text}` });
        }
      }
      if (/(^|\/)(write|atomic|write-lock|editor-backup|migrations\/rollback|migrations\/backups|models-overlay-write|init)$/.test(node.moduleSpecifier.text)) found.push({ file, what: `imports ${node.moduleSpecifier.text}` });
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

  it("every report file exists", () => {
    for (const file of REPORT_FILES) expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
  });
});
