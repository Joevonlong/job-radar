/**
 * The one way config YAML is parsed and written. Every reader of a config file (the loader, the writer, the advanced
 * editor, migrations, diff, examples, the secrets mask, the source registry import) goes through here, so they all agree
 * on what a file means:
 *
 * - a tag the parser cannot resolve (`!foo`, a misspelt `!unsett`, `!!int x`) is an error, not a warning that silently
 *   turns the value into a string;
 * - `!unset` is the one custom tag. It marks a key whose value is removed from the shipped default (`key: !unset`). The
 *   marker is checked where it stands: never the whole document, never `config_version`, never in a list, never on a
 *   mapping or a list, never with a value. The overlay semantics are not switched on yet, so in this version a marker
 *   in a valid position is an error too ("not supported by this version"); the merge functions use `unset: "overlay"`;
 * - the canonical text of a marker is `key: !unset` with nothing after it (`stringifyConfigYaml`).
 *
 * `UNSET` (a symbol) is what a marker parses to. It only ever appears inside the overlay merge and diff
 * (`merge.ts`, `overlay-diff.ts`, `migrations/overlay-convert.ts`); their outputs never hold it.
 */
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  Scalar,
  visit,
  YAMLParseError,
  type Document,
  type DocumentOptions,
  type ParseOptions,
  type ScalarTag,
  type SchemaOptions,
} from "yaml";

// Not imported from migrations/version.ts: this module is also bundled for the browser (through diff.ts).
const CONFIG_VERSION_KEY = "config_version";

export const UNSET_TAG = "!unset";

/** What `key: !unset` parses to. Internal to the merge and diff functions. */
export const UNSET: unique symbol = Symbol("config.unset");
export type Unset = typeof UNSET;

export function isUnset(value: unknown): value is Unset {
  return value === UNSET;
}

const unsetTag: ScalarTag = {
  tag: UNSET_TAG,
  identify: (value) => value === UNSET,
  // a value after the tag (`!unset x`, `!unset ''`) is reported by the position check, with the line
  resolve: () => UNSET,
  stringify: () => "",
};

/** The parse / document options every config reader and writer uses. */
export const CONFIG_YAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = { uniqueKeys: true, customTags: [unsetTag] };

/**
 * What a valid `!unset` means to the caller. `reject`: the overlay semantics are not on (this version): every marker is an
 * error. `overlay`: a marker in a valid position parses to `UNSET` (the merge and diff tests, and later the loader).
 */
export type UnsetMode = "reject" | "overlay";

export interface ConfigYamlParseOptions {
  /** Pass one to turn offsets of later checks into lines (the editor's validation); errors get their line either way. */
  lineCounter?: LineCounter;
  unset?: UnsetMode;
}

/** The message of a valid marker while the overlay semantics are off. */
export const UNSET_NOT_SUPPORTED = "!unset is not supported by this version of Job Radar";

const UNRESOLVED_UNSET = /^Unresolved tag: !unset\b/;

function lineError(lineCounter: LineCounter, offset: number, message: string): YAMLParseError {
  const where = lineCounter.linePos(offset);
  const error = new YAMLParseError([offset, offset + 1], "TAG_RESOLVE_FAILED", `${message} at line ${where.line}, column ${where.col}:`);
  error.linePos = [where];
  return error;
}

/**
 * Where a marker may not stand. Returns null for a valid position (a key's value inside mappings only).
 * `path` is the visitor's ancestor list (document, then collections and pairs).
 */
function misplacedMarker(key: unknown, node: Scalar, path: readonly unknown[]): string | null {
  if (node.type !== "PLAIN" || (node.source ?? "") !== "") return "!unset takes no value: write `key: !unset`";
  if (key === "key") return "!unset cannot be a key";
  if (path.length <= 1) return "!unset cannot replace the whole file";
  if (path.some((ancestor) => isSeq(ancestor))) return "!unset cannot stand in a list (a list is replaced as a whole)";
  const parent = path[path.length - 2];
  const pair = path[path.length - 1];
  if (path.length === 3 && isMap(parent) && pair !== null && typeof pair === "object" && "key" in pair) {
    const pairKey = (pair as { key: unknown }).key;
    if (isScalar(pairKey) && pairKey.value === CONFIG_VERSION_KEY) return "config_version cannot be unset";
  }
  return null;
}

/**
 * Parse config YAML into a document with the shared options. Never throws: problems are in `doc.errors` (sorted by
 * position) with their line, like the parser's own. Unresolved tags and misplaced (or, in `reject` mode, any) `!unset`
 * markers are errors; other warnings stay warnings.
 */
export function parseConfigYamlDocument(text: string, options: ConfigYamlParseOptions = {}): Document {
  const lineCounter = options.lineCounter ?? new LineCounter();
  const mode = options.unset ?? "reject";
  const doc = parseDocument(text, { ...CONFIG_YAML_OPTIONS, lineCounter });
  const warnings: typeof doc.warnings = [];
  for (const warning of doc.warnings) {
    if (warning.code !== "TAG_RESOLVE_FAILED") {
      warnings.push(warning);
      continue;
    }
    const offset = warning.pos[0];
    doc.errors.push(
      UNRESOLVED_UNSET.test(warning.message)
        ? lineError(lineCounter, offset, "!unset cannot mark a mapping or a list: write it on a key with no value")
        : new YAMLParseError(warning.pos, warning.code, warning.message),
    );
    const last = doc.errors[doc.errors.length - 1];
    if (last && warning.linePos) last.linePos = warning.linePos;
  }
  doc.warnings = warnings;
  visit(doc, {
    Scalar(key, node, path) {
      if (node.tag !== UNSET_TAG) return;
      const offset = node.range?.[0] ?? 0;
      const problem = misplacedMarker(key, node, path);
      if (problem !== null) doc.errors.push(lineError(lineCounter, offset, problem));
      else if (mode === "reject") doc.errors.push(lineError(lineCounter, offset, UNSET_NOT_SUPPORTED));
    },
    Alias(_key, node) {
      const target = node.resolve(doc);
      if (isScalar(target) && target.tag === UNSET_TAG) doc.errors.push(lineError(lineCounter, node.range?.[0] ?? 0, "!unset cannot be used through an alias"));
    },
  });
  doc.errors.sort((a, b) => a.pos[0] - b.pos[0]);
  return doc;
}

/**
 * Parse config YAML into a plain value with the shared options; throws the first error (a `YAMLParseError` with its
 * line), like `yaml`'s own `parse`. Other warnings are not printed.
 */
export function parseConfigYaml(text: string, options: ConfigYamlParseOptions = {}): unknown {
  const doc = parseConfigYamlDocument(text, options);
  const first = doc.errors[0];
  if (first) throw first;
  return doc.toJS() as unknown;
}

/** True when the parsed value holds an `UNSET` marker anywhere. */
export function containsUnset(value: unknown): boolean {
  if (value === UNSET) return true;
  if (Array.isArray(value)) return value.some(containsUnset);
  if (typeof value === "object" && value !== null) return Object.values(value).some(containsUnset);
  return false;
}

/**
 * The text of a config document, with every marker in its canonical form `key: !unset` (no space, no value after the
 * tag; `yaml` itself writes `key: !unset ` with a trailing space). The document is not changed.
 */
export function stringifyConfigYaml(doc: Document): string {
  let hasMarker = false;
  visit(doc, {
    Scalar(_key, node) {
      if (node.value === UNSET) hasMarker = true;
    },
  });
  if (!hasMarker) return doc.toString();
  const plainText = doc.toString();
  let placeholder = "";
  do placeholder = `jr_unset_${Math.random().toString(36).slice(2)}`;
  while (plainText.includes(placeholder));
  const copy = doc.clone();
  visit(copy, {
    Scalar(_key, node) {
      if (node.value !== UNSET) return undefined;
      const plain = new Scalar(placeholder);
      plain.comment = node.comment;
      plain.commentBefore = node.commentBefore;
      plain.spaceBefore = node.spaceBefore;
      return plain;
    },
  });
  return copy.toString().split(placeholder).join(UNSET_TAG);
}
