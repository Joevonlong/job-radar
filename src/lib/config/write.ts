import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { Document, isMap, isNode, isScalar, isSeq, type YAMLMap, type YAMLSeq } from "yaml";

import { commitConfigFile, CONFIG_FILE_MODE } from "./atomic";
import { ConfigError, zodIssues } from "./errors";
import { backupConfigText } from "./editor-backup";
import { hashConfigText, layeredConfigFingerprint } from "./hash";
import { configSourcePath, loadConfig, primeConfigCache, readProfileText, reloadConfig, shippedEffective } from "./load";
import { mergeLayers } from "./merge";
import { CONFIG_VERSION_KEY, currentConfigVersion, documentConfigVersion, hasOverlayFormat, isOverlayVersion, legacyFormatVersion, migrateConfigDocument, stampConfigVersion, withoutConfigVersion } from "./migrations/version";
import { newFileFormat } from "./new-file-format";
import { configLayer, getDefaultConfigPath, getProfileExampleDir, getUserConfigPath, readOverlayText, readShippedText, type ConfigLayer } from "./paths";
import { applyEditsToDocument, overlayFullEdits, overlaySaveEdits, pruneRedundantKeys } from "./overlay";
import { replaceRule } from "./overlay-rules";
import { notifyProfileSaved } from "./profile";
import { assertProtectedUnchanged } from "./protected-check";
import { readUserText } from "./read-user-file";
import { configRegistry, isProfileName, type ConfigName, type ConfigValue } from "./registry";
import { toFullText } from "./to-full";
import { CONFIG_YAML_OPTIONS, parseConfigYaml, parseConfigYamlDocument, stringifyConfigYaml } from "./yaml-options";
import { CONFIG_EDITOR_DEFAULTS } from "./schemas/ui";
import { validateConfigText } from "./validate-text";
import { currentConfigWriteLock, lockLostError, withConfigWriteLock } from "./write-lock";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const YAML_TEXT_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

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
export function syncNode(doc: Document, current: unknown, next: unknown, options: SyncOptions): unknown {
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
 * Serialize `value` as a whole file, reusing the comments and layout of `existingText` when it parses. An existing
 * document older than the code is migrated first (its comments survive the shape change, a `convertOnly` step does not run),
 * and `config_version` is kept / stamped with the whole-file version (it is only added to a file that lacks it once the
 * version is above 1). A document newer than the code is refused (ConfigError `version`).
 */
function renderYaml<N extends ConfigName>(name: N, existingText: string | null, existingPath: string, value: ConfigValue<N>, options: SyncOptions): string {
  const current = legacyFormatVersion(name);
  let doc: Document | null = null;
  if (existingText !== null) {
    const parsed = parseConfigYamlDocument(existingText);
    if (parsed.errors.length === 0 && parsed.contents !== null) doc = parsed;
  }
  if (doc !== null && isMap(doc.contents) && documentConfigVersion(doc) === null) doc.contents.delete(CONFIG_VERSION_KEY);
  if (doc !== null) migrateConfigDocument(name, doc, existingPath);
  if (doc === null) {
    doc = new Document(value, CONFIG_YAML_OPTIONS);
    if (current > 1) stampConfigVersion(doc, current);
  } else {
    const hadVersion = isMap(doc.contents) && doc.contents.has(CONFIG_VERSION_KEY);
    const next = hadVersion && isPlainObject(value) ? { [CONFIG_VERSION_KEY]: current, ...value } : value;
    doc.contents = syncNode(doc, doc.contents, next, options) as Document["contents"];
    if (!hadVersion && current > 1) stampConfigVersion(doc, current);
  }
  return restoreFlowPadding(existingText, doc.toString(YAML_TEXT_OPTIONS));
}

/** The first text of a new overlay: what it is, and the version. */
export function overlayStubText(name: ConfigName): string {
  const file = configRegistry[name].file;
  return [
    `# Your changes to the shipped ${file}. Only the keys written here override it; everything else follows the product.`,
    "# Remove a shipped key with `key: !unset`. See docs/configuration.md.",
    `${CONFIG_VERSION_KEY}: ${currentConfigVersion(name)}`,
    "",
  ].join("\n");
}

/** A whole file holding the shipped values (no user changes), in the whole-file version: comments of the shipped file included. */
export function wholeFileText(name: ConfigName): string {
  const file = getDefaultConfigPath(name) ?? getUserConfigPath(name);
  const text = readShippedText(name);
  if (text === null) throw new ConfigError({ configName: name, filePath: file, kind: "missing", layer: "shipped" });
  return toFullText(name, shippedEffective(name, text, file).doc, null);
}

/** The text of a file created now with no change in it (`config:init`, a pending setup file, the editor's template). */
export function newFileText(name: ConfigName): string {
  if (!hasOverlayFormat(name)) {
    const text = readShippedText(name);
    if (text === null) throw new ConfigError({ configName: name, filePath: getUserConfigPath(name), kind: "missing", layer: "shipped" });
    return text;
  }
  return newFileFormat() === "overlay" ? overlayStubText(name) : wholeFileText(name);
}

/** The shipped value in the lock, for a save: the two layers are read again, so E is the one the rename will land on. */
function shippedValueForWrite(name: ConfigName, filePath: string): unknown {
  const shippedFile = getDefaultConfigPath(name) ?? filePath;
  const text = readShippedText(name);
  if (text === null) throw new ConfigError({ configName: name, filePath: shippedFile, kind: "missing", layer: "shipped" });
  return shippedEffective(name, text, shippedFile).value;
}

/** A plain value without its `undefined` keys: an optional key a form cleared. A file cannot hold one, and the schema keeps it. */
function definedOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(definedOnly);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, definedOnly(item)]),
  );
}

/** An overlay text reads back as `expected`: shipped ⊕ text, through the schema. */
function overlayReadsBackAs<N extends ConfigName>(name: N, shipped: unknown, text: string, expected: ConfigValue<N>): boolean {
  try {
    const overlay = withoutConfigVersion(parseConfigYaml(text, { unset: "overlay" }));
    const reparsed = configRegistry[name].schema.safeParse(mergeLayers(shipped, overlay, { replaceAt: replaceRule(name) }));
    return reparsed.success && isDeepStrictEqual(definedOnly(reparsed.data), definedOnly(expected));
  } catch {
    return false;
  }
}

/**
 * The overlay text after saving `value`: only the paths that differ from what the layers give now are touched, in place
 * (comments stay), and without a change the text stays byte for byte. Refused (nothing written) when the result would not
 * read back as `value`.
 */
function renderOverlay<N extends ConfigName>(name: N, filePath: string, baseText: string, shipped: unknown, value: ConfigValue<N>): string {
  const overlayValue = (text: string): unknown => withoutConfigVersion(parseConfigYaml(text, { unset: "overlay" }));
  const input = { shipped, overlay: overlayValue(baseText), value: definedOnly(value) };
  const candidates = [overlaySaveEdits(name, input), overlayFullEdits(name, input)];
  for (const edits of candidates) {
    if (edits.length === 0 && overlayReadsBackAs(name, shipped, baseText, value)) return baseText;
    const doc = parseConfigYamlDocument(baseText, { unset: "overlay" });
    applyEditsToDocument(doc, edits, replaceRule(name), (target, current, next) => syncNode(target, current, next, { omitNewEmpty: false }));
    stampConfigVersion(doc, currentConfigVersion(name));
    const text = restoreFlowPadding(baseText, stringifyConfigYaml(doc, YAML_TEXT_OPTIONS));
    if (overlayReadsBackAs(name, shipped, text, value)) return text;
  }
  throw new ConfigError({ configName: name, filePath, kind: "schema", issues: [{ path: "", message: "the saved file would not read back as the submitted value" }] });
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return readUserText(file);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

function readsBackAs<N extends ConfigName>(name: N, text: string, expected: ConfigValue<N>): boolean {
  try {
    const reparsed = configRegistry[name].schema.safeParse(withoutConfigVersion(parseConfigYaml(text)));
    return reparsed.success && isDeepStrictEqual(reparsed.data, expected);
  } catch {
    return false;
  }
}

export { CONFIG_FILE_MODE };

/** The tail of the promise chain of each file being written: one in-process writer per file at a time. */
const fileLocks = new Map<string, Promise<unknown>>();

/**
 * Run `task` while holding the in-process lock of `file` (the web serves Server Actions concurrently: two saves of the
 * same file must not interleave their stale check, backup and rename). The config write lock inside it also covers other
 * processes. The order is always this lock first, then the config write lock: taking them the other way round would make
 * two saves wait for each other until they time out, so it is refused here.
 */
export async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  if (currentConfigWriteLock() !== null) throw new Error(`file lock taken inside the config write lock: ${path.basename(file)}`);
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
 * Under the user config or profile directory it must run inside `withConfigWriteLock`. `checkFresh` runs on the completed
 * temp file, right before the ownership check and the rename; a throw leaves the file as it was.
 */
export async function atomicWrite(file: string, text: string, checkFresh?: () => void): Promise<void> {
  await commitConfigFile(file, text, checkFresh === undefined ? {} : { checkFresh });
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
 * or profile template is the starting document, so its comments carry over. The file is replaced atomically and the cache is refreshed.
 * Profile files additionally trigger the `setOnProfileSaved` hook (errors from the hook propagate after the file was
 * written). Invalid values throw ConfigError and leave the file untouched; so does a value that changes a protected key
 * (`protected-keys.ts`, kind `protected`).
 *
 * Before a config file (not a profile file: those have their database snapshots) is replaced, its old text is
 * copied to `.backup/editor/` like the advanced editor does (ui.yaml `config_editor.backups_keep` copies per file), so a
 * form or wizard save that overwrote something can be undone from the editor's backups.
 *
 * `baseHash` (the forms: `layeredConfigFingerprint` of what they were opened on): checked again right before the rename, under
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
    const text = await withConfigWriteLock(() => {
      assertProtectedUnchanged(name, parsed);
      return writeValidated(name, filePath, parsed, options.baseHash);
    }, filePath);
    // Keep same-file notifications ordered in this process, but never hold the write lock over DB/network work.
    if (isProfileName(name)) await notifyProfileSaved(name, text);
    return parsed;
  });
}

/**
 * Read, transform and write under both write locks.
 * Return null from the synchronous transform to leave the file unchanged. Profile notifications run after
 * releasing the config write lock, in the same order as the writes of this process.
 */
export async function mutateConfig<N extends ConfigName>(name: N, update: (current: ConfigValue<N>) => ConfigValue<N> | null): Promise<ConfigValue<N> | null> {
  const filePath = getUserConfigPath(name);
  return withFileLock(filePath, async () => {
    const result = await withConfigWriteLock(async () => {
      const next = update(reloadConfig(name));
      if (next === null) return null;
      const checked = configRegistry[name].schema.safeParse(next);
      if (!checked.success) throw new ConfigError({ configName: name, filePath, kind: "schema", issues: zodIssues(checked.error) });
      const value = checked.data as ConfigValue<N>;
      assertProtectedUnchanged(name, value);
      const text = await writeValidated(name, filePath, value, undefined);
      return { value, text };
    }, filePath);
    if (result !== null && isProfileName(name)) await notifyProfileSaved(name, result.text);
    return result?.value ?? null;
  });
}

/** The fingerprint the forms compute for `name` now (a profile file: the hash of its text; "" when it is unreadable). */
function currentTextHash(name: ConfigName): string {
  try {
    return isProfileName(name) ? hashConfigText(readProfileText(name)) : layeredConfigFingerprint(name);
  } catch {
    return "";
  }
}

/** The plain value of the file a save starts from (after the in-memory migration), or undefined when there is none or it cannot be read. */
function existingKeys(name: ConfigName, existingText: string | null, existingPath: string): unknown {
  if (existingText === null) return undefined;
  try {
    const doc = parseConfigYamlDocument(existingText);
    if (doc.errors.length > 0 || doc.contents === null) return undefined;
    migrateConfigDocument(name, doc, existingPath);
    return withoutConfigVersion(doc.toJS());
  } catch {
    return undefined;
  }
}

type SaveBase =
  /** An overlay (its text, or a new file's stub): the pinned-key rule. */
  | { kind: "overlay"; text: string }
  /** A whole file (not converted yet, a new file while conversions are pending, a profile file, models.yaml). */
  | { kind: "whole"; text: string | null; path: string };

/** What a save starts from. A user file that cannot be used (a syntax error) counts as absent, its text is backed up. */
function saveBase(name: ConfigName, filePath: string, userText: string | null, shippedPath: string | null, shippedText: string | null): SaveBase {
  if (!hasOverlayFormat(name)) return { kind: "whole", text: userText ?? shippedText, path: userText === null && shippedPath !== null ? shippedPath : filePath };
  if (userText !== null) {
    const doc = parseConfigYamlDocument(userText, { unset: "overlay" });
    if (doc.errors.length === 0) {
      const version = documentConfigVersion(doc);
      if (isOverlayVersion(name, version) && version !== null) {
        if (version > currentConfigVersion(name)) migrateConfigDocument(name, doc, filePath); // throws `version`
        return { kind: "overlay", text: userText };
      }
      return { kind: "whole", text: userText, path: filePath };
    }
  }
  return newFileFormat() === "overlay" ? { kind: "overlay", text: overlayStubText(name) } : { kind: "whole", text: wholeFileText(name), path: filePath };
}

async function writeValidated<N extends ConfigName>(name: N, filePath: string, parsed: ConfigValue<N>, baseHash: string | undefined): Promise<string> {
  const assertUnchanged = (): void => {
    if (baseHash !== undefined && currentTextHash(name) !== baseHash) throw new ConfigError({ configName: name, filePath, kind: "stale" });
  };
  assertUnchanged();
  const shippedPath = isProfileName(name) ? path.join(getProfileExampleDir(), configRegistry[name].file) : getDefaultConfigPath(name);
  const userText = await readIfExists(filePath);
  const shippedText = shippedPath === null ? null : await readIfExists(shippedPath);
  const base = saveBase(name, filePath, userText, shippedPath, shippedText);
  let text = "";
  if (base.kind === "overlay") {
    text = renderOverlay(name, filePath, base.text, shippedValueForWrite(name, filePath), parsed);
  } else {
    // Leave out the keys the file lacks that only hold what the schema defaults to (a shipped default that changes later must
    // still reach the user); each attempt is used only when it reads back as exactly the validated value.
    const known = existingKeys(name, base.text, base.path);
    const leaner = known === undefined ? parsed : pruneRedundantKeys(configRegistry[name].schema, parsed, known);
    for (const [candidate, omitNewEmpty] of [[leaner, true], [leaner, false], [parsed, true], [parsed, false]] as const) {
      text = renderYaml(name, base.text, base.path, candidate, { omitNewEmpty });
      if (readsBackAs(name, text, parsed)) break;
    }
  }
  if (userText !== null && userText === text && base.kind === "overlay") {
    primeConfigCache(name, parsed);
    return text;
  }
  await commitUserText(name, filePath, userText, text, assertUnchanged);
  primeConfigCache(name, parsed);
  return text;
}

/** Back up the old text (config files; profile files have their database snapshots) and replace or create the file. */
async function commitUserText(name: ConfigName, filePath: string, userText: string | null, text: string, assertUnchanged: () => void): Promise<void> {
  if (userText !== null && userText !== text && !isProfileName(name)) await backupConfigText(name, userText, backupsKeep());
  if (userText === null) {
    // A file this process cannot see may still be there: a bind mount can answer ENOENT for a moment after the host renamed
    // over it, and replacing it would lose what it holds. Only a file nobody has may be created.
    const created = await commitConfigFile(filePath, text, { checkFresh: assertUnchanged, mode: "create" });
    if (created === "existed") throw new ConfigError({ configName: name, filePath, kind: "stale" });
  } else {
    await atomicWrite(filePath, text, assertUnchanged);
  }
}

/**
 * The repair entry: the user's file has no usable value (a syntax or schema error), so there is no E to diff against. The
 * submitted complete value is validated, diffed against the shipped value alone (or, while whole files are around, written
 * as a whole file; `new-file-format.ts`), the broken text is backed up, and a file that changed since the preview
 * (`previewFingerprint`) is refused as `stale`. Recoverable credentials are the caller's: it puts them in the value.
 */
export async function writeConfigRepair<N extends ConfigName>(name: N, value: ConfigValue<N>, options: { previewFingerprint: string }): Promise<ConfigValue<N>> {
  assertEditable(name);
  const filePath = getUserConfigPath(name);
  const result = configRegistry[name].schema.safeParse(value);
  if (!result.success) throw new ConfigError({ configName: name, filePath, kind: "schema", issues: zodIssues(result.error) });
  const parsed = result.data as ConfigValue<N>;
  return withFileLock(filePath, () => withConfigWriteLock(async () => {
    assertProtectedUnchanged(name, parsed);
    const assertUnchanged = (): void => {
      if (currentTextHash(name) !== options.previewFingerprint) throw new ConfigError({ configName: name, filePath, kind: "stale" });
    };
    assertUnchanged();
    const userText = await readIfExists(filePath);
    let text = "";
    if (hasOverlayFormat(name) && newFileFormat() === "overlay") {
      text = renderOverlay(name, filePath, overlayStubText(name), shippedValueForWrite(name, filePath), parsed);
    } else {
      const baseText = hasOverlayFormat(name) ? wholeFileText(name) : await readIfExists(getDefaultConfigPath(name) ?? filePath);
      const known = existingKeys(name, baseText, filePath);
      const leaner = known === undefined ? parsed : pruneRedundantKeys(configRegistry[name].schema, parsed, known);
      text = renderYaml(name, baseText, filePath, leaner, { omitNewEmpty: true });
      if (!readsBackAs(name, text, parsed)) text = renderYaml(name, baseText, filePath, parsed, { omitNewEmpty: false });
      if (!readsBackAs(name, text, parsed)) throw new ConfigError({ configName: name, filePath, kind: "schema", issues: [{ path: "", message: "the saved file would not read back as the submitted value" }] });
    }
    await commitUserText(name, filePath, userText, text, assertUnchanged);
    primeConfigCache(name, parsed);
    return parsed;
  }, filePath));
}

// ---------------------------------------------------------------- the advanced editor

/** What the editor saw when it opened the file: a save is refused when the file (or its layer) is not the same any more. */
export interface TextBase {
  /** `layeredConfigFingerprint` of what the editor was opened on. */
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

/** Refuse when the config is not what the editor opened (either layer changed, or the file came or went). Returns the user file's text ("" without one). */
function assertFresh(name: ConfigName, base: TextBase): string {
  const layer = configLayer(name);
  let currentText = "";
  let fingerprint = "";
  try {
    currentText = readOverlayText(name) ?? "";
    fingerprint = layeredConfigFingerprint(name);
  } catch {
    // unreadable now
  }
  if (layer !== base.baseLayer || fingerprint !== base.baseHash) {
    throw new ConfigError({ configName: name, filePath: configSourcePath(name), kind: "stale" });
  }
  return currentText;
}

/**
 * Write `text` to the user's config file exactly as given, an older format included (comments and layout are the user's own). Order: size, full
 * validation of the value it gives: an overlay merged over the shipped file, a whole file migrated (syntax, `config_version`, schema, cross-file: what `loadConfig` would accept), then the stale check
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
  return withFileLock(filePath, () => withConfigWriteLock(async () => {
    assertProtectedUnchanged(name, checked.value);
    const currentText = assertFresh(name, options);
    const hadUserFile = fs.existsSync(/*turbopackIgnore: true*/ filePath);
    const backup = hadUserFile ? await backupConfigText(name, currentText, options.backupsKeep, options.now) : null;
    await commitConfigFile(filePath, text, { checkFresh: () => void assertFresh(name, options), ...(hadUserFile ? {} : { mode: "create" as const }) });
    primeConfigCache(name, checked.value);
    return { backup, layer: "user" as const };
  }, filePath));
}

/**
 * "Restore the default": the user's text is backed up and the user file removed, so the shipped file is what counts again
 * (the stale check applies). Not offered for setup.yaml: its absence means the setup wizard has not been run. Throws
 * `ConfigError` (`missing` when there is no shipped file to fall back to, `stale`).
 */
export async function resetConfigToDefault(name: ConfigName, options: TextBase & { backupsKeep: number; now?: Date }): Promise<TextWriteResult> {
  assertEditable(name);
  if (name === "setup") throw new Error("setup.yaml cannot be restored to the default");
  const filePath = getUserConfigPath(name);
  const shippedPath = getDefaultConfigPath(name);
  if (shippedPath === null) throw new ConfigError({ configName: name, filePath, kind: "missing" });
  const shippedText = await readIfExists(shippedPath);
  if (shippedText === null) throw new ConfigError({ configName: name, filePath: shippedPath, kind: "missing" });
  return withFileLock(filePath, () => withConfigWriteLock(async (session): Promise<TextWriteResult> => {
    const currentText = assertFresh(name, options);
    const hadUserFile = fs.existsSync(/*turbopackIgnore: true*/ filePath);
    const backup = hadUserFile ? await backupConfigText(name, currentText, options.backupsKeep, options.now) : null;
    assertFresh(name, options);
    if (!(await session.fence())) throw lockLostError(filePath);
    fs.rmSync(/*turbopackIgnore: true*/ filePath, { force: true });
    reloadConfig(name);
    return { backup, layer: "default" };
  }, filePath));
}
