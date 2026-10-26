import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { Document, isMap, isNode, isScalar, isSeq, parse, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

import { ConfigError, zodIssues } from "./errors";
import { backupConfigText } from "./editor-backup";
import { hashConfigText } from "./hash";
import { configSourcePath, loadConfig, primeConfigCache, readConfigText, readProfileText, reloadConfig } from "./load";
import { CONFIG_VERSION_KEY, currentConfigVersion, documentConfigVersion, migrateConfigDocument, stampConfigVersion, withoutConfigVersion } from "./migrations/version";
import { configLayer, getDefaultConfigPath, getUserConfigPath, type ConfigLayer } from "./paths";
import { pruneRedundantKeys } from "./overlay";
import { notifyProfileSaved } from "./profile";
import { assertProtectedUnchanged } from "./protected-check";
import { configRegistry, isProfileName, type ConfigName, type ConfigValue } from "./registry";
import { CONFIG_EDITOR_DEFAULTS } from "./schemas/ui";
import { validateConfigText } from "./validate-text";
import { commitConfigWrite, withConfigWriteLock } from "./write-lock";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalarValue(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

interface SyncOptions {
  /** Do not add keys that are new in the file and hold an empty list / map (zod defaults such as `exclude: []`). */
  omitNewEmpty: boolean;
}

/** An empty list or map, or a map of only empty collections (`scoring.criteria` with three empty lists). */
function isEmptyCollection(value: unknown): boolean {
  return (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.values(value).every(isEmptyCollection));
}

/** A line with the padding inside `{ }` / `[ ]` taken out, so the same line written either way compares equal. */
function withoutFlowPadding(line: string): string {
  return line.replace(/([{[]) /g, "$1").replace(/ ([}\]])/g, "$1");
}

/**
 * The serializer writes every flow collection the same way (`{a: 1}`), but a file may mix styles (`{ USD: 0.9 }` next to
 * `[a, b]`). A line that only differs from an original line by that padding goes back to the original text, so saving one
 * field does not reformat flow collections elsewhere in the file. Changed or new lines keep the serializer's style.
 */
export function restoreFlowPadding(original: string | null, output: string): string {
  if (original === null) return output;
  const originals = new Map<string, string>();
  for (const line of original.split("\n")) {
    const key = withoutFlowPadding(line);
    if (key !== line && !originals.has(key)) originals.set(key, line);
  }
  if (originals.size === 0) return output;
  // a file that writes its flow maps with padding (`- { a: 1 }`) gets the same on the lines it changed or added
  const originalLines = new Set(original.split("\n"));
  const paddedMaps = [...originalLines].some((line) => /^\s*(?:- |[\w.-]+: )\{ \S/.test(line));
  return output
    .split("\n")
    .map((line) => originals.get(withoutFlowPadding(line)) ?? (paddedMaps && !originalLines.has(line) ? padFlowMap(line) : line))
    .join("\n");
}

/** `- {a: 1}` / `key: {a: 1} # note` -> the same with padding inside the outer braces; quoted `{token}` text is not touched. */
function padFlowMap(line: string): string {
  if (!/^\s*(?:- |[\w.-]+: )\{\S.*\}\s*(?:#.*)?$/.test(line)) return line;
  return line.replace(/^(\s*(?:- |[\w.-]+: ))\{/, "$1{ ").replace(/(\S)\}(\s*(?:#.*)?)$/, "$1 }$2");
}

/**
 * Make `current` (an existing YAML node) hold `next`, mutating in place wherever the shapes match
 * so comments attached to nodes survive. Returns the node/value that should occupy the slot.
 */
function syncNode(doc: Document, current: unknown, next: unknown, options: SyncOptions): unknown {
  if (isMap(current) && isPlainObject(next)) {
    syncMap(doc, current, next, options);
    return current;
  }
  if (isSeq(current) && Array.isArray(next)) {
    syncSeq(doc, current, next, options);
    return current;
  }
  if (isScalar(current) && isScalarValue(next)) {
    current.value = next;
    return current;
  }
  return doc.createNode(next);
}

function syncMap(doc: Document, map: YAMLMap, next: Record<string, unknown>, options: SyncOptions): void {
  const existingKeys = map.items.map((pair) => (isScalar(pair.key) ? String(pair.key.value) : String(pair.key)));
  for (const key of existingKeys) {
    if (!(key in next) || next[key] === undefined) map.delete(key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (map.has(key)) {
      map.set(key, syncNode(doc, map.get(key, true), value, options));
    } else if (options.omitNewEmpty && isEmptyCollection(value)) {
      // a key the file never had, holding only what the schema defaults to: leave it out (the caller checks that this reads back the same)
      continue;
    } else {
      map.set(key, doc.createNode(value));
    }
  }
}

/** The plain value of a list item (a node or an already-plain value). */
function plainItem(doc: Document, item: unknown): unknown {
  return isNode(item) ? item.toJS(doc) : item;
}

/** Pairs (old index, new index) of the longest common subsequence of two lists, by deep equality. */
function commonPairs(oldValues: readonly unknown[], newValues: readonly unknown[]): Array<[number, number]> {
  const n = oldValues.length;
  const m = newValues.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = isDeepStrictEqual(oldValues[i], newValues[j]) ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (isDeepStrictEqual(oldValues[i], newValues[j])) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) i++;
    else j++;
  }
  return pairs;
}

/**
 * Make `seq` hold `next`. Entries that are unchanged keep their node, and with it the comments written above and beside it, wherever they
 * end up (deleting one company must not move the group comment of the next ones); entries that changed between two unchanged
 * ones are edited in place; the rest are added or dropped. The group comment of a dropped entry moves to the entry that follows it.
 */
function syncSeq(doc: Document, seq: YAMLSeq, next: unknown[], options: SyncOptions): void {
  // an empty `[]` that gains entries becomes a block list (a flow list would put them all on one line)
  if (seq.flow && seq.items.length === 0 && next.length > 0) seq.flow = false;
  const oldItems = [...seq.items];
  const pairs = commonPairs(oldItems.map((item) => plainItem(doc, item)), next);
  const result: unknown[] = [];
  let carried: string | null = null;
  const place = (node: unknown): void => {
    if (carried !== null && isNode(node)) {
      node.commentBefore = node.commentBefore ? `${carried}\n${node.commentBefore}` : carried;
      carried = null;
    }
    result.push(node);
  };
  const fill = (oldFrom: number, oldTo: number, newFrom: number, newTo: number): void => {
    const common = Math.min(oldTo - oldFrom, newTo - newFrom);
    for (let k = 0; k < common; k++) place(syncNode(doc, oldItems[oldFrom + k], next[newFrom + k], options));
    for (let k = newFrom + common; k < newTo; k++) {
      const node = doc.createNode(next[k]);
      // a list written as `- { a: 1 }` lines stays that way for the entries added to it
      if (isMap(node) && oldItems.length > 0 && oldItems.every((item) => isMap(item) && item.flow)) node.flow = true;
      place(node);
    }
    for (let k = oldFrom + common; k < oldTo; k++) {
      const gone = oldItems[k];
      if (isNode(gone) && gone.commentBefore) carried = carried ? `${carried}\n${gone.commentBefore}` : gone.commentBefore;
    }
  };
  let oi = 0;
  let ni = 0;
  for (const [i, j] of pairs) {
    fill(oi, i, ni, j);
    place(oldItems[i]);
    oi = i + 1;
    ni = j + 1;
  }
  fill(oi, oldItems.length, ni, next.length);
  seq.items = result as YAMLSeq["items"];
}

/**
 * Serialize `value`, reusing the comments and layout of `existingText` when it parses. An existing document older
 * than the code is migrated first (its comments survive the shape change), and `config_version` is kept / stamped with
 * the code's version (it is only added to a file that lacks it once the version is above 1). A document newer than the
 * code is refused (ConfigError `version`).
 */
function renderYaml<N extends ConfigName>(name: N, existingText: string | null, existingPath: string, value: ConfigValue<N>, options: SyncOptions): string {
  const current = currentConfigVersion(name);
  let doc: Document | null = null;
  if (existingText !== null) {
    const parsed = parseDocument(existingText, { uniqueKeys: true });
    if (parsed.errors.length === 0 && parsed.contents !== null) doc = parsed;
  }
  if (doc !== null && isMap(doc.contents) && documentConfigVersion(doc) === null) doc.contents.delete(CONFIG_VERSION_KEY);
  if (doc !== null) migrateConfigDocument(name, doc, existingPath);
  if (doc === null) {
    doc = new Document(value);
    if (current > 1) stampConfigVersion(doc, current);
  } else {
    const hadVersion = isMap(doc.contents) && doc.contents.has(CONFIG_VERSION_KEY);
    const next = hadVersion && isPlainObject(value) ? { [CONFIG_VERSION_KEY]: current, ...value } : value;
    doc.contents = syncNode(doc, doc.contents, next, options) as Document["contents"];
    if (!hadVersion && current > 1) stampConfigVersion(doc, current);
  }
  return restoreFlowPadding(existingText, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(/*turbopackIgnore: true*/ file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

function readsBackAs<N extends ConfigName>(name: N, text: string, expected: ConfigValue<N>): boolean {
  try {
    const reparsed = configRegistry[name].schema.safeParse(withoutConfigVersion(parse(text)));
    return reparsed.success && isDeepStrictEqual(reparsed.data, expected);
  } catch {
    return false;
  }
}

/**
 * Mode of every config / profile file the app writes: owner read / write only. The config files can name
 * credential files, proxies with passwords and the profile holds personal data. On Linux the web and the runner run as
 * the same uid (compose `PUID` / `PGID`), and the host processes run as the owner of `data/`.
 */
export const CONFIG_FILE_MODE = 0o600;

/** The tail of the promise chain of each file being written: one in-process writer per file at a time. */
const fileLocks = new Map<string, Promise<unknown>>();

/**
 * Run `task` while holding the in-process lock of `file` (the web serves Server Actions concurrently: two saves of the
 * same file must not interleave their stale check, backup and rename). The directory lock inside it also covers other processes.
 */
export async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  fileLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

/**
 * Write via a temp file in the same directory + rename, so readers never see a partial file (creates the directory).
 * The temp file is created with mode 0600 (never readable by others, not even for a moment) and the result keeps it.
 * `beforeRename` runs after the temp file is complete and right before the rename; a throw there leaves the file as it
 * was (the temp file is removed). `checkFresh` is synchronous and runs inside the fenced commit, immediately before rename.
 */
export async function atomicWrite(file: string, text: string, beforeRename?: () => void | Promise<void>, checkFresh?: () => void): Promise<void> {
  return withConfigWriteLock(file, async () => {
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      const handle = await fsp.open(tmp, "wx", CONFIG_FILE_MODE);
      try {
        // the umask can only take bits away; chmod makes 0600 exact even under an unusual umask
        await handle.chmod(CONFIG_FILE_MODE);
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (beforeRename !== undefined) await beforeRename();
      await commitConfigWrite(file, () => {
        checkFresh?.();
        fs.renameSync(tmp, file);
      });
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  });
}

/** ui.yaml `config_editor.backups_keep`, or its default when ui.yaml cannot be read. */
function backupsKeep(): number {
  try {
    return loadConfig("ui").config_editor.backups_keep;
  } catch {
    return CONFIG_EDITOR_DEFAULTS.backups_keep;
  }
}

/**
 * Validate `value`, then write it to the user's config file (always the user directory, never the defaults).
 * The existing YAML document is updated in place (comments survive); when the user has no copy yet, the shipped default
 * is the starting document, so its comments carry over. The file is replaced atomically and the cache is refreshed.
 * Profile files additionally trigger the `setOnProfileSaved` hook (errors from the hook propagate after the file was
 * written). Invalid values throw ConfigError and leave the file untouched; so does a value that changes a protected key
 * (`protected-keys.ts`, kind `protected`).
 *
 * Before a config file (not a profile file: those have their database snapshots) is replaced, its old text is
 * copied to `.backup/editor/` like the advanced editor does (ui.yaml `config_editor.backups_keep` copies per file), so a
 * form or wizard save that overwrote something can be undone from the editor's backups.
 *
 * `baseHash` (the forms: `hashConfigText` of the text they were opened on): checked again right before the rename, under
 * the file's in-process lock, so a save over a file that changed in the meantime is refused (ConfigError `stale`) even
 * when two saves race. Without it (the setup wizard) the save always goes through.
 */
export async function writeConfig<N extends ConfigName>(name: N, value: ConfigValue<N>, options: { baseHash?: string } = {}): Promise<ConfigValue<N>> {
  const filePath = getUserConfigPath(name);
  const result = configRegistry[name].schema.safeParse(value);
  if (!result.success) {
    throw new ConfigError({ configName: name, filePath, kind: "schema", issues: zodIssues(result.error) });
  }
  const parsed = result.data as ConfigValue<N>;
  return withFileLock(filePath, async () => {
    const text = await withConfigWriteLock(filePath, () => {
      assertProtectedUnchanged(name, parsed);
      return writeValidated(name, filePath, parsed, options.baseHash);
    });
    // Keep same-file notifications ordered in this process, but never hold a directory lease over DB/network work.
    if (isProfileName(name)) await notifyProfileSaved(name, text);
    return parsed;
  });
}

/** The hash of the file the app reads for `name` now ("" when it is missing or unreadable), as the forms compute it. */
function currentTextHash(name: ConfigName): string {
  try {
    return hashConfigText(isProfileName(name) ? readProfileText(name) : readConfigText(name));
  } catch {
    return "";
  }
}

/** The plain value of the file a save starts from (after the in-memory migration), or undefined when there is none or it cannot be read. */
function existingKeys(name: ConfigName, existingText: string | null, existingPath: string): unknown {
  if (existingText === null) return undefined;
  try {
    const doc = parseDocument(existingText, { uniqueKeys: true });
    if (doc.errors.length > 0 || doc.contents === null) return undefined;
    migrateConfigDocument(name, doc, existingPath);
    return withoutConfigVersion(doc.toJS());
  } catch {
    return undefined;
  }
}

async function writeValidated<N extends ConfigName>(name: N, filePath: string, parsed: ConfigValue<N>, baseHash: string | undefined): Promise<string> {
  const assertUnchanged = (): void => {
    if (baseHash !== undefined && currentTextHash(name) !== baseHash) throw new ConfigError({ configName: name, filePath, kind: "stale" });
  };
  assertUnchanged();
  const shippedPath = getDefaultConfigPath(name);
  const userText = await readIfExists(filePath);
  const existing = userText ?? (shippedPath === null ? null : await readIfExists(shippedPath));
  const existingPath = userText === null && shippedPath !== null ? shippedPath : filePath;
  // Leave out the keys the file lacks that only hold what the schema defaults to (a shipped default that changes later must
  // still reach the user); each attempt is used only when it reads back as exactly the validated value.
  const known = existingKeys(name, existing, existingPath);
  const leaner = known === undefined ? parsed : pruneRedundantKeys(configRegistry[name].schema, parsed, known);
  let text = "";
  for (const [candidate, omitNewEmpty] of [[leaner, true], [leaner, false], [parsed, true], [parsed, false]] as const) {
    text = renderYaml(name, existing, existingPath, candidate, { omitNewEmpty });
    if (readsBackAs(name, text, parsed)) break;
  }
  if (userText !== null && userText !== text && !isProfileName(name)) await backupConfigText(name, userText, backupsKeep());
  await atomicWrite(filePath, text, undefined, assertUnchanged);
  primeConfigCache(name, parsed, text);
  return text;
}

// ---------------------------------------------------------------- the advanced editor

/** What the editor saw when it opened the file: a save is refused when the file (or its layer) is not the same any more. */
export interface TextBase {
  /** `hashConfigText` of the text the editor was opened on. */
  baseHash: string;
  /** The layer that text came from. */
  baseLayer: ConfigLayer;
}

export interface TextWriteOptions extends TextBase {
  /** Longest text accepted, in bytes (`ui.yaml: config_editor.max_bytes`). */
  maxBytes: number;
  /** Backups of this file kept (`ui.yaml: config_editor.backups_keep`). */
  backupsKeep: number;
  now?: Date;
}

export interface TextWriteResult {
  /** Where the old text was copied; null when the user had no file of their own yet. */
  backup: string | null;
  layer: ConfigLayer;
}

function assertEditable(name: ConfigName): void {
  if (isProfileName(name)) throw new Error(`the advanced editor does not edit the profile files (${name})`);
}

/** Refuse when the file is not what the editor opened (different text or another layer). */
function assertFresh(name: ConfigName, base: TextBase): string {
  const layer = configLayer(name);
  let currentText = "";
  try {
    currentText = readConfigText(name);
  } catch {
    // missing / unreadable now
  }
  if (layer !== base.baseLayer || hashConfigText(currentText) !== base.baseHash) {
    throw new ConfigError({ configName: name, filePath: configSourcePath(name), kind: "stale" });
  }
  return currentText;
}

/**
 * Write `text` to the user's config file exactly as given (comments and layout are the user's own). Order: size, full
 * validation (syntax, `config_version`, schema, cross-file: what `loadConfig` would accept), then the stale check
 * (the file must still be what the editor opened), then a backup of the old text, then an atomic write and a refreshed cache.
 * A text that changes a protected key (`protected-keys.ts`) is refused before the stale check.
 * Throws `ConfigError` (`too_large`, `yaml` / `schema` / `version` with the first issue, `protected`, `stale`).
 */
export async function writeConfigText(name: ConfigName, text: string, options: TextWriteOptions): Promise<TextWriteResult> {
  assertEditable(name);
  const filePath = getUserConfigPath(name);
  if (Buffer.byteLength(text, "utf8") > options.maxBytes) throw new ConfigError({ configName: name, filePath, kind: "too_large" });
  const checked = validateConfigText(name, text);
  if (!checked.ok) {
    throw new ConfigError({ configName: name, filePath, kind: checked.issues[0]?.source === "yaml" ? "yaml" : "schema", issues: checked.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
  }
  return withFileLock(filePath, () => withConfigWriteLock(filePath, async () => {
    assertProtectedUnchanged(name, checked.value);
    const currentText = assertFresh(name, options);
    const hadUserFile = fs.existsSync(/*turbopackIgnore: true*/ filePath);
    const backup = hadUserFile ? await backupConfigText(name, currentText, options.backupsKeep, options.now) : null;
    await atomicWrite(filePath, text, undefined, () => void assertFresh(name, options));
    primeConfigCache(name, checked.value, text);
    return { backup, layer: "user" as const };
  }));
}

/**
 * "Restore the default": a `shipped` file (models, pipeline) loses the user's override, so the defaults directory is read
 * again; a `user` file is replaced by the shipped default's text. Either way the user's text is backed up first and the
 * stale check applies. Throws `ConfigError` (`missing` when there is nothing to reset to, `stale`).
 */
export async function resetConfigToDefault(name: ConfigName, options: TextBase & { backupsKeep: number; now?: Date }): Promise<TextWriteResult> {
  assertEditable(name);
  const filePath = getUserConfigPath(name);
  const shippedPath = getDefaultConfigPath(name);
  if (shippedPath === null) throw new ConfigError({ configName: name, filePath, kind: "missing" });
  const shippedText = await readIfExists(shippedPath);
  if (shippedText === null) throw new ConfigError({ configName: name, filePath: shippedPath, kind: "missing" });
  return withFileLock(filePath, () => withConfigWriteLock(filePath, async (): Promise<TextWriteResult> => {
    const currentText = assertFresh(name, options);
    const hadUserFile = fs.existsSync(/*turbopackIgnore: true*/ filePath);
    const backup = hadUserFile ? await backupConfigText(name, currentText, options.backupsKeep, options.now) : null;
    if (configRegistry[name].kind === "shipped") {
      await commitConfigWrite(filePath, () => {
        assertFresh(name, options);
        fs.rmSync(filePath, { force: true });
      });
      reloadConfig(name);
      return { backup, layer: "default" };
    }
    await atomicWrite(filePath, shippedText, undefined, () => void assertFresh(name, options));
    reloadConfig(name);
    return { backup, layer: "user" };
  }));
}
