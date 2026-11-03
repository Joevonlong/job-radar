import type { ZodError } from "zod";

import { configErrorDigest } from "./error-digest";

/**
 * `version`: the file's `config_version` is newer than this code supports (a downgrade).
 * `stale`: the file changed on disk (or moved to another layer) since the editor read it.
 * `too_large`: the text is longer than `ui.yaml: config_editor.max_bytes`.
 * `protected`: the write would change a protected key (`protected-keys.ts`); those are edited by hand in the file.
 * `busy`: the config write lock could not be taken in time, or its session was lost before the commit.
 * `db_unavailable`: the config write lock lives in the database, and the database cannot be reached.
 */
export type ConfigErrorKind = "missing" | "read" | "yaml" | "schema" | "version" | "stale" | "too_large" | "protected" | "busy" | "db_unavailable";

export type ConfigWriteErrorKey = "dbUnavailable" | "busy" | "stale" | "protected";

/** Write refusals that callers can explain without exposing a path or an error message. */
export function configErrorKey(error: unknown): ConfigWriteErrorKey | null {
  if (!(error instanceof ConfigError)) return null;
  switch (error.kind) {
    case "db_unavailable": return "dbUnavailable";
    case "busy": case "stale": case "protected": return error.kind;
    default: return null;
  }
}

/** The layer a problem comes from: the user's file or the shipped default. */
export type ConfigErrorLayer = "user" | "shipped";

export interface ConfigIssue {
  /** Dotted field path, e.g. `cycles.weekend.cron`. Empty string = the document root. */
  path: string;
  message: string;
  /** For a merged value: the layer that holds the value at this path. */
  layer?: ConfigErrorLayer;
}

const MAX_ISSUES_IN_MESSAGE = 20;

const LAYER_LABEL: Record<ConfigErrorLayer, string> = { user: "user file", shipped: "shipped file" };

/**
 * Raised for any problem with a config file. Carries the file path and the
 * offending field paths; it never contains the file contents or field values.
 */
export class ConfigError extends Error {
  readonly digest: string;
  readonly configName: string;
  readonly filePath: string;
  readonly kind: ConfigErrorKind;
  readonly issues: readonly ConfigIssue[];
  /** Free text the message carries: for `busy`, the lock holder or `lock_lost`. */
  readonly detail: string | undefined;
  /** The layer the problem is in, when the error is about one layer (a read, the shipped file's version or syntax). */
  readonly layer: ConfigErrorLayer | undefined;

  constructor(params: {
    configName: string;
    filePath: string;
    kind: ConfigErrorKind;
    issues?: readonly ConfigIssue[];
    detail?: string;
    layer?: ConfigErrorLayer;
  }) {
    const issues = params.issues ?? [];
    super(formatMessage(params.configName, params.filePath, params.kind, issues, params.detail, params.layer));
    this.name = "ConfigError";
    this.digest = configErrorDigest(params.configName);
    this.configName = params.configName;
    this.filePath = params.filePath;
    this.kind = params.kind;
    this.issues = issues;
    this.detail = params.detail;
    this.layer = params.layer;
  }
}

function formatMessage(
  configName: string,
  filePath: string,
  kind: ConfigErrorKind,
  issues: readonly ConfigIssue[],
  detail: string | undefined,
  layer: ConfigErrorLayer | undefined,
): string {
  const head = {
    missing: `Config "${configName}" not found`,
    read: `Config "${configName}" could not be read`,
    yaml: `Config "${configName}" is not valid YAML`,
    schema: `Config "${configName}" failed validation`,
    version: `Config "${configName}" is from a newer version of Job Radar`,
    stale: `Config "${configName}" changed on disk since it was opened`,
    too_large: `Config "${configName}" text is too large`,
    protected: `Config "${configName}" has protected keys that can only be changed by editing the file by hand (or with JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1)`,
    busy: `Config "${configName}" is being written by another process`,
    db_unavailable: `Config "${configName}" cannot be saved: saving config needs the database (DATABASE_URL, or POSTGRES_* in .env)`,
  }[kind];
  const lines = [`${head}${layer ? ` in the ${LAYER_LABEL[layer]}` : ""} (${filePath})${detail ? `: ${detail}` : ""}`];
  for (const issue of issues.slice(0, MAX_ISSUES_IN_MESSAGE)) {
    lines.push(`  - ${issue.path === "" ? "(root)" : issue.path}: ${issue.message}${issue.layer ? ` [${LAYER_LABEL[issue.layer]}]` : ""}`);
  }
  if (issues.length > MAX_ISSUES_IN_MESSAGE) {
    lines.push(`  ... and ${issues.length - MAX_ISSUES_IN_MESSAGE} more`);
  }
  return lines.join("\n");
}

function joinPath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : String(segment)))
    .reduce((acc, seg) => (seg.startsWith("[") || acc === "" ? acc + seg : `${acc}.${seg}`), "");
}

/** Flatten zod issues to path/message pairs (one per unrecognized key). */
export function zodIssues(error: ZodError): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push({ path: joinPath([...issue.path, key]), message: "unknown key" });
      }
    } else {
      out.push({ path: joinPath(issue.path), message: issue.message });
    }
  }
  return out;
}

/** The first problem of a config error as one short line: "providers.mimo.models.0.price: API models need a price ..." (else the message's first line). */
export function firstConfigProblem(error: ConfigError): string {
  const first = error.issues[0];
  if (first) return `${first.path === "" ? "(root)" : first.path}: ${first.message}`;
  return error.message.split("\n")[0] ?? "unreadable";
}
