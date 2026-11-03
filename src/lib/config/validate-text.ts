/**
 * Validate the raw text of a config file the way the loader would read it, and say where each problem is.
 * Pure: no cache, no disk access except the other file of a cross-file check (injectable, see `ValidateOptions`).
 * Messages hold paths and reasons only, never the file's contents (C4).
 *
 * Order: YAML syntax -> `config_version` (written down, not newer than the code) -> migrated in memory -> zod schema ->
 * cross-file checks (ai.yaml against the models.yaml catalog, both directions), all on the migrated value. A text that
 * passes can be read by `loadConfig`. An older file stays valid: writes can be pending after a deploy, and it must stay
 * editable meanwhile. A problem on a path only the migration creates is reported on line 1 with the path.
 */
import { isMap, isNode, isScalar, LineCounter, type Document } from "yaml";
import type { ZodError } from "zod";

import { configDocumentValue, parseConfigText, readConfigText, resolveConfigDocument } from "./load";
import { interestsRawWarnings, interestsWarnings, SLOW_PATTERN_MESSAGE, slowInterestPatterns } from "./interests-lint";
import { checkAiAgainstCatalog } from "./model-catalog";
import { ConfigError } from "./errors";
import { documentConfigVersion, currentConfigVersion, CONFIG_VERSION_KEY, migrateConfigDocument, withoutConfigVersion } from "./migrations/version";
import { PROTECTED_KEY_MESSAGE, protectedChanges } from "./protected-check";
import { configRegistry, type ConfigName, type ConfigValue } from "./registry";
import { parseConfigYamlDocument } from "./yaml-options";

/** `protected`: the text changes a protected key (`protected-keys.ts`); only with `checkProtected`. */
export type IssueSource = "yaml" | "version" | "schema" | "catalog" | "protected";

export interface TextIssue {
  /** Dotted path with `[n]` list indexes (`providers.mimo.model`, `ranges_days[1]`); empty = the document. */
  path: string;
  message: string;
  /** 1-based position the issue points at. */
  line: number;
  col: number;
  /** False when the path itself does not exist (a missing key): the position is the nearest parent that does. */
  exact: boolean;
  source: IssueSource;
  /** The issue belongs to another config file (a cross-file check): the position means nothing in this text. */
  file?: ConfigName;
}

export type ValidateResult<N extends ConfigName = ConfigName> =
  | { ok: true; value: ConfigValue<N>; /** Warnings that do not stop a save (a deprecated model). */ warnings: TextIssue[] }
  | { ok: false; issues: TextIssue[] };

export interface ValidateOptions {
  /** The parsed value of another config, for the cross-file checks; default: read from disk. null = unreadable (the check is skipped, with an issue). */
  readOther?: <M extends ConfigName>(name: M) => ConfigValue<M> | null;
  /** Also report protected keys whose value differs from the file on disk and the shipped default (the web's editor). */
  checkProtected?: boolean;
  /**
   * The server's probe of a user pattern with the file's own limits (`signalPatternIsFast`): interests.yaml patterns it
   * refuses are issues with the message `SLOW_PATTERN_MESSAGE` (the web's editor, `pnpm config:check`). Absent = not checked.
   */
  interestsProbe?: (limits: ConfigValue<"interests">["limits"]) => (pattern: string) => boolean;
}

/** Most issues listed (a badly broken file would otherwise list hundreds). */
export const MAX_TEXT_ISSUES = 50;

function defaultReadOther<M extends ConfigName>(name: M): ConfigValue<M> | null {
  try {
    return parseConfigText(name, readConfigText(name));
  } catch {
    return null;
  }
}

function joinPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, segment) => (typeof segment === "number" ? `${acc}[${segment}]` : acc === "" ? String(segment) : `${acc}.${String(segment)}`), "");
}

function nodeStart(node: unknown): number | null {
  if (isNode(node) && node.range) return node.range[0];
  return null;
}

/** The source offset of the key `key` of the mapping at `parentPath`, or of its value when the key is not found. */
function keyOffset(doc: Document, parentPath: ReadonlyArray<string | number>, key: string): number | null {
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  if (!isMap(parent)) return nodeStart(parent);
  for (const pair of parent.items) {
    if (isScalar(pair.key) && String(pair.key.value) === key) return nodeStart(pair.key);
  }
  return nodeStart(parent);
}

interface Located {
  offset: number;
  exact: boolean;
}

/**
 * Where a zod path points: the node itself when it exists; a missing key points at the nearest parent that exists
 * (`exact: false`); an unknown key points at the key.
 */
export function locatePath(doc: Document, path: ReadonlyArray<string | number>, unknownKey = false): Located {
  if (unknownKey && path.length > 0) {
    const key = path[path.length - 1];
    const offset = keyOffset(doc, path.slice(0, -1), String(key));
    if (offset !== null) return { offset, exact: true };
  }
  for (let depth = path.length; depth >= 0; depth--) {
    const prefix = path.slice(0, depth);
    const node = prefix.length === 0 ? doc.contents : doc.getIn(prefix, true);
    const offset = nodeStart(node);
    if (offset !== null) {
      // a block value (a mapping or list): point at its key (the line of `salary_axis:`), not at its first entry
      if (depth > 0 && isNode(node) && !isScalar(node)) {
        const last = prefix[prefix.length - 1];
        const keyAt = typeof last === "string" ? keyOffset(doc, prefix.slice(0, -1), last) : null;
        if (keyAt !== null) return { offset: keyAt, exact: depth === path.length };
      }
      return { offset, exact: depth === path.length };
    }
  }
  return { offset: 0, exact: false };
}

function issueAt(doc: Document, lineCounter: LineCounter, source: IssueSource, path: ReadonlyArray<string | number>, message: string, unknownKey = false): TextIssue {
  const located = locatePath(doc, path, unknownKey);
  const { line, col } = lineCounter.linePos(located.offset);
  return { path: joinPath(path), message, line, col, exact: located.exact, source };
}

type ZodIssue = ZodError["issues"][number];

function zodPaths(issue: ZodIssue): { path: (string | number)[]; message: string; unknownKey: boolean }[] {
  const base = issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
  if (issue.code === "unrecognized_keys") return issue.keys.map((key) => ({ path: [...base, key], message: "unknown key", unknownKey: true }));
  return [{ path: base, message: issue.message, unknownKey: false }];
}

/** The first line of a yaml error message, without its trailing "at line X, column Y:". */
function yamlReason(message: string): string {
  return (message.split("\n")[0] ?? "invalid YAML").replace(/\s+at line \d+, column \d+:?\s*$/, "").trim();
}

export function validateConfigText<N extends ConfigName>(name: N, text: string, options: ValidateOptions = {}): ValidateResult<N> {
  const lineCounter = new LineCounter();
  const doc = parseConfigYamlDocument(text, { lineCounter });
  const issues: TextIssue[] = [];

  if (doc.errors.length > 0) {
    for (const error of doc.errors.slice(0, MAX_TEXT_ISSUES)) {
      const where = error.linePos?.[0];
      issues.push({ path: "", message: yamlReason(error.message), line: where?.line ?? 1, col: where?.col ?? 1, exact: true, source: "yaml" });
    }
    return { ok: false, issues };
  }

  // The text is saved as written (the loader migrates it when it reads), so the version must be there and not newer than the code.
  const current = currentConfigVersion(name);
  const version = documentConfigVersion(doc);
  const versionWritten = isMap(doc.contents) && doc.contents.has(CONFIG_VERSION_KEY);
  if (version === null) {
    issues.push(issueAt(doc, lineCounter, "version", [CONFIG_VERSION_KEY], "must be a whole number ≥ 1"));
  } else if (version > current) {
    issues.push(issueAt(doc, lineCounter, "version", [CONFIG_VERSION_KEY], `config_version ${version} is newer than this version of Job Radar supports (${current})`));
  } else if (!versionWritten && current > 1) {
    issues.push(issueAt(doc, lineCounter, "version", [], `config_version is missing; write the file's version (this version of Job Radar reads up to ${current})`));
  }
  if (issues.length > 0) return { ok: false, issues };

  // Validate a migrated copy; `doc` keeps pointing at the lines the user wrote.
  const migrated = parseConfigYamlDocument(text);
  try {
    migrateConfigDocument(name, migrated, "");
  } catch (error) {
    const reason = error instanceof ConfigError ? (error.issues[0]?.message ?? error.kind) : "the migration failed";
    return { ok: false, issues: [{ path: "", message: reason, line: 1, col: 1, exact: false, source: "schema" }] };
  }
  const place = (source: IssueSource, path: ReadonlyArray<string | number>, message: string, unknownKey = false): TextIssue => {
    const issue = issueAt(doc, lineCounter, source, path, message, unknownKey);
    if (issue.exact || version === current) return issue;
    return { ...issue, line: 1, col: 1, message: `${issue.path}: ${message}` };
  };

  // models.yaml is an overlay: clashes inside it are reported at the user's own paths, before the merged catalog is judged
  const resolved = resolveConfigDocument(name, migrated);
  if (resolved.errors.length > 0) {
    for (const error of resolved.errors.slice(0, MAX_TEXT_ISSUES)) issues.push(place("schema", error.path, error.message, error.message === "unknown key"));
    return { ok: false, issues };
  }
  const parsed = configRegistry[name].schema.safeParse(withoutConfigVersion(resolved.value));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      for (const where of zodPaths(issue)) {
        if (issues.length >= MAX_TEXT_ISSUES) break;
        issues.push(place("schema", where.path, where.message, where.unknownKey));
      }
    }
    return { ok: false, issues };
  }

  const value = parsed.data as ConfigValue<N>;
  const warnings: TextIssue[] = resolved.warnings.map((warning) => issueAt(doc, lineCounter, "catalog", warning.path, warning.message));
  const readOther = options.readOther ?? defaultReadOther;

  // cross-file: ai.yaml's models against the catalog, and (saving the catalog) the models ai.yaml uses against the new catalog
  const crossIssues: { path: string; message: string; severity: "error" | "warning"; file: ConfigName | null; where: (string | number)[] }[] = [];
  if (name === "ai") {
    const catalog = readOther("models");
    if (catalog === null) {
      crossIssues.push({ path: "", message: "models.yaml cannot be read, so the models cannot be checked", severity: "error", file: "models", where: [] });
    } else {
      for (const issue of checkAiAgainstCatalog(value as ConfigValue<"ai">, catalog)) crossIssues.push({ path: joinPath(issue.path), message: issue.message, severity: issue.severity, file: null, where: issue.path });
    }
  } else if (name === "models") {
    const ai = readOther("ai");
    if (ai !== null) {
      for (const issue of checkAiAgainstCatalog(ai, value as ConfigValue<"models">)) {
        if (issue.severity === "error") crossIssues.push({ path: joinPath(issue.path), message: `ai.yaml: ${issue.message}`, severity: "error", file: "ai", where: [] });
      }
    }
  }
  if (name === "interests") {
    for (const warning of [...interestsWarnings(value as ConfigValue<"interests">), ...interestsRawWarnings(withoutConfigVersion(configDocumentValue(name, migrated)))]) crossIssues.push({ path: joinPath(warning.path), message: warning.message, severity: "warning", file: null, where: warning.path });
  }
  for (const cross of crossIssues) {
    const located: TextIssue =
      cross.file === null
        ? place("catalog", cross.where, cross.message)
        : { path: cross.path, message: cross.message, line: 1, col: 1, exact: false, source: "catalog", file: cross.file };
    (cross.severity === "error" ? issues : warnings).push(located);
  }
  if (name === "interests" && options.interestsProbe) {
    const interests = value as ConfigValue<"interests">;
    for (const slow of slowInterestPatterns(interests, options.interestsProbe(interests.limits))) issues.push(place("schema", slow.path, SLOW_PATTERN_MESSAGE));
  }
  if (options.checkProtected === true) {
    for (const segments of protectedChanges(name, value)) issues.push(place("protected", segments, PROTECTED_KEY_MESSAGE));
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_TEXT_ISSUES) };
  return { ok: true, value, warnings };
}
