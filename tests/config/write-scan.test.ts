import fs from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every write under the user's config and profile directories is inside the config write lock. A static scan over
 * `src/**` and `scripts/**`:
 *
 * - every direct filesystem write is listed below with what it writes; a new one fails here until someone decides;
 * - the functions that write the user's directories (`LOCKED`) may only be called from inside a `withConfigWriteLock`
 *   callback, or from a function that itself may only be called from inside one.
 *
 * Shell scripts have their own list at the end.
 */
const REPO = path.resolve(import.meta.dirname, "../..");

/** Writes that are under the lock: what the second check below proves. */
const LOCKED = new Map<string, string>([
  ["src/lib/career/store/history.ts#prune", "profile history retention under its config write lock"],
  ["src/lib/career/store/delete.ts#clearCareerHistory", "removes history under the profile and config write locks"],
  ["src/lib/career/store/delete.ts#deleteCareerData", "removes career data under the profile, contact and config write locks"],
  ["src/lib/config/atomic.ts#commitConfigFile", "the commit of a config or profile file (it also refuses at run time outside the lock)"],
  ["src/lib/config/atomic.ts#publishNoReplace", "the last step of commitConfigFile"],
  ["src/lib/config/editor-backup.ts#backupConfigText", "the copy of the old text in .backup/editor/"],
  ["src/lib/config/editor-backup.ts#pruneBackups", "the oldest copies in .backup/editor/"],
  ["src/lib/config/migrations/backups.ts#pruneConfigBackups", "the oldest .backup/<time>/"],
  ["src/lib/config/migrations/files.ts#applyConfigMigrations", "the copy of the original in .backup/<time>/, and the conversion's record"],
  ["src/lib/config/migrations/rollback.ts#applyToFull", "the copy of an overlay in .backup/<time>/, before it becomes a whole file"],
  ["src/lib/config/migrations/rollback.ts#restoreConfigBackup", "the copy of what stands there in .backup/<time>/, before a backup comes back"],
  ["src/lib/config/write.ts#resetConfigToDefault", "removing an override of a shipped file"],
  ["src/lib/setup/state.ts#removeAbandonedSetupTemps", "temp files an interrupted setup.yaml commit left"],
]);

/** Shell lines that write the user's directories (trimmed text), none of them under the lock, and why. */
const SHELL_WRITES = new Map<string, string>([
  ['scripts/ops/backup.sh: mkdir -p "$meta_dir/data/config"', "a temp directory for the archive's marker; the live directories are only read"],
  ['scripts/ops/backup.sh: archive_meta_yaml >"$meta_dir/data/config/.archive-meta.yaml"', ".archive-meta.yaml: exists only in the archive"],
  ['scripts/ops/deploy.sh: [[ "$DRY_RUN" -eq 1 ]] || rm -f "$USER_CONFIG/.upgrade-freeze"', "a marker the old version wrote; nothing reads it any more"],
  ['scripts/ops/deploy.sh: rm -f "$USER_CONFIG/.upgrade-freeze"', "a marker the old version wrote; nothing reads it any more"],
  ['scripts/ops/deploy.sh: rm -rf "$USER_CONFIG/.write.lock" "$USER_CONFIG/.write.lock.guard" "$APP/data/profile/.write.lock" "$APP/data/profile/.write.lock.guard"', "markers of the old file lock, with every service stopped"],
  ['scripts/ops/deploy.sh: run "Check write permission on the product directory (is the external volume writable?)" mkdir -p data/config data/profile data/backups data/exports', "creates the directories; no file in them"],
  ['scripts/ops/restore.sh: then mv "$app/data/$sub" "$app/data/$sub.before-restore-$stamp" || config_failed=1', "restore: every service is stopped, and it swaps whole directories"],
  ['scripts/ops/restore.sh: mv "$config_stage/data/$sub" "$app/data/$sub" || config_failed=1', "restore: every service is stopped, and it swaps whole directories"],
  ['scripts/ops/restore.sh: mkdir -p "$config_stage/data/config" "$config_stage/data/profile"', "the unpacked backup, not the live directories"],
  ['scripts/ops/restore.sh: rm -f "$config_stage/data/config/$ARCHIVE_META_NAME"', "the unpacked backup: .archive-meta.yaml stays out of the live directory"],
  ['scripts/ops/restore.sh: existing_install_setup_yaml "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >"$config_stage/data/config/setup.yaml"', "the unpacked backup"],
  ['scripts/ops/restore.sh: chmod 600 "$config_stage/data/config/setup.yaml"', "the unpacked backup"],
  ['scripts/ops/restore.sh: existing_install_language_yaml >"$config_stage/data/config/language.yaml"', "the unpacked backup"],
  ['scripts/ops/restore.sh: chmod 600 "$config_stage/data/config/language.yaml"', "the unpacked backup"],
]);

/** Writes the lock does not cover, and why. */
const NOT_LOCKED = new Map<string, string>([
  // Login metadata, not configuration: it has its own "temp file + link" publishing and only ever changes on its own.
  ["src/lib/security/session.ts#writeTempSecret", ".web-session-secret, .web-session-generation: login metadata"],
  ["src/lib/security/session.ts#fileSecret", ".web-session-secret: login metadata"],
  ["src/lib/security/session.ts#removeQuietly", "the temp file of the two above"],
  ["src/lib/security/session.ts#bumpSessionGeneration", ".web-session-generation: login metadata"],
  // `.env` is not under data/config or data/profile (config:init --env-only and the setup wizard's env step).
  ["src/lib/ops/db-password.ts#ensureDbPassword", ".env"],
  ["src/lib/setup/env-file.ts#writeAtomic", ".env"],
  ["src/lib/setup/env-file.ts#updateEnvFile", ".env"],
  // The prepare scripts clear directories they checked are throw-away, before there is anything to serialize against.
  ["scripts/e2e-prepare.ts#<module>", "clears the run's disposable config and profile directories (names checked above the call)"],
  ["scripts/demo-prepare.ts#<module>", "clears the demo's disposable directories (names checked by scripts/demo/checks.ts)"],
  // A file in the test's own directory, only under NODE_ENV=test.
  ["src/lib/config/write-lock.ts#lockTestPause", "the `reached` marker of the cross-process tests"],
  // Elsewhere on disk.
  ["src/lib/companies/merge-run.ts#runSuggest", "the plan file named by companies:merge --suggest --out (it refuses a path in the config or profile directory)"],
  ["src/lib/config/models-overlay-write.ts#exportFullModels", "the file named by models:export --out, a copy nothing reads"],
  ["src/lib/ops/config-archive.ts#writeConfigArchive", "the archive in data/backups (.archive-meta.yaml exists only inside the archive)"],
  ["src/lib/ops/backup.ts#fsyncFile", "data/backups"],
  ["src/lib/ops/backup.ts#removeFile", "data/backups"],
  ["src/lib/ops/backup.ts#runBackup", "data/backups"],
  ["src/lib/ops/log-files.ts#redirectOutputToFiles", "data/logs"],
  ["src/lib/ops/log-files.ts#removeExtraCopies", "data/logs"],
  ["src/lib/ops/log-files.ts#rotateLogFile", "data/logs"],
  ["src/lib/resume/export.ts#writeAtomically", "data/exports"],
  ["src/lib/channels/linkedin/session/auth-file.ts#writeAuthFile", ".auth"],
  ["src/lib/ai/providers/codex-cli.ts#createCodexCliTransport", "a temp file of the provider call"],
  ["src/lib/ai/providers/process.ts#makeScratchDir", "the provider process's scratch directory"],
  ["scripts/simhash-analyze.ts#exportSnapshot", "the snapshot file the operator names"],
  ["scripts/i18n-catalog.ts#main", "the generated message catalogs in the repository"],
  ["scripts/career-engine-fonts.ts#main", "the generated src/lib/career/engine/fonts.generated.ts in the repository"],
  ["scripts/career-print-baseline.ts#main", "PDFs, text and pages.json in the output directory the operator names (it refuses the baseline directory)"],
  ["scripts/market-regress.ts#main", "the regression report in the repository"],
  ["scripts/demo-finish.ts#makeGif", "the rendered pictures in the repository"],
  ["scripts/demo-finish.ts#<module>", "the rendered pictures in the repository"],
  ["scripts/dev/gen-config-golden.ts#<module>", "the golden fixtures in tests/"],
]);

const WRITE_CALLS = new Set([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync",
  "unlink", "unlinkSync", "copyFile", "copyFileSync", "cp", "cpSync", "link", "linkSync", "symlink", "symlinkSync", "truncate",
  "truncateSync", "createWriteStream", "open", "openSync",
]);
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const LOCK_FUNCTION = "withConfigWriteLock";
const USER_DIRECTORY = /data\/config|data\/profile|data\/\$sub|USER_CONFIG|CFG_USER_DIR/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(REPO, dir), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && /\.(ts|tsx|mts|mjs)$/.test(entry.name)).map((entry) => path.relative(REPO, path.join(entry.parentPath, entry.name)));
}

interface Scanned {
  file: string;
  source: ts.SourceFile;
}

const scanned: Scanned[] = [...sourceFiles("src"), ...sourceFiles("scripts")].map((file) => ({
  file,
  source: ts.createSourceFile(file, fs.readFileSync(path.join(REPO, file), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
}));

function visit(node: ts.Node, each: (node: ts.Node) => void): void {
  each(node);
  ts.forEachChild(node, (child) => visit(child, each));
}

/** The names a file binds to Node's filesystem modules: `fs`, `fsp`, and named imports such as `rename`. */
function fsBindings(source: ts.SourceFile): { namespaces: Set<string>; named: Set<string> } {
  const namespaces = new Set<string>();
  const named = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !FS_MODULES.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) named.add(element.name.text);
    }
  }
  return { namespaces, named };
}

/** The name of the function declaration or binding around `node`, outermost named one; `<module>` at the top level. */
function enclosingFunction(node: ts.Node): string {
  let name = "<module>";
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined) name = at.name.getText();
    else if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent) && ts.isIdentifier(at.parent.name)) name = at.parent.name.text;
  }
  return name;
}

/** `fs` for both `fs` and `fs.promises`. */
function rootIdentifier(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  return ts.isPropertyAccessExpression(node) && node.name.text === "promises" ? rootIdentifier(node.expression) : null;
}

/** Opening a file only to read it is not a write. */
function isReadOnlyOpen(call: ts.CallExpression, name: string): boolean {
  if (name !== "open" && name !== "openSync") return false;
  const flags = call.arguments[1];
  return flags === undefined || (ts.isStringLiteral(flags) && flags.text === "r");
}

function directWrites(): Map<string, ts.CallExpression[]> {
  const writes = new Map<string, ts.CallExpression[]>();
  for (const { file, source } of scanned) {
    const { namespaces, named } = fsBindings(source);
    if (namespaces.size === 0 && named.size === 0) continue;
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      let name: string | null = null;
      if (ts.isPropertyAccessExpression(callee) && rootIdentifier(callee.expression) !== null && namespaces.has(rootIdentifier(callee.expression) ?? "")) name = callee.name.text;
      else if (ts.isIdentifier(callee) && named.has(callee.text)) name = callee.text;
      if (name === null || !WRITE_CALLS.has(name) || isReadOnlyOpen(node, name)) return;
      const key = `${file}#${enclosingFunction(node)}`;
      writes.set(key, [...(writes.get(key) ?? []), node]);
    });
  }
  return writes;
}

/** Is this call inside the callback handed to `withConfigWriteLock`? */
function insideLockCallback(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === LOCK_FUNCTION && at.arguments[0] !== undefined && at.arguments[0].pos <= node.pos && node.end <= at.arguments[0].end) return true;
  }
  return false;
}

/** Calls of a function by name, across the scanned files. */
let callIndex: Map<string, { file: string; node: ts.CallExpression }[]> | null = null;

function callsOf(name: string): { file: string; node: ts.CallExpression }[] {
  if (callIndex === null) {
    const index = new Map<string, { file: string; node: ts.CallExpression }[]>();
    for (const { file, source } of scanned) {
      visit(source, (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) index.set(node.expression.text, [...(index.get(node.expression.text) ?? []), { file, node }]);
      });
    }
    callIndex = index;
  }
  return callIndex.get(name) ?? [];
}

/** The call sites of `name` that are neither in a lock callback nor in a function whose own call sites all are. */
function callsOutsideLock(name: string, seen: Set<string> = new Set()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const problems: string[] = [];
  for (const { file, node } of callsOf(name)) {
    if (insideLockCallback(node)) continue;
    const around = enclosingFunction(node);
    if (around === "<module>") {
      problems.push(`${file}: ${name} at the top level, outside the lock`);
      continue;
    }
    const callers = callsOf(around);
    if (callers.length === 0) {
      problems.push(`${file}: ${name} in ${around}, which nothing here calls inside the lock`);
      continue;
    }
    problems.push(...callsOutsideLock(around, seen));
  }
  return problems;
}

describe("writes under the user's config and profile directories", () => {
  it("every direct filesystem write in src/ and scripts/ is listed, and the list has no leftovers", () => {
    const found = [...directWrites().keys()].sort();
    const listed = [...LOCKED.keys(), ...NOT_LOCKED.keys()].sort();
    expect({
      "a new write: put it under the lock, or list it with the reason": found.filter((key) => !listed.includes(key)),
      "this write is gone: drop it from the list": listed.filter((key) => !found.includes(key)),
    }).toEqual({ "a new write: put it under the lock, or list it with the reason": [], "this write is gone: drop it from the list": [] });
  });

  it("the scan sees the writers it is about (it would pass on nothing otherwise)", () => {
    const found = directWrites();
    for (const key of LOCKED.keys()) expect(found.has(key), key).toBe(true);
    expect(callsOf("commitConfigFile").length).toBeGreaterThan(3);
    expect(callsOf(LOCK_FUNCTION).length).toBeGreaterThan(3);
  });

  it("the writes in `LOCKED` run inside the lock", () => {
    const problems: string[] = [];
    const found = directWrites();
    for (const key of LOCKED.keys()) {
      const name = key.split("#")[1] ?? "";
      const [file] = key.split("#");
      const writes = found.get(key) ?? [];
      // the function's own body holds the lock around the write, or every caller does
      if (writes.length > 0 && writes.every(insideLockCallback)) continue;
      const callers = callsOf(name);
      if (callers.length === 0) problems.push(`${file}: ${name} writes outside the lock and has no callers`);
      problems.push(...callsOutsideLock(name));
    }
    expect(problems).toEqual([]);
  });

  it("the shell scripts that write those directories are the listed ones", () => {
    const found: string[] = [];
    const root = path.join(REPO, "scripts");
    const shellFiles = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".sh"));
    for (const entry of shellFiles) {
      const file = path.relative(REPO, path.join(entry.parentPath, entry.name));
      for (const raw of fs.readFileSync(path.join(REPO, file), "utf8").split("\n")) {
        const line = raw.trim();
        if (line.startsWith("#") || line.startsWith("echo ")) continue;
                for (const part of line.split(/\s*(?:&&|;)\s*/)) {
          const writes = /\b(?:rm|mv|cp|mkdir|chmod|tar -x\S*|tee)\s/.test(part) || />\s*"?\$?\S*(?:data\/|USER_CONFIG)/.test(part);
          if (writes && USER_DIRECTORY.test(part)) found.push(`${file}: ${part}`);
        }
      }
    }
    expect([...new Set(found)].sort()).toEqual([...SHELL_WRITES.keys()].sort());
  });

  it("the scan's lock check notices a commit outside the lock", () => {
    const source = ts.createSourceFile("x.ts", "async function f() { await commitConfigFile('a', 'b'); await withConfigWriteLock(() => commitConfigFile('a', 'b')); }", ts.ScriptTarget.Latest, true);
    const seen: boolean[] = [];
    visit(source, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "commitConfigFile") seen.push(insideLockCallback(node));
    });
    expect(seen).toEqual([false, true]);
  });
});
