/** Import and export of the source registry: parse -> validate -> plan the change -> (the service) write. Pure. */
import { Document, parseDocument } from "yaml";
import { z } from "zod";

import { atsBoardsSchema, channelsSchema, ConfigError, migrateConfigDocument, withoutConfigVersion, type ChannelsConfig } from "@/lib/config";
import { changedPaths } from "@/lib/draft-diff";

import { boardEntryId, buildRegistryEntries } from "./entries";

export const IMPORT_FORMATS = ["yaml", "json"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
export const IMPORT_MODES = ["replace", "merge_boards"] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** What is wrong with an imported file, as a code the page translates (`sourcesRegistry.import.issues.<code>`). */
export const IMPORT_ISSUE_CODES = [
  "too_large",
  "empty",
  "invalid_json",
  "invalid_json_at",
  "invalid_yaml",
  "invalid_yaml_at",
  "expected_mapping",
  "expected_list",
  "cannot_read_current",
  "malformed_request",
  "missing_file",
  "required",
  "wrong_type",
  "too_small",
  "too_big",
  "invalid_value",
  "unknown_key",
  "bad_token",
  "bad_format",
  "duplicate_board",
  "eu_lever_only",
  "other",
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

export interface ImportIssue {
  /** Dotted field path; empty = the document. Never the file contents. */
  path: string;
  /** The English text (logs, API clients); the page shows `code` + `values` in the user's language. */
  message: string;
  code: ImportIssueCode;
  /** Numbers and short words for the translated message (`limit`, `line`, `col`, `expected`, ...). */
  values?: Record<string, string | number>;
  /** The company a board issue belongs to (`Wayve (greenhouse/wayve)`), so the user does not have to count list entries. */
  target?: string;
}

export interface ImportChange {
  group: "channel" | "board" | "other";
  /** A channel / board id, or a config path for `other`. */
  target: string;
  kind: "enabled" | "disabled" | "param" | "added" | "removed" | "changed";
  path?: string;
  from?: string;
  to?: string;
}

export interface ImportSummary {
  channelsEnabled: number;
  channelsDisabled: number;
  paramsChanged: number;
  boardsAdded: number;
  boardsRemoved: number;
  boardsChanged: number;
  otherChanged: number;
}

export type ImportNote = { key: "proxiesKept" } | { key: "ignoredKeys"; count: number } | { key: "repair" };

export type ImportPlan =
  | { ok: true; next: ChannelsConfig; changes: ImportChange[]; summary: ImportSummary; notes: ImportNote[] }
  | { ok: false; errors: ImportIssue[] };

const VALUE_LIMIT = 80;

function show(value: unknown): string {
  const text = value === undefined ? "(none)" : JSON.stringify(value);
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Size check and syntax check of an imported text; returns the parsed value (not yet validated). */
/**
 * An imported file of an older format (`config_version`) is brought up to the current one like sources.yaml on
 * load (the remote-location keys were renamed); `config_version` itself is not part of the values.
 */
function migrated(doc: Document): { ok: true; value: unknown } | { ok: false; errors: ImportIssue[] } {
  try {
    migrateConfigDocument("channels", doc, "import");
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, errors: [{ path: "config_version", code: "other", message: error.message.split("\n")[0] ?? "config_version" }] };
    throw error;
  }
  return { ok: true, value: withoutConfigVersion(doc.toJS()) };
}

export function parseImportText(text: string, format: ImportFormat, maxBytes: number): { ok: true; value: unknown } | { ok: false; errors: ImportIssue[] } {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) return { ok: false, errors: [{ path: "", code: "too_large", values: { limit: Math.round(maxBytes / 1024) }, message: `file too large (${bytes} bytes, limit ${maxBytes})` }] };
  if (text.trim() === "") return { ok: false, errors: [{ path: "", code: "empty", message: "empty" }] };
  if (format === "json") {
    try {
      const value = JSON.parse(text) as unknown;
      return typeof value === "object" && value !== null && !Array.isArray(value) ? migrated(new Document(value)) : { ok: true, value };
    } catch (error) {
      const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
      return { ok: false, errors: [position ? { path: "", code: "invalid_json_at", values: { position: Number(position) }, message: `invalid JSON near character ${position}` } : { path: "", code: "invalid_json", message: "invalid JSON" }] };
    }
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.slice(0, 5).map((error): ImportIssue => {
        const where = error.linePos?.[0];
        // the library's first line already ends in "at line X, column Y:": say the position once
        const reason = (error.message.split("\n")[0] ?? "invalid YAML").replace(/\s+at line \d+, column \d+:?\s*$/, "").trim();
        return where
          ? { path: "", code: "invalid_yaml_at", values: { line: where.line, col: where.col, reason }, message: `line ${where.line}, column ${where.col}: ${reason}` }
          : { path: "", code: "invalid_yaml", values: { reason }, message: reason };
      }),
    };
  }
  return migrated(doc);
}

const CREDENTIALS_IN_URL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s@/"'`]+@/gi;

/** Replace `user:password@` of every URL in a text with `***:***@` (the proxy list may carry credentials, C4). */
export function maskCredentialsInText(text: string): string {
  return text.replace(CREDENTIALS_IN_URL, "$1***:***@");
}

/** The config with the credentials of `jobspy.proxies` masked (for the JSON export). */
export function maskProxyCredentials(config: ChannelsConfig): ChannelsConfig {
  return { ...config, jobspy: { ...config.jobspy, proxies: config.jobspy.proxies.map((url) => maskCredentialsInText(url)) } };
}

function joinPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((segment) => (typeof segment === "number" ? `[${segment}]` : String(segment))).reduce((acc, seg) => (seg.startsWith("[") || acc === "" ? acc + seg : `${acc}.${seg}`), "");
}

const CUSTOM_CODES: Record<string, ImportIssueCode> = {
  "duplicate ats + token": "duplicate_board",
  "region eu only applies to lever boards": "eu_lever_only",
  "token must be a plain board slug": "bad_token",
};

const shortText = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 60) : null);

/** `Wayve (greenhouse/wayve)` for the entry `path` points into (`ats_boards[14].token`), looked up in `root`; null when the path is not a board entry. */
function boardTarget(root: unknown, path: string): string | undefined {
  const match = /^(\w+)\[(\d+)\]/.exec(path);
  const key = match?.[1];
  const index = Number(match?.[2]);
  if (!key || !isRecord(root)) return undefined;
  const list = root[key];
  if (!Array.isArray(list)) return undefined;
  if (key !== "ats_boards" && key !== "companies") return undefined;
  const entry: unknown = list[index];
  if (!isRecord(entry)) return `#${index + 1}`;
  const name = shortText(entry.name);
  const token = shortText(entry.token);
  const ats = shortText(entry.ats);
  const id = token ? (ats ? `${ats}/${token}` : token) : null;
  if (name && id) return `${name} (${id})`;
  return name ?? id ?? `#${index + 1}`;
}

function issueOf(issue: z.core.$ZodIssue, path: string, target: string | undefined): ImportIssue {
  const base = { path, ...(target ? { target } : {}) };
  const custom = CUSTOM_CODES[issue.message];
  if (custom) return { ...base, code: custom, message: issue.message };
  switch (issue.code) {
    case "invalid_type":
      return /received undefined/.test(issue.message)
        ? { ...base, code: "required", message: issue.message }
        : { ...base, code: "wrong_type", values: { expected: String(issue.expected) }, message: issue.message };
    case "too_small":
    case "too_big": {
      const limit = issue.code === "too_small" ? issue.minimum : issue.maximum;
      return { ...base, code: issue.code, values: { origin: String(issue.origin), limit: Number(limit), inclusive: issue.inclusive ? "true" : "false" }, message: issue.message };
    }
    case "invalid_value":
      return { ...base, code: "invalid_value", values: { options: issue.values.slice(0, 8).map(String).join(", ") }, message: issue.message };
    case "invalid_format":
      return { ...base, code: "bad_format", message: issue.message };
    default:
      return { ...base, code: "other", values: { message: issue.message }, message: issue.message };
  }
}

/** The zod issues of an import as translatable issues; `prefix` is the list key of a merge import, `lookup` the value the paths point into (to name the company). */
function toIssues(error: z.ZodError, lookup: unknown, prefix = ""): ImportIssue[] {
  const out: ImportIssue[] = [];
  const at = (path: string): string => (prefix === "" ? path : path === "" ? prefix : path.startsWith("[") ? `${prefix}${path}` : `${prefix}.${path}`);
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const path = at(joinPath([...issue.path, key]));
        const target = boardTarget(lookup, path);
        out.push({ path, code: "unknown_key", message: "unknown key", ...(target ? { target } : {}) });
      }
      continue;
    }
    const path = at(joinPath(issue.path));
    out.push(issueOf(issue, path, boardTarget(lookup, path)));
  }
  return out;
}

const boardKey = (b: { ats: string; token: string }): string => `${b.ats}:${b.token.toLowerCase()}`;

type Board = ChannelsConfig["ats_boards"][number];

/** The new `ats_boards`: file entries update boards with the same ats + token (name, enabled, region) or are appended; nothing is deleted. */
function mergeBoards(current: readonly Board[], incoming: readonly Board[]): Board[] {
  const next = current.map((b) => ({ ...b }));
  for (const board of incoming) {
    const index = next.findIndex((b) => boardKey(b) === boardKey(board));
    if (index === -1) {
      next.push({ ...board });
      continue;
    }
    const existing = next[index];
    if (!existing) continue;
    const merged: Board = { ...existing, name: board.name, enabled: board.enabled };
    if (board.region !== undefined) merged.region = board.region;
    next[index] = merged;
  }
  return next;
}

/** Everything of a config that is not a channel block or a board: switches of the file's own, limits, the cascade, the registry block. */
function otherSettings(config: ChannelsConfig): Record<string, unknown> {
  const rest: Record<string, unknown> = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  delete rest.ats_boards;
  delete rest.sources;
  const linkedin = rest.linkedin;
  if (isRecord(linkedin)) for (const key of ["brightdata", "apify", "session", "guest"]) delete linkedin[key];
  const jobspy = rest.jobspy;
  if (isRecord(jobspy)) delete jobspy.proxies;
  return rest;
}

/** What changes when `next` replaces `current`, as a flat list and counts. */
export function diffConfigs(current: ChannelsConfig, next: ChannelsConfig): { changes: ImportChange[]; summary: ImportSummary } {
  const changes: ImportChange[] = [];
  const summary: ImportSummary = { channelsEnabled: 0, channelsDisabled: 0, paramsChanged: 0, boardsAdded: 0, boardsRemoved: 0, boardsChanged: 0, otherChanged: 0 };

  const before = new Map(buildRegistryEntries(current).map((e) => [e.id, e]));
  const after = new Map(buildRegistryEntries(next).map((e) => [e.id, e]));

  for (const [id, entry] of after) {
    const old = before.get(id);
    if (!old || entry.type !== "channel") continue;
    if (old.enabled !== entry.enabled) {
      changes.push({ group: "channel", target: id, kind: entry.enabled ? "enabled" : "disabled" });
      summary[entry.enabled ? "channelsEnabled" : "channelsDisabled"] += 1;
    }
    if (id === "linkedin-session:recommended") continue; // its block is the session channel's block: reported there
    const enabledKey = entry.enabledPath[entry.enabledPath.length - 1];
    for (const path of changedPaths(entry.params, old.params)) {
      if (path === enabledKey) continue;
      const read = (params: unknown): unknown => path.split(".").reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), params);
      changes.push({ group: "channel", target: id, kind: "param", path, from: show(read(old.params)), to: show(read(entry.params)) });
      summary.paramsChanged += 1;
    }
  }

  const oldBoards = new Map(current.ats_boards.map((b) => [boardEntryId(b.ats, b.token), b]));
  const newBoards = new Map(next.ats_boards.map((b) => [boardEntryId(b.ats, b.token), b]));
  for (const [id, board] of newBoards) {
    const old = oldBoards.get(id);
    if (!old) {
      changes.push({ group: "board", target: id, kind: "added", to: show(board.name) });
      summary.boardsAdded += 1;
      continue;
    }
    const fields = changedPaths({ name: board.name, enabled: board.enabled, region: board.region ?? "global" }, { name: old.name, enabled: old.enabled, region: old.region ?? "global" });
    for (const path of fields) {
      const pick = (b: Board): unknown => (path === "region" ? (b.region ?? "global") : path === "name" ? b.name : b.enabled);
      changes.push({ group: "board", target: id, kind: "changed", path, from: show(pick(old)), to: show(pick(board)) });
    }
    if (fields.length > 0) summary.boardsChanged += 1;
  }
  for (const [id, board] of oldBoards) {
    if (newBoards.has(id)) continue;
    changes.push({ group: "board", target: id, kind: "removed", from: show(board.name) });
    summary.boardsRemoved += 1;
  }

  const oldOther = otherSettings(current);
  const newOther = otherSettings(next);
  for (const path of changedPaths(newOther, oldOther)) {
    const read = (value: unknown): unknown => path.split(".").reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), value);
    const a = read(oldOther);
    const b = read(newOther);
    const isList = Array.isArray(a) || Array.isArray(b);
    changes.push({ group: "other", target: path, kind: "param", path, ...(isList ? {} : { from: show(a), to: show(b) }) });
    summary.otherChanged += 1;
  }
  return { changes, summary };
}

const mergeInputSchema = z.union([z.object({ ats_boards: z.unknown() }).loose(), z.object({ companies: z.unknown() }).loose()]);

/** Validate `imported` for `mode` and work out the new config and what it changes in `current`. */
export function planImport(current: ChannelsConfig, imported: unknown, mode: ImportMode): ImportPlan {
  return plan({ current, proxies: current.jobspy.proxies }, imported, mode);
}

/**
 * The file on disk cannot be read: a complete file replaces it (nothing to diff against, so no change list). The proxy list
 * is taken from `salvagedProxies` (read leniently from the broken file), so repairing the file does not drop it.
 */
export function planRepairImport(imported: unknown, salvagedProxies: readonly string[]): ImportPlan {
  return plan({ current: null, proxies: salvagedProxies }, imported, "replace");
}

function plan(base: { current: ChannelsConfig | null; proxies: readonly string[] }, imported: unknown, mode: ImportMode): ImportPlan {
  const { current } = base;
  const notes: ImportNote[] = [];
  let candidate: unknown;

  if (mode === "replace") {
    if (!isRecord(imported)) return { ok: false, errors: [{ path: "", code: "expected_mapping", message: "expected a mapping (a complete sources.yaml)" }] };
    const copy: Record<string, unknown> = { ...imported };
    if (isRecord(copy.jobspy)) copy.jobspy = { ...copy.jobspy, proxies: [...base.proxies] };
    candidate = copy;
    notes.push(current === null ? { key: "repair" } : { key: "proxiesKept" });
  } else {
    if (current === null) return { ok: false, errors: [{ path: "", code: "cannot_read_current", message: "sources.yaml cannot be read: use a complete file (replace) to repair it" }] };
    const shape = mergeInputSchema.safeParse(imported);
    if (!shape.success || !isRecord(imported)) {
      return { ok: false, errors: [{ path: "", code: "expected_list", message: "expected an ats_boards list (or the companies list of the old companies.yaml)" }] };
    }
    const listKey = "ats_boards" in imported ? "ats_boards" : "companies";
    const list = atsBoardsSchema.safeParse(imported[listKey]);
    if (!list.success) return { ok: false, errors: toIssues(list.error, imported, listKey) };
    const ignored = Object.keys(imported).filter((key) => key !== listKey).length;
    if (ignored > 0) notes.push({ key: "ignoredKeys", count: ignored });
    candidate = { ...current, ats_boards: mergeBoards(current.ats_boards, list.data) };
  }

  const parsed = channelsSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: toIssues(parsed.error, candidate) };
  const next: ChannelsConfig = { ...parsed.data, jobspy: { ...parsed.data.jobspy, proxies: [...base.proxies] } };
  if (current === null) {
    return { ok: true, next, changes: [], summary: { channelsEnabled: 0, channelsDisabled: 0, paramsChanged: 0, boardsAdded: 0, boardsRemoved: 0, boardsChanged: 0, otherChanged: 0 }, notes };
  }
  const { changes, summary } = diffConfigs(current, next);
  return { ok: true, next, changes, summary, notes };
}
